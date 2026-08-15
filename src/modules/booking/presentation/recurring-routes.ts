import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppConfig } from '@/shared/config/index.js';
import { idempotencyKeyRequired } from '@/shared/errors/domain-errors.js';
import {
  commonErrorResponses,
  conflictResponse,
  idempotencyHeaderSchema,
  idempotencyResponses,
  isoDateTimeSchema,
  notFoundResponse,
  uuidSchema,
} from '@/shared/http/schemas.js';
import type { Actor } from '@/modules/auth/domain/authorization.js';
import { getPrincipal, requireRole } from '@/modules/auth/presentation/authenticate.js';
import type { RecurringSeriesService } from '@/modules/booking/application/recurring-series-service.js';
import type { BookingService } from '@/modules/booking/application/booking-service.js';

const appointmentSchema = z.object({
  id: uuidSchema,
  therapistId: uuidSchema,
  therapistName: z.string(),
  patientId: uuidSchema,
  patientName: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  status: z.enum(['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED']),
  seriesId: uuidSchema.nullable(),
  occurrenceIndex: z.number().int().nullable(),
  createdAt: z.string(),
});

const seriesSchema = z.object({
  id: uuidSchema,
  therapistId: uuidSchema,
  patientId: uuidSchema,
  frequency: z.enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']),
  occurrences: z.number().int(),
  status: z.enum(['ACTIVE', 'CANCELLED']),
  createdAt: z.string(),
  appointments: z.array(appointmentSchema),
  truncated: z
    .boolean()
    .optional()
    .describe('True when fewer occurrences were created than requested'),
  truncationReason: z.string().optional(),
  clampedOccurrences: z
    .array(z.string())
    .optional()
    .describe('Monthly occurrences moved to the last valid day of a shorter month'),
});

const createSeriesBodySchema = z.object({
  therapistId: uuidSchema,
  startTime: isoDateTimeSchema.describe('First occurrence; must match an offered slot'),
  frequency: z.enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']),
  occurrences: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe('Requested occurrence count, including the first. Capped by the booking horizon.'),
});

const requireIdempotencyKey = (headers: Record<string, unknown>): string => {
  const value = headers['idempotency-key'];

  if (typeof value !== 'string' || value.trim().length < 16) {
    throw idempotencyKeyRequired();
  }

  return value.trim();
};

export interface RecurringRouteDependencies {
  readonly config: AppConfig;
  readonly recurringSeriesService: RecurringSeriesService;
  /** Single-occurrence cancellation is the ordinary appointment path, reused under this URL. */
  readonly bookingService: BookingService;
}

export const registerRecurringRoutes = (
  dependencies: RecurringRouteDependencies,
): FastifyPluginAsyncZod => {
  const { config, recurringSeriesService, bookingService } = dependencies;

  const mutationRateLimit = {
    rateLimit: {
      max: config.RATE_LIMIT_MUTATION_MAX,
      timeWindow: config.RATE_LIMIT_MUTATION_WINDOW_SECONDS * 1000,
    },
  };

  const toActor = (principal: {
    userId: string;
    role: 'PATIENT' | 'THERAPIST';
    therapistId?: string;
  }): Actor => ({
    userId: principal.userId,
    role: principal.role,
    ...(principal.therapistId === undefined ? {} : { therapistId: principal.therapistId }),
  });

  return async (app) => {
    app.post(
      '/recurring-series',
      {
        preHandler: [app.authenticate, requireRole('PATIENT')],
        config: mutationRateLimit,
        schema: {
          tags: ['Recurring'],
          summary: 'Create a recurring series',
          description:
            'All-or-nothing: if any occurrence conflicts, nothing is booked and the 409 response ' +
            'lists every conflicting occurrence with a reason, so the client can offer an ' +
            'alternative. Validation and insertion run under a per-therapist lock, so two ' +
            'concurrent series for the same therapist cannot interleave and leave a partial ' +
            `series. Generation is bounded to ${config.RECURRENCE_MAX_OCCURRENCES} occurrences ` +
            `or ${config.RECURRENCE_MAX_HORIZON_DAYS} days, whichever comes first. Monthly ` +
            'series requested on a day that some months lack (the 31st) are clamped to the last ' +
            'valid day of those months, and the clamped dates are reported in the response.',
          security: [{ bearerAuth: [] }],
          headers: idempotencyHeaderSchema,
          body: createSeriesBodySchema,
          response: {
            201: seriesSchema.describe('Series created with all occurrences'),
            ...commonErrorResponses,
            ...notFoundResponse,
            ...conflictResponse,
            ...idempotencyResponses,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);
        const idempotencyKey = requireIdempotencyKey(request.headers);

        const result = await recurringSeriesService.createSeries({
          patientId: principal.userId,
          therapistId: request.body.therapistId,
          startTime: new Date(request.body.startTime),
          frequency: request.body.frequency,
          occurrences: request.body.occurrences,
          idempotencyKey,
          requestId: request.requestId,
        });

        if (result.replayed) {
          reply.header('idempotent-replay', 'true');
        }

        return reply.status(result.status).send(result.series);
      },
    );

    app.get(
      '/recurring-series/:seriesId',
      {
        preHandler: app.authenticate,
        schema: {
          tags: ['Recurring'],
          summary: 'Fetch a series and its occurrences',
          security: [{ bearerAuth: [] }],
          params: z.object({ seriesId: uuidSchema }),
          response: {
            200: seriesSchema,
            ...commonErrorResponses,
            ...notFoundResponse,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);

        const series = await recurringSeriesService.getSeries({
          actor: toActor(principal),
          seriesId: request.params.seriesId,
        });

        return reply.status(200).send(series);
      },
    );

    app.post(
      '/recurring-series/:seriesId/cancel',
      {
        preHandler: app.authenticate,
        config: mutationRateLimit,
        schema: {
          tags: ['Recurring'],
          summary: 'Cancel a series and its future occurrences',
          description:
            'Cancels only occurrences that are still in the future and still scheduled. Past and ' +
            'completed sessions are immutable clinical history and are left untouched. To cancel ' +
            'a single occurrence instead, use POST ' +
            '/v1/recurring-series/{seriesId}/instances/{instanceId}/cancel.',
          security: [{ bearerAuth: [] }],
          headers: idempotencyHeaderSchema,
          params: z.object({ seriesId: uuidSchema }),
          response: {
            200: z.object({
              series: seriesSchema,
              cancelledCount: z.number().int().describe('Future occurrences that were cancelled'),
            }),
            ...commonErrorResponses,
            ...notFoundResponse,
            ...conflictResponse,
            ...idempotencyResponses,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);
        const idempotencyKey = requireIdempotencyKey(request.headers);

        const result = await recurringSeriesService.cancelSeries({
          actor: toActor(principal),
          seriesId: request.params.seriesId,
          idempotencyKey,
          requestId: request.requestId,
        });

        if (result.replayed) {
          reply.header('idempotent-replay', 'true');
        }

        return reply
          .status(result.status)
          .send({ series: result.series, cancelledCount: result.cancelledCount });
      },
    );

    app.post(
      '/recurring-series/:seriesId/instances/:instanceId/cancel',
      {
        preHandler: app.authenticate,
        config: mutationRateLimit,
        schema: {
          tags: ['Recurring'],
          summary: 'Cancel one occurrence, leaving the series intact',
          description:
            'The common real-world case: the patient is away one week but wants the standing ' +
            'appointment to continue. Only this occurrence is cancelled; the series stays ACTIVE ' +
            'and every other occurrence is untouched. The slot becomes immediately bookable by ' +
            'someone else. Fails with 404 if the occurrence does not belong to the given series, ' +
            'so a mistyped id cannot silently cancel an unrelated appointment.',
          security: [{ bearerAuth: [] }],
          headers: idempotencyHeaderSchema,
          params: z.object({ seriesId: uuidSchema, instanceId: uuidSchema }),
          response: {
            200: appointmentSchema.describe('The cancelled occurrence'),
            ...commonErrorResponses,
            ...notFoundResponse,
            ...conflictResponse,
            ...idempotencyResponses,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);
        const idempotencyKey = requireIdempotencyKey(request.headers);

        const result = await bookingService.cancelAppointment({
          actor: toActor(principal),
          appointmentId: request.params.instanceId,
          // Asserted inside the transaction: the URL claims this occurrence belongs to that
          // series, and the service refuses to act if that is not true.
          expectedSeriesId: request.params.seriesId,
          idempotencyKey,
          requestId: request.requestId,
        });

        if (result.replayed) {
          reply.header('idempotent-replay', 'true');
        }

        return reply.status(result.status).send(result.appointment);
      },
    );
  };
};
