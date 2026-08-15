import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppConfig } from '@/shared/config/index.js';
import { authenticationRequired } from '@/shared/errors/app-error.js';
import { commonErrorResponses, errorResponseSchema } from '@/shared/http/schemas.js';
import { Metric, type MetricsRegistry } from '@/shared/observability/index.js';
import type { AuthService, LoginResult } from '@/modules/auth/application/auth-service.js';
import { getPrincipal } from '@/modules/auth/presentation/authenticate.js';

/**
 * Auth endpoints.
 *
 * Token placement, which is the security-relevant decision here:
 *
 *   Access token  -> response body, held in memory by the SPA. Short-lived (15 min).
 *   Refresh token -> httpOnly, Secure, SameSite cookie scoped to /v1/auth.
 *
 * Rationale: the refresh token is the long-lived credential, so it must be unreadable by
 * JavaScript — an XSS bug should not yield persistent account access. It therefore lives in an
 * httpOnly cookie. The access token cannot be in a cookie, because then every request would
 * carry it automatically and the API would need CSRF defences; sending it in an
 * Authorization header means a cross-site form post cannot authenticate at all.
 */

const REFRESH_COOKIE_NAME = 'careflow_refresh';
// Scoped so the cookie is not attached to booking traffic. It is only ever needed here, and a
// credential that travels on every request is a credential with more chances to leak.
const REFRESH_COOKIE_PATH = '/v1/auth';

const loginBodySchema = z
  .object({
    email: z.string().email().max(320).describe('Account email address'),
    password: z.string().min(1).max(200).describe('Account password'),
  })
  .describe('Login credentials');

const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(['PATIENT', 'THERAPIST']),
  fullName: z.string(),
  therapistId: z.string().uuid().optional().describe('Present only for therapist accounts'),
});

const sessionResponseSchema = z.object({
  accessToken: z.string().describe('Bearer token for the Authorization header'),
  expiresAt: z.string().describe('Access token expiry (ISO-8601)'),
  expiresInSeconds: z.number().int().describe('Seconds until the access token expires'),
  user: userSchema,
});

export interface AuthRouteDependencies {
  readonly config: AppConfig;
  readonly authService: AuthService;
  readonly metrics: MetricsRegistry;
}

export const registerAuthRoutes = (dependencies: AuthRouteDependencies): FastifyPluginAsyncZod => {
  const { config, authService, metrics } = dependencies;

  const cookieOptions = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAME_SITE,
    path: REFRESH_COOKIE_PATH,
    signed: false,
    ...(config.COOKIE_DOMAIN.length > 0 ? { domain: config.COOKIE_DOMAIN } : {}),
  } as const;

  const toSessionResponse = (result: LoginResult) => ({
    accessToken: result.accessToken,
    expiresAt: result.accessTokenExpiresAt.toISOString(),
    expiresInSeconds: Math.max(
      0,
      Math.floor((result.accessTokenExpiresAt.getTime() - Date.now()) / 1000),
    ),
    user: {
      id: result.user.id,
      email: result.user.email,
      role: result.user.role,
      fullName: result.user.fullName,
      ...(result.user.therapistId === undefined ? {} : { therapistId: result.user.therapistId }),
    },
  });

  return async (app) => {
    app.post(
      '/login',
      {
        // Strict, separate limit: login is the endpoint an attacker brute-forces, and the
        // global limit is far too generous to stop credential stuffing.
        config: {
          rateLimit: {
            max: config.RATE_LIMIT_LOGIN_MAX,
            timeWindow: config.RATE_LIMIT_LOGIN_WINDOW_SECONDS * 1000,
          },
        },
        schema: {
          tags: ['Auth'],
          summary: 'Authenticate and start a session',
          description:
            'Returns a short-lived access token in the body and sets a rotating refresh ' +
            'token as an httpOnly cookie. Rate limited per IP.',
          body: loginBodySchema,
          response: {
            200: sessionResponseSchema.describe('Session established'),
            400: errorResponseSchema,
            401: errorResponseSchema.describe('Invalid credentials'),
            429: errorResponseSchema.describe('Too many login attempts'),
            500: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        try {
          const result = await authService.login(request.body.email, request.body.password);

          metrics.increment(Metric.LOGIN_ATTEMPTS, { outcome: 'success' });
          reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, {
            ...cookieOptions,
            expires: result.refreshTokenExpiresAt,
          });

          return reply.status(200).send(toSessionResponse(result));
        } catch (error) {
          metrics.increment(Metric.LOGIN_ATTEMPTS, { outcome: 'failure' });
          throw error;
        }
      },
    );

    app.post(
      '/refresh',
      {
        config: {
          rateLimit: {
            max: config.RATE_LIMIT_MUTATION_MAX,
            timeWindow: config.RATE_LIMIT_MUTATION_WINDOW_SECONDS * 1000,
          },
        },
        schema: {
          tags: ['Auth'],
          summary: 'Exchange the refresh cookie for a new access token',
          description:
            'Single-use: the presented refresh token is revoked and replaced. Replaying an ' +
            'already-rotated token is treated as theft and revokes the entire token family.',
          response: {
            200: sessionResponseSchema.describe('Session refreshed'),
            401: errorResponseSchema.describe('Missing, expired or already-used refresh token'),
            429: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const presented = request.cookies[REFRESH_COOKIE_NAME];

        if (presented === undefined) {
          throw authenticationRequired('A refresh token cookie is required.');
        }

        const result = await authService.refresh(presented);

        reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, {
          ...cookieOptions,
          expires: result.refreshTokenExpiresAt,
        });

        return reply.status(200).send(toSessionResponse(result));
      },
    );

    app.post(
      '/logout',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Revoke the current session',
          description:
            'Revokes every refresh token in the presented token family and clears the cookie. ' +
            'Always succeeds, so a client can reliably reach a signed-out state.',
          response: {
            204: z.null().describe('Session revoked'),
            500: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        await authService.logout(request.cookies[REFRESH_COOKIE_NAME]);

        // Clearing must use the same path/domain the cookie was set with, or the browser
        // keeps the original and the user stays logged in.
        reply.clearCookie(REFRESH_COOKIE_NAME, cookieOptions);
        return reply.status(204).send(null);
      },
    );
  };
};

/**
 * `GET /v1/me` — registered at the API root rather than under `/v1/auth`, because it answers
 * "who am I" about the current session, which clients call on every page load. It is a separate
 * plugin only so the path can sit outside the `/auth` prefix.
 */
export const registerIdentityRoutes = (
  dependencies: AuthRouteDependencies,
): FastifyPluginAsyncZod => {
  const { authService } = dependencies;

  return async (app) => {
    app.get(
      '/me',
      {
        preHandler: app.authenticate,
        schema: {
          tags: ['Auth'],
          summary: 'Current authenticated user',
          description:
            'Resolved from the access token and re-read from the database, so an account ' +
            'disabled after the token was issued is rejected here rather than trusted until expiry.',
          security: [{ bearerAuth: [] }],
          response: {
            200: userSchema.describe('The authenticated account'),
            ...commonErrorResponses,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);
        const user = await authService.getCurrentUser(principal.userId);

        return reply.status(200).send({
          id: user.id,
          email: user.email,
          role: user.role,
          fullName: user.fullName,
          ...(user.therapistId === undefined ? {} : { therapistId: user.therapistId }),
        });
      },
    );
  };
};
