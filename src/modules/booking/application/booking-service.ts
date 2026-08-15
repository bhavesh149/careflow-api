import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import type { Database, Executor, Transaction } from '@/shared/database/index.js';
import { databaseNow, parseTimestamp, sql, translateWriteError } from '@/shared/database/index.js';
import { forbidden, notFound } from '@/shared/errors/app-error.js';
import {
  appointmentAlreadyCancelled,
  holdExpired,
  holdNotOwned,
  invalidStatusTransition,
} from '@/shared/errors/domain-errors.js';
import { TimeInterval } from '@/shared/time/interval.js';
import { AggregateType, EventType, appendOutboxEvent } from '@/shared/events/index.js';
import { withIdempotency } from '@/shared/idempotency/index.js';
import { Metric, type MetricsRegistry } from '@/shared/observability/index.js';
import type { AppointmentStatus } from '@/shared/domain/vocabulary.js';
import { assertCanViewAppointment, type Actor } from '@/modules/auth/domain/authorization.js';
import {
  assertTransitionAllowed,
  assertWithinStatusWindow,
  canCancel,
} from '@/modules/booking/domain/appointment.js';
import { lockHoldForConsumption } from '@/modules/booking/application/hold-service.js';

/**
 * One-time booking, cancellation and status transitions.
 *
 * Confirmation is the highest-stakes operation in the system, so it is worth stating exactly
 * what protects it. Four layers, each covering the previous one's gap:
 *
 *   1. `FOR UPDATE` on the hold row      -- serialises two confirmations of the same hold.
 *   2. Explicit checks (owner, expiry)   -- turn a race into a clear, specific error.
 *   3. GiST exclusion constraint         -- the unconditional guarantee, even if 1 and 2 are
 *                                           bypassed by a future refactor or a direct SQL write.
 *   4. Idempotency record                -- makes a client retry after a timeout safe.
 *
 * Everything, including the outbox event and the idempotency response, commits in ONE
 * transaction. There is no window in which an appointment exists without its notification queued.
 */

export interface AppointmentView {
  readonly id: string;
  readonly therapistId: string;
  readonly therapistName: string;
  readonly patientId: string;
  readonly patientName: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly status: AppointmentStatus;
  readonly seriesId: string | null;
  readonly occurrenceIndex: number | null;
  readonly createdAt: string;
}

export interface AppointmentListResult {
  readonly appointments: AppointmentView[];
  readonly pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

export interface BookingService {
  confirmFromHold(input: {
    patientId: string;
    holdId: string;
    idempotencyKey: string;
    requestId: string;
  }): Promise<{ appointment: AppointmentView; status: 201; replayed: boolean }>;

  listAppointments(input: {
    actor: Actor;
    status?: AppointmentStatus | 'UPCOMING' | 'PAST';
    limit: number;
    offset: number;
  }): Promise<AppointmentListResult>;

  getAppointment(input: { actor: Actor; appointmentId: string }): Promise<AppointmentView>;

  cancelAppointment(input: {
    actor: Actor;
    appointmentId: string;
    /**
     * Set when cancelling through a series URL. The appointment must belong to this series, so a
     * wrong id fails instead of cancelling an unrelated appointment the caller happens to own.
     */
    expectedSeriesId?: string;
    idempotencyKey: string;
    requestId: string;
  }): Promise<{ appointment: AppointmentView; status: 200; replayed: boolean }>;

  updateStatus(input: {
    actor: Actor;
    appointmentId: string;
    status: 'COMPLETED' | 'NO_SHOW';
    idempotencyKey: string;
    requestId: string;
  }): Promise<{ appointment: AppointmentView; status: 200; replayed: boolean }>;
}

// Temporal columns arrive as Postgres strings from a raw query; see shared/database/rows.ts.
export type AppointmentRowResult = {
  id: string;
  therapistId: string;
  therapistName: string;
  patientId: string;
  patientName: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  seriesId: string | null;
  occurrenceIndex: number | null;
  createdAt: string;
};

/**
 * Names are joined in so the client can render a list without a second call per row. Both are
 * already visible to the two parties involved, and object-level authorization is enforced before
 * any row is returned.
 */
export const APPOINTMENT_SELECT = sql`
  SELECT a.id,
         a.therapist_id     AS "therapistId",
         t.display_name     AS "therapistName",
         a.patient_id       AS "patientId",
         p.full_name        AS "patientName",
         a.start_time       AS "startTime",
         a.end_time         AS "endTime",
         a.status,
         a.series_id        AS "seriesId",
         a.occurrence_index AS "occurrenceIndex",
         a.created_at       AS "createdAt"
    FROM appointments a
    JOIN therapists t ON t.id = a.therapist_id
    JOIN users p      ON p.id = a.patient_id
`;

export const toAppointmentView = (row: AppointmentRowResult): AppointmentView => ({
  id: row.id,
  therapistId: row.therapistId,
  therapistName: row.therapistName,
  patientId: row.patientId,
  patientName: row.patientName,
  startTime: parseTimestamp(row.startTime).toISOString(),
  endTime: parseTimestamp(row.endTime).toISOString(),
  status: row.status,
  seriesId: row.seriesId,
  occurrenceIndex: row.occurrenceIndex,
  createdAt: parseTimestamp(row.createdAt).toISOString(),
});

interface LockedAppointment {
  readonly id: string;
  readonly patientId: string;
  readonly therapistId: string;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly status: AppointmentStatus;
  readonly seriesId: string | null;
}

/**
 * Loads an appointment with a row lock held for the rest of the transaction.
 *
 * Both cancellation and status changes need this. `FOR UPDATE` serialises concurrent attempts on
 * the same appointment, so the second one sees the first one's committed status and is rejected by
 * the state machine rather than overwriting it and emitting a second notification.
 */
const lockAppointment = async (
  executor: Executor,
  appointmentId: string,
): Promise<LockedAppointment> => {
  const locked = await executor.execute<{
    id: string;
    patientId: string;
    therapistId: string;
    startTime: string;
    endTime: string;
    status: AppointmentStatus;
    seriesId: string | null;
  }>(sql`
    SELECT id,
           patient_id   AS "patientId",
           therapist_id AS "therapistId",
           start_time   AS "startTime",
           end_time     AS "endTime",
           status,
           series_id    AS "seriesId"
      FROM appointments
     WHERE id = ${appointmentId}::uuid
       FOR UPDATE
  `);

  const row = locked.rows[0];
  if (!row) {
    throw notFound('Appointment', appointmentId);
  }

  return {
    ...row,
    startTime: parseTimestamp(row.startTime),
    endTime: parseTimestamp(row.endTime),
  };
};

const loadAppointmentById = async (
  executor: Executor,
  appointmentId: string,
): Promise<AppointmentRowResult> => {
  const result = await executor.execute<AppointmentRowResult>(sql`
    ${APPOINTMENT_SELECT}
    WHERE a.id = ${appointmentId}::uuid
  `);

  const row = result.rows[0];
  if (!row) {
    throw notFound('Appointment', appointmentId);
  }

  return row;
};

export const createBookingService = (dependencies: {
  config: AppConfig;
  logger: Logger;
  db: Database;
  metrics: MetricsRegistry;
}): BookingService => {
  const { config, logger, db, metrics } = dependencies;

  /** Re-reads a row inside the transaction that just wrote it, so the response matches the commit. */
  const reloadInTransaction = async (
    tx: Transaction,
    appointmentId: string,
  ): Promise<AppointmentView> => toAppointmentView(await loadAppointmentById(tx, appointmentId));

  return {
    confirmFromHold: async ({ patientId, holdId, idempotencyKey, requestId }) => {
      let interval: TimeInterval | undefined;

      try {
        const result = await withIdempotency(
          db,
          {
            actorId: patientId,
            operation: 'appointments.confirm',
            key: idempotencyKey,
            // The hold id is the whole request. Reusing the key with a different hold is a
            // client bug and must be rejected rather than replayed.
            payload: { holdId },
            ttlHours: config.IDEMPOTENCY_TTL_HOURS,
            successStatus: 201,
            execute: async ({ tx }) => {
              const hold = await lockHoldForConsumption(tx, holdId);
              interval = TimeInterval.of(hold.startTime, hold.endTime);

              if (hold.patientId !== patientId) {
                throw holdNotOwned();
              }

              // Already consumed by an earlier, non-idempotent attempt: the appointment exists,
              // so return it rather than failing. This makes a client that retried without a key
              // (or with a new one) still converge on the right answer.
              if (hold.status === 'CONSUMED') {
                const existing = await tx.execute<AppointmentRowResult>(sql`
                  ${APPOINTMENT_SELECT}
                  WHERE a.therapist_id = ${hold.therapistId}::uuid
                    AND a.patient_id = ${patientId}::uuid
                    AND a.start_time = ${hold.startTime.toISOString()}::timestamptz
                    AND a.status <> 'CANCELLED'
                `);

                const row = existing.rows[0];
                if (row) {
                  return toAppointmentView(row);
                }
              }

              if (hold.status !== 'ACTIVE' || hold.expired) {
                throw holdExpired(holdId, hold.expiresAt);
              }

              const inserted = await tx.execute<{ id: string }>(sql`
                INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
                VALUES (
                  ${hold.therapistId}::uuid,
                  ${patientId}::uuid,
                  ${hold.startTime.toISOString()}::timestamptz,
                  ${hold.endTime.toISOString()}::timestamptz
                )
                RETURNING id
              `);

              const appointmentId = inserted.rows[0]?.id;
              if (!appointmentId) {
                throw new Error('Appointment insert returned no row.');
              }

              // Consuming the hold in the same transaction is what makes it single-use.
              await tx.execute(sql`
                UPDATE holds
                   SET status = 'CONSUMED', consumed_at = now()
                 WHERE id = ${holdId}::uuid
                   AND status = 'ACTIVE'
              `);

              await appendOutboxEvent(tx, {
                aggregateType: AggregateType.APPOINTMENT,
                aggregateId: appointmentId,
                eventType: EventType.APPOINTMENT_CONFIRMED,
                payload: {
                  appointmentId,
                  therapistId: hold.therapistId,
                  patientId,
                  startTime: hold.startTime.toISOString(),
                  endTime: hold.endTime.toISOString(),
                  requestId,
                },
              });

              return reloadInTransaction(tx, appointmentId);
            },
          },
          metrics,
          { replay: Metric.IDEMPOTENCY_REPLAY, conflict: Metric.IDEMPOTENCY_CONFLICT },
        );

        if (!result.replayed) {
          metrics.increment(Metric.BOOKING_CONFIRMED);
          logger.info(
            {
              appointmentId: result.body.id,
              therapistId: result.body.therapistId,
              startTime: result.body.startTime,
              event: 'appointment.confirmed',
            },
            'appointment confirmed',
          );
        }

        return { appointment: result.body, status: result.status, replayed: result.replayed };
      } catch (error) {
        const translated = translateWriteError(error, interval ? { interval } : {});

        if (
          translated.code === 'APPOINTMENT_CONFLICT' ||
          translated.code === 'SLOT_NOT_AVAILABLE'
        ) {
          metrics.increment(Metric.BOOKING_CONFLICT, { code: translated.code });
        }

        throw translated;
      }
    },

    listAppointments: async ({ actor, status, limit, offset }) => {
      // Scoped by the authenticated principal, not by a client-supplied id. There is no way to
      // ask for someone else's appointments because the filter is not part of the request.
      const ownershipFilter =
        actor.role === 'PATIENT'
          ? sql`a.patient_id = ${actor.userId}::uuid`
          : sql`a.therapist_id = ${actor.therapistId ?? ''}::uuid`;

      const statusFilter =
        status === undefined
          ? sql`TRUE`
          : status === 'UPCOMING'
            ? sql`a.status = 'SCHEDULED' AND a.start_time >= now()`
            : status === 'PAST'
              ? sql`(a.status <> 'SCHEDULED' OR a.start_time < now())`
              : sql`a.status = ${status}`;

      // Upcoming appointments read best soonest-first; history reads best most-recent-first.
      const ordering = status === 'UPCOMING' ? sql`a.start_time ASC` : sql`a.start_time DESC`;

      const rows = await db.execute<AppointmentRowResult>(sql`
        ${APPOINTMENT_SELECT}
        WHERE ${ownershipFilter} AND ${statusFilter}
        ORDER BY ${ordering}
        LIMIT ${limit} OFFSET ${offset}
      `);

      const totalResult = await db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count
          FROM appointments a
         WHERE ${ownershipFilter} AND ${statusFilter}
      `);

      const total = Number(totalResult.rows[0]?.count ?? '0');

      return {
        appointments: rows.rows.map(toAppointmentView),
        pagination: { limit, offset, total, hasMore: offset + rows.rows.length < total },
      };
    },

    getAppointment: async ({ actor, appointmentId }) => {
      const row = await loadAppointmentById(db, appointmentId);
      // Object-level authorization: being a therapist is not enough, it must be *this* one.
      assertCanViewAppointment(actor, { patientId: row.patientId, therapistId: row.therapistId });
      return toAppointmentView(row);
    },

    cancelAppointment: async ({
      actor,
      appointmentId,
      expectedSeriesId,
      idempotencyKey,
      requestId,
    }) => {
      const result = await withIdempotency(
        db,
        {
          actorId: actor.userId,
          operation: 'appointments.cancel',
          key: idempotencyKey,
          payload: { appointmentId, expectedSeriesId },
          ttlHours: config.IDEMPOTENCY_TTL_HOURS,
          successStatus: 200,
          execute: async ({ tx }) => {
            // Locked so two concurrent cancellations cannot both emit an event and double-notify.
            const appointment = await lockAppointment(tx, appointmentId);

            // Reported as not-found rather than a validation error: from the caller's point of
            // view the requested resource — this occurrence *of that series* — does not exist.
            if (expectedSeriesId !== undefined && appointment.seriesId !== expectedSeriesId) {
              throw notFound('Series occurrence', appointmentId);
            }

            assertCanViewAppointment(actor, {
              patientId: appointment.patientId,
              therapistId: appointment.therapistId,
            });

            if (appointment.status === 'CANCELLED') {
              throw appointmentAlreadyCancelled(appointmentId);
            }

            const now = await databaseNow(tx);

            if (!canCancel(appointment, now)) {
              // A completed or in-progress session cannot be cancelled; the therapist records an
              // outcome instead.
              throw invalidStatusTransition(appointment.status, 'CANCELLED');
            }

            await tx.execute(sql`
              UPDATE appointments
                 SET status = 'CANCELLED',
                     cancelled_at = now(),
                     cancelled_by = ${actor.userId}::uuid,
                     cancellation_scope = 'INSTANCE'
               WHERE id = ${appointmentId}::uuid
                 AND status = 'SCHEDULED'
            `);

            await appendOutboxEvent(tx, {
              aggregateType: AggregateType.APPOINTMENT,
              aggregateId: appointmentId,
              eventType: EventType.APPOINTMENT_CANCELLED,
              payload: {
                appointmentId,
                therapistId: appointment.therapistId,
                patientId: appointment.patientId,
                startTime: appointment.startTime.toISOString(),
                endTime: appointment.endTime.toISOString(),
                // Cancelling one instance of a series leaves the series and its other
                // occurrences untouched.
                scope: 'INSTANCE',
                cancelledBy: actor.userId,
                requestId,
              },
            });

            return reloadInTransaction(tx, appointmentId);
          },
        },
        metrics,
        { replay: Metric.IDEMPOTENCY_REPLAY, conflict: Metric.IDEMPOTENCY_CONFLICT },
      );

      if (!result.replayed) {
        metrics.increment(Metric.APPOINTMENT_CANCELLED, { scope: 'INSTANCE' });
        logger.info(
          { appointmentId, actorId: actor.userId, event: 'appointment.cancelled' },
          'appointment cancelled',
        );
      }

      return { appointment: result.body, status: result.status, replayed: result.replayed };
    },

    updateStatus: async ({ actor, appointmentId, status, idempotencyKey, requestId }) => {
      const result = await withIdempotency(
        db,
        {
          actorId: actor.userId,
          operation: 'appointments.status',
          key: idempotencyKey,
          payload: { appointmentId, status },
          ttlHours: config.IDEMPOTENCY_TTL_HOURS,
          successStatus: 200,
          execute: async ({ tx }) => {
            const appointment = await lockAppointment(tx, appointmentId);

            // Only the assigned therapist may record an outcome. A patient must not be able to
            // mark themselves as attended, and another therapist must not touch this session.
            if (actor.role !== 'THERAPIST' || actor.therapistId !== appointment.therapistId) {
              throw forbidden('Only the assigned therapist can update this appointment.');
            }

            assertTransitionAllowed(appointment.status, status);

            const now = await databaseNow(tx);

            assertWithinStatusWindow(appointment, now, config.STATUS_UPDATE_GRACE_HOURS);

            await tx.execute(sql`
              UPDATE appointments
                 SET status = ${status}
               WHERE id = ${appointmentId}::uuid
                 AND status = 'SCHEDULED'
            `);

            await appendOutboxEvent(tx, {
              aggregateType: AggregateType.APPOINTMENT,
              aggregateId: appointmentId,
              eventType: EventType.APPOINTMENT_STATUS_CHANGED,
              payload: {
                appointmentId,
                therapistId: appointment.therapistId,
                patientId: appointment.patientId,
                fromStatus: appointment.status,
                toStatus: status,
                changedBy: actor.userId,
                requestId,
              },
            });

            return reloadInTransaction(tx, appointmentId);
          },
        },
        metrics,
        { replay: Metric.IDEMPOTENCY_REPLAY, conflict: Metric.IDEMPOTENCY_CONFLICT },
      );

      if (!result.replayed) {
        metrics.increment(Metric.STATUS_CHANGED, { status });
        logger.info(
          { appointmentId, status, actorId: actor.userId, event: 'appointment.status_changed' },
          'appointment status updated',
        );
      }

      return { appointment: result.body, status: result.status, replayed: result.replayed };
    },
  };
};
