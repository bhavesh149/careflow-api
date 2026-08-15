import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  commonErrorResponses,
  isoDateSchema,
  notFoundResponse,
  uuidSchema,
} from '@/shared/http/schemas.js';
import type { AvailabilityService } from '@/modules/availability/application/availability-service.js';

const availabilityResponseSchema = z.object({
  therapistId: uuidSchema,
  timezone: z.string(),
  slotGranularityMinutes: z.number().int(),
  from: isoDateSchema,
  to: isoDateSchema,
  serverTime: z
    .string()
    .describe('Authoritative server time; use this rather than the device clock for countdowns'),
  slots: z.array(
    z.object({
      startTime: z.string().describe('Slot start (ISO-8601, UTC)'),
      endTime: z.string().describe('Slot end, exclusive'),
    }),
  ),
});

export interface AvailabilityRouteDependencies {
  readonly availabilityService: AvailabilityService;
}

export const registerAvailabilityRoutes = (
  dependencies: AvailabilityRouteDependencies,
): FastifyPluginAsyncZod => {
  const { availabilityService } = dependencies;

  return async (app) => {
    app.get(
      '/therapists/:therapistId/availability',
      {
        // Authenticated: availability reveals a therapist's working pattern and, by omission,
        // when they are booked. That is not public information.
        preHandler: app.authenticate,
        schema: {
          tags: ['Availability'],
          summary: 'Bookable slots for a therapist over a date range',
          description:
            'Slots are derived from the therapist schedule at request time, never pre-generated. ' +
            'Slots already booked or currently held by another patient are excluded, as are slots ' +
            'in the past. A slot returned here is not reserved: create a hold to claim it.',
          security: [{ bearerAuth: [] }],
          params: z.object({ therapistId: uuidSchema }),
          querystring: z.object({
            from: isoDateSchema.describe('First date to include (inclusive)'),
            to: isoDateSchema.describe('Last date to include (inclusive)'),
          }),
          response: {
            200: availabilityResponseSchema,
            ...commonErrorResponses,
            ...notFoundResponse,
          },
        },
      },
      async (request, reply) => {
        const result = await availabilityService.getAvailability({
          therapistId: request.params.therapistId,
          from: request.query.from,
          to: request.query.to,
        });

        return reply.status(200).send(result);
      },
    );
  };
};
