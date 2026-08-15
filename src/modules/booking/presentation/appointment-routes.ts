import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppConfig } from '@/shared/config/index.js';
import { idempotencyKeyRequired } from '@/shared/errors/domain-errors.js';
import {
  commonErrorResponses,
  conflictResponse,
  idempotencyHeaderSchema,
  idempotencyResponses,
  notFoundResponse,
  paginationMetaSchema,
  paginationQuerySchema,
  uuidSchema,
} from '@/shared/http/schemas.js';
import type { Actor } from '@/modules/auth/domain/authorization.js';
import { getPrincipal, requireRole } from '@/modules/auth/presentation/authenticate.js';
import type { BookingService } from '@/modules/booking/application/booking-service.js';

/**
 * Appointment endpoints.
 *
 * The Idempotency-Key header is mandatory on every state-changing route here rather than
 * optional. These operations create or destroy commitments between two people, and a client that
 * retries a timed-out confirm without a key can double-book. Requiring the header makes the safe
 * path the only path.
 */

const appointmentSchema = z.object({
  id: uuidSchema,
  therapistId: uuidSchema,
  therapistName: z.string(),
  patientId: uuidSchema,
  patientName: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  status: z.enum(['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED']),
  seriesId: uuidSchema
    .nullable()
    .describe('Set when this appointment belongs to a recurring series'),
  occurrenceIndex: z.number().int().nullable(),
  createdAt: z.string(),
});

const confirmBodySchema = z.object({
  holdId: uuidSchema.describe('The hold to consume. Must be active and owned by the caller.'),
});

const statusBodySchema = z.object({
  status: z.enum(['COMPLETED', 'NO_SHOW']).describe('Outcome recorded by the therapist'),
});

/**
 * Reads the Idempotency-Key.
 *
 * Also validated by the route schema, but this keeps the failure a domain error with the
 * documented code rather than a generic header-validation message.
 */
const requireIdempotencyKey = (headers: Record<string, unknown>): string => {
  const value = headers['idempotency-key'];

  if (typeof value !== 'string' || value.trim().length < 16) {
    throw idempotencyKeyRequired();
  }

  return value.trim();
};

export interface AppointmentRouteDependencies {
  readonly config: AppConfig;
  readonly bookingService: BookingService;
}

export const registerAppointmentRoutes = (
  dependencies: AppointmentRouteDependencies,
): FastifyPluginAsyncZod => {
  const { config, bookingService } = dependencies;

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
      '/appointments/confirm',
      {
        preHandler: [app.authenticate, requireRole('PATIENT')],
        config: mutationRateLimit,
        schema: {
          tags: ['Appointments'],
          summary: 'Confirm a held slot into an appointment',
          description:
            'Consumes an active hold and creates the appointment in a single transaction, ' +
            'together with the outbox event for notification. The hold is single-use. Conflicts ' +
            'are arbitrated by the database, so a losing request receives a deterministic 409 ' +
            'rather than an inconsistent success. Retrying with the same Idempotency-Key returns ' +
            'the original appointment instead of creating a second one.',
          security: [{ bearerAuth: [] }],
          headers: idempotencyHeaderSchema,
          body: confirmBodySchema,
          response: {
            201: appointmentSchema.describe('Appointment confirmed'),
            ...commonErrorResponses,
            ...conflictResponse,
            ...idempotencyResponses,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);
        const idempotencyKey = requireIdempotencyKey(request.headers);

        const result = await bookingService.confirmFromHold({
          patientId: principal.userId,
          holdId: request.body.holdId,
          idempotencyKey,
          requestId: request.requestId,
        });

        // Signals to the client (and to anyone reading logs) that this was a replay rather
        // than fresh work, which is invaluable when debugging a retry storm.
        if (result.replayed) {
          reply.header('idempotent-replay', 'true');
        }

        return reply.status(result.status).send(result.appointment);
      },
    );

    // Two paths, one implementation. The `me` in each path is the authenticated principal, never
    // a client-supplied id, so there is no request a patient could craft to read another
    // patient's calendar. Separate paths per role (rather than one `/appointments`) keep the
    // audience of each response obvious in logs, docs and client code.
    const listRoute = (
      path: '/patients/me/appointments' | '/therapists/me/appointments',
      role: 'PATIENT' | 'THERAPIST',
      summary: string,
    ): void => {
      app.get(
        path,
        {
          preHandler: [app.authenticate, requireRole(role)],
          schema: {
            tags: ['Appointments'],
            summary,
            description:
              'Scoped to the authenticated user. Supports offset pagination and a status ' +
              'filter; UPCOMING is ordered soonest-first and everything else most-recent-first, ' +
              'which is how each list is actually read.',
            security: [{ bearerAuth: [] }],
            querystring: paginationQuerySchema.extend({
              status: z
                .enum(['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'UPCOMING', 'PAST'])
                .optional()
                .describe('UPCOMING = scheduled and still in the future; PAST = everything else'),
            }),
            response: {
              200: z.object({
                appointments: z.array(appointmentSchema),
                pagination: paginationMetaSchema,
              }),
              ...commonErrorResponses,
            },
          },
        },
        async (request, reply) => {
          const principal = getPrincipal(request);

          const result = await bookingService.listAppointments({
            actor: toActor(principal),
            ...(request.query.status === undefined ? {} : { status: request.query.status }),
            limit: request.query.limit,
            offset: request.query.offset,
          });

          return reply.status(200).send(result);
        },
      );
    };

    listRoute('/patients/me/appointments', 'PATIENT', "The patient's own appointments");
    listRoute('/therapists/me/appointments', 'THERAPIST', "The therapist's own appointments");

    app.get(
      '/appointments/:appointmentId',
      {
        preHandler: app.authenticate,
        schema: {
          tags: ['Appointments'],
          summary: 'Fetch a single appointment',
          description:
            'Readable only by the patient who booked it or the therapist delivering it. Any ' +
            'other caller receives 403 rather than a 404, so the response does not confirm ' +
            'whether the id exists.',
          security: [{ bearerAuth: [] }],
          params: z.object({ appointmentId: uuidSchema }),
          response: {
            200: appointmentSchema,
            ...commonErrorResponses,
            ...notFoundResponse,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);

        const appointment = await bookingService.getAppointment({
          actor: toActor(principal),
          appointmentId: request.params.appointmentId,
        });

        return reply.status(200).send(appointment);
      },
    );

    // POST rather than DELETE: cancelling does not remove the appointment, it transitions it to
    // CANCELLED and keeps the record for history and reporting. DELETE would misdescribe that,
    // and the row is never actually deleted.
    app.post(
      '/appointments/:appointmentId/cancel',
      {
        preHandler: app.authenticate,
        config: mutationRateLimit,
        schema: {
          tags: ['Appointments'],
          summary: 'Cancel an appointment',
          description:
            'Either party may cancel a future appointment. The slot becomes immediately ' +
            'bookable again while the cancelled record is retained for history. Cancelling one ' +
            'occurrence of a recurring series leaves the rest of the series intact. An ' +
            'appointment that has already started cannot be cancelled; the therapist records an ' +
            'outcome instead.',
          security: [{ bearerAuth: [] }],
          headers: idempotencyHeaderSchema,
          params: z.object({ appointmentId: uuidSchema }),
          response: {
            200: appointmentSchema.describe('The cancelled appointment'),
            ...commonErrorResponses,
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
          appointmentId: request.params.appointmentId,
          idempotencyKey,
          requestId: request.requestId,
        });

        if (result.replayed) {
          reply.header('idempotent-replay', 'true');
        }

        return reply.status(result.status).send(result.appointment);
      },
    );

    app.post(
      '/appointments/:appointmentId/status',
      {
        preHandler: [app.authenticate, requireRole('THERAPIST')],
        config: mutationRateLimit,
        schema: {
          tags: ['Appointments'],
          summary: 'Record the outcome of a session',
          description:
            'Only the assigned therapist may do this, and only from the appointment start until ' +
            `${config.STATUS_UPDATE_GRACE_HOURS} hours after it ends. Both bounds are ` +
            'deliberate: marking a session complete before it happens corrupts reporting, and an ' +
            'unbounded window would let history be rewritten indefinitely. COMPLETED and NO_SHOW ' +
            'are terminal.',
          security: [{ bearerAuth: [] }],
          headers: idempotencyHeaderSchema,
          params: z.object({ appointmentId: uuidSchema }),
          body: statusBodySchema,
          response: {
            200: appointmentSchema.describe('The updated appointment'),
            ...commonErrorResponses,
            ...conflictResponse,
            ...idempotencyResponses,
          },
        },
      },
      async (request, reply) => {
        const principal = getPrincipal(request);
        const idempotencyKey = requireIdempotencyKey(request.headers);

        const result = await bookingService.updateStatus({
          actor: toActor(principal),
          appointmentId: request.params.appointmentId,
          status: request.body.status,
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
