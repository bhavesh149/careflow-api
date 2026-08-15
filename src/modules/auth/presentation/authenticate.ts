import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AppConfig } from '@/shared/config/index.js';
import { authenticationRequired, forbidden } from '@/shared/errors/app-error.js';
import { verifyAccessToken } from '@/shared/security/index.js';
import type { UserRole } from '@/shared/database/schema.js';
import type { Principal } from '@/shared/http/request-context.js';

/**
 * Authentication and role guards, as composable preHandler hooks.
 *
 * The access token is read from the Authorization header only, never from a cookie. That
 * choice is what makes the API immune to CSRF without any anti-forgery token: a browser
 * attaches cookies to cross-site requests automatically, but it will never attach an
 * Authorization header on an attacker's behalf. The refresh cookie is the one exception, and
 * it is scoped to a single endpoint (`/v1/auth/refresh`) with SameSite protection.
 */

const extractBearerToken = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token.length === 0) {
    return undefined;
  }

  return token;
};

export const createAuthenticateHook = (config: AppConfig): preHandlerAsyncHookHandler => {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = extractBearerToken(request);

    if (token === undefined) {
      throw authenticationRequired('A bearer access token is required.');
    }

    const claims = await verifyAccessToken(config, token);

    const principal: Principal = {
      userId: claims.sub,
      role: claims.role,
      sessionId: claims.sid,
      ...(claims.tid === undefined ? {} : { therapistId: claims.tid }),
    };

    request.principal = principal;

    // Attach identity to every subsequent log line for this request. `actorId` is an opaque
    // UUID, which is safe to log; the email and name deliberately are not.
    request.log = request.log.child({ actorId: principal.userId, role: principal.role });
  };
};

/**
 * Coarse role gate for a route. Object-level ownership is still checked inside the use case:
 * this only answers "could a caller of this role ever be allowed here".
 */
export const requireRole = (...roles: readonly UserRole[]): preHandlerAsyncHookHandler => {
  return async (request: FastifyRequest): Promise<void> => {
    const principal = request.principal;

    if (!principal) {
      throw authenticationRequired();
    }

    if (!roles.includes(principal.role)) {
      throw forbidden(
        roles.length === 1 && roles[0] === 'PATIENT'
          ? 'This action is only available to patients.'
          : 'This action is only available to therapists.',
      );
    }
  };
};

/** Narrows `request.principal` for handlers that run behind the authenticate hook. */
export const getPrincipal = (request: FastifyRequest): Principal => {
  const principal = request.principal;

  if (!principal) {
    // Reaching here means a route was registered without the authenticate hook.
    throw authenticationRequired();
  }

  return principal;
};
