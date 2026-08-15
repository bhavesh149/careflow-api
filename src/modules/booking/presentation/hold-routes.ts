import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppConfig } from '@/shared/config/index.js';
import {
  commonErrorResponses,
  conflictResponse,
  isoDateTimeSchema,
  notFoundResponse,
  uuidSchema,
} from '@/shared/http/schemas.js';
import { getPrincipal, requireRole } from '@/modules/auth/presentation/authenticate.js';
import type { HoldService } from '@/modules/booking/application/hold-service.js';

const holdViewSchema = z.object({
  id: uuidSchema,
  therapistId: uuidSchema,
  startTime: z.string(),
  endTime: z.string(),
  expiresAt: z.string().describe('Authoritative expiry, computed by the database'),
  serverTime: z.string().describe('Server time when this response was produced'),
  expiresInSeconds: z.number().int().describe('Seconds remaining; derived from the server clock'),
});

const createHoldBodySchema = z.object({
  therapistId: uuidSchema,
  startTime: isoDateTimeSchema.describe('Slot start. Must match an offered slot exactly.'),
});

export interface HoldRouteDependencies {
  readonly config: AppConfig;
  readonly holdService: HoldService;
}

export const registerHoldRoutes = (dependencies: HoldRouteDependencies): FastifyPluginAsyncZod => {
  const { config, holdService } = dependencies;

  return async (app) => {
    // Full paths rather than a registration prefix plus '/': a prefixed root route is published
    // in the OpenAPI document as `/v1/holds/`, and the contract should read exactly as specified.
    app.post(
      '/holds',
      {
        preHandler: [app.authenticate, requireRole('PATIENT')],
        config: {
          // Tighter than the global limit: holds make a slot unavailable to everyone else, so
          // rapid-fire hold creation is a denial-of-service against other patients.
          rateLimit: {
            max: config.RATE_LIMIT_MUTATION_MAX,
            timeWindow: config.RATE_LIMIT_MUTATION_WINDOW_SECONDS * 1000,
          },
        },
        schema: {
          tags: ['Holds'],
          summary: 'Hold a slot temporarily while the patient confirms',
          description:
            `Reserves the slot for ${config.HOLD_TTL_SECONDS} seconds so two patients cannot ` +
            'complete a booking for the same time. Expiry is enforced by the database, and both ' +
            '`expiresAt` and `serverTime` are returned so the client can count down against the ' +
            `server clock. A patient may hold at most ${config.MAX_ACTIVE_HOLDS_PER_PATIENT} ` +
            'slots at once. Returns 409 SLOT_ALREADY_HELD if another patient won the race.',
          security: [{ bearerAuth: [] }],
          body: createHoldBodySchema,
          response: {
            201: holdViewSchema.describe('Hold created'),
            ...commonErrorResponses,
            ...notFoundResponse,
            ...conflictResponse,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);

        const hold = await holdService.createHold({
          patientId: principal.userId,
          therapistId: request.body.therapistId,
          startTime: new Date(request.body.startTime),
          requestId: request.requestId,
        });

        return reply.status(201).send(hold);
      },
    );

    app.get(
      '/holds/active',
      {
        preHandler: [app.authenticate, requireRole('PATIENT')],
        schema: {
          tags: ['Holds'],
          summary: "The patient's currently active holds",
          description:
            'Lets a client resume after a page refresh: the hold lives in the database, not in ' +
            'browser state, so reloading recovers it with the correct remaining time.',
          security: [{ bearerAuth: [] }],
          response: {
            200: z.object({ holds: z.array(holdViewSchema) }),
            ...commonErrorResponses,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);
        const holds = await holdService.listActiveHolds(principal.userId);
        return reply.status(200).send({ holds });
      },
    );

    app.delete(
      '/holds/:holdId',
      {
        preHandler: [app.authenticate, requireRole('PATIENT')],
        schema: {
          tags: ['Holds'],
          summary: 'Release a hold early',
          description:
            'Frees the slot immediately rather than waiting for expiry. Releasing a hold that ' +
            "has already lapsed succeeds, because the caller's intent is already satisfied.",
          security: [{ bearerAuth: [] }],
          params: z.object({ holdId: uuidSchema }),
          response: {
            204: z.null().describe('Hold released'),
            ...commonErrorResponses,
            ...notFoundResponse,
            ...conflictResponse,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);

        await holdService.releaseHold({
          holdId: request.params.holdId,
          patientId: principal.userId,
        });

        return reply.status(204).send(null);
      },
    );
  };
};
