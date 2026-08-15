import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppConfig } from '@/shared/config/index.js';
import {
  commonErrorResponses,
  conflictResponse,
  isoDateSchema,
  paginationMetaSchema,
  paginationQuerySchema,
  timeOfDaySchema,
  uuidSchema,
} from '@/shared/http/schemas.js';
import { requireTherapistId } from '@/modules/auth/domain/authorization.js';
import { getPrincipal, requireRole } from '@/modules/auth/presentation/authenticate.js';
import type { ScheduleService } from '@/modules/scheduling/application/schedule-service.js';
import type { TherapistDirectory } from '@/modules/scheduling/application/ports.js';

const scheduleRuleSchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7).describe('ISO weekday: 1 = Monday through 7 = Sunday'),
  startTime: timeOfDaySchema,
  endTime: timeOfDaySchema,
});

const scheduleViewSchema = z.object({
  rules: z.array(
    scheduleRuleSchema.extend({
      effectiveFrom: isoDateSchema,
      effectiveUntil: isoDateSchema.nullable().describe('null means still in effect'),
    }),
  ),
  timezone: z.string().describe('Timezone the wall-clock times are expressed in'),
  slotGranularityMinutes: z.number().int().describe('Length of a bookable slot'),
});

const replaceScheduleBodySchema = z
  .object({
    // Capped: a week has 7 days and nobody needs 50 blocks per day. An unbounded array here
    // would be a cheap way to make schedule expansion expensive.
    rules: z
      .array(scheduleRuleSchema)
      .max(50)
      .describe('The complete weekly pattern. An empty array means no availability.'),
    effectiveFrom: isoDateSchema
      .optional()
      .describe('Date the new pattern takes effect. Defaults to today. Cannot be in the past.'),
  })
  .describe('Replaces the entire weekly schedule from effectiveFrom onward');

export interface ScheduleRouteDependencies {
  readonly config: AppConfig;
  readonly scheduleService: ScheduleService;
  readonly therapistDirectory: TherapistDirectory;
}

export const registerScheduleRoutes = (
  dependencies: ScheduleRouteDependencies,
): FastifyPluginAsyncZod => {
  const { config, scheduleService, therapistDirectory } = dependencies;

  return async (app) => {
    app.get(
      '/therapists/me/schedule',
      {
        preHandler: [app.authenticate, requireRole('THERAPIST')],
        schema: {
          tags: ['Schedule'],
          summary: "Read the authenticated therapist's weekly availability",
          security: [{ bearerAuth: [] }],
          response: {
            200: scheduleViewSchema,
            ...commonErrorResponses,
          },
        },
      },
      async (request, reply) => {
        // `/me` rather than `/:therapistId`: there is no client-supplied id that could be
        // swapped for someone else's.
        const therapistId = requireTherapistId(getPrincipal(request));
        return reply.status(200).send(await scheduleService.getSchedule(therapistId));
      },
    );

    app.put(
      '/therapists/me/schedule',
      {
        preHandler: [app.authenticate, requireRole('THERAPIST')],
        config: {
          rateLimit: {
            max: config.RATE_LIMIT_MUTATION_MAX,
            timeWindow: config.RATE_LIMIT_MUTATION_WINDOW_SECONDS * 1000,
          },
        },
        schema: {
          tags: ['Schedule'],
          summary: 'Replace the weekly availability pattern',
          description:
            'Existing appointments are never modified. Availability that is removed simply ' +
            'stops being offered for new bookings; already-booked appointments remain and must ' +
            'be cancelled explicitly if the therapist wants to free the time. Superseded rules ' +
            'are closed with an effective-until date rather than deleted, so historical ' +
            'availability stays auditable.',
          security: [{ bearerAuth: [] }],
          body: replaceScheduleBodySchema,
          response: {
            200: scheduleViewSchema.describe('The updated schedule'),
            ...commonErrorResponses,
            ...conflictResponse,
          },
        },
      },
      async (request, reply) => {
        const therapistId = requireTherapistId(getPrincipal(request));

        const view = await scheduleService.replaceSchedule({
          therapistId,
          rules: request.body.rules,
          ...(request.body.effectiveFrom === undefined
            ? {}
            : { effectiveFrom: request.body.effectiveFrom }),
          requestId: request.requestId,
        });

        return reply.status(200).send(view);
      },
    );

    app.get(
      '/therapists',
      {
        preHandler: app.authenticate,
        schema: {
          tags: ['Therapists'],
          summary: 'List therapists available for booking',
          description:
            'The entry point to every booking flow: a client needs a therapist id before it can ' +
            'ask for availability. Returns professional profile fields only — no contact details, ' +
            'which a patient does not need in order to book.',
          security: [{ bearerAuth: [] }],
          querystring: paginationQuerySchema,
          response: {
            200: z.object({
              therapists: z.array(
                z.object({
                  id: uuidSchema,
                  displayName: z.string(),
                  specialization: z.string().nullable(),
                }),
              ),
              pagination: paginationMetaSchema,
            }),
            ...commonErrorResponses,
          },
        },
      },
      async (request, reply) => {
        const { limit, offset } = request.query;
        const result = await therapistDirectory.list({ limit, offset });

        return reply.status(200).send({
          therapists: result.therapists,
          pagination: {
            limit,
            offset,
            total: result.total,
            hasMore: offset + result.therapists.length < result.total,
          },
        });
      },
    );
  };
};
