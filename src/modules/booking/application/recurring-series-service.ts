import { DateTime } from 'luxon';
import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import type { Database, Transaction } from '@/shared/database/index.js';
import {
  databaseNow,
  lockTherapistForTransaction,
  parseTimestamp,
  sql,
  translateWriteError,
} from '@/shared/database/index.js';
import { notFound, validationError } from '@/shared/errors/app-error.js';
import {
  recurringConflict,
  seriesAlreadyCancelled,
  type ConflictingOccurrence,
} from '@/shared/errors/domain-errors.js';
import { TimeInterval } from '@/shared/time/interval.js';
import { AggregateType, EventType, appendOutboxEvent } from '@/shared/events/index.js';
import { withIdempotency } from '@/shared/idempotency/index.js';
import { Metric, type MetricsRegistry } from '@/shared/observability/index.js';
import type { RecurrenceFrequency } from '@/shared/domain/vocabulary.js';
import { assertCanViewAppointment, type Actor } from '@/modules/auth/domain/authorization.js';
import { expandRecurrence, describeHorizonLimit } from '@/modules/booking/domain/recurrence.js';
import { expandSlots } from '@/modules/availability/domain/availability-calculator.js';
import type { ScheduleRepository } from '@/modules/scheduling/application/ports.js';
import {
  APPOINTMENT_SELECT,
  toAppointmentView,
  type AppointmentRowResult,
  type AppointmentView,
} from '@/modules/booking/application/booking-service.js';

/**
 * Recurring series.
 *
 * Two design decisions dominate this file.
 *
 * ALL-OR-NOTHING. If any occurrence conflicts, nothing is booked and the response lists every
 * conflicting occurrence. Partial success was rejected deliberately: a patient who asks for
 * twelve weekly sessions and silently receives seven has no idea which five are missing, and the
 * therapist's calendar becomes unpredictable. Failing whole gives the patient one clear decision
 * to make. The cost is that a single clash blocks the series, which is why the error enumerates
 * the clashes so the client can propose an alternative.
 *
 * PER-THERAPIST ADVISORY LOCK. Validation checks N occurrences, then inserts N rows. Row locks
 * cannot reserve rows that do not exist yet, so two concurrent series for the same therapist could
 * each validate cleanly and then collide mid-insert. The exclusion constraint would still prevent
 * double booking, but the loser would abort part-way, which is exactly the partial state
 * all-or-nothing forbids. `pg_advisory_xact_lock` keyed on the therapist makes the
 * validate-then-insert sequence atomic with respect to other series for that therapist, while
 * leaving other therapists fully parallel. It is released automatically at commit or rollback.
 */

export interface SeriesView {
  readonly id: string;
  readonly therapistId: string;
  readonly patientId: string;
  readonly frequency: RecurrenceFrequency;
  readonly occurrences: number;
  readonly status: 'ACTIVE' | 'CANCELLED';
  readonly createdAt: string;
  readonly appointments: AppointmentView[];
  readonly truncated?: boolean;
  readonly truncationReason?: string;
  readonly clampedOccurrences?: string[];
}

export interface RecurringSeriesService {
  createSeries(input: {
    patientId: string;
    therapistId: string;
    startTime: Date;
    frequency: RecurrenceFrequency;
    occurrences: number;
    idempotencyKey: string;
    requestId: string;
  }): Promise<{ series: SeriesView; status: 201; replayed: boolean }>;

  getSeries(input: { actor: Actor; seriesId: string }): Promise<SeriesView>;

  cancelSeries(input: {
    actor: Actor;
    seriesId: string;
    idempotencyKey: string;
    requestId: string;
  }): Promise<{ series: SeriesView; cancelledCount: number; status: 200; replayed: boolean }>;
}

// Temporal columns arrive as Postgres strings from a raw query; see shared/database/rows.ts.
type SeriesRow = {
  id: string;
  therapistId: string;
  patientId: string;
  frequency: RecurrenceFrequency;
  occurrences: number;
  status: 'ACTIVE' | 'CANCELLED';
  createdAt: string;
};

export const createRecurringSeriesService = (dependencies: {
  config: AppConfig;
  logger: Logger;
  db: Database;
  metrics: MetricsRegistry;
  schedules: ScheduleRepository;
}): RecurringSeriesService => {
  const { config, logger, db, metrics, schedules } = dependencies;

  const loadSeriesWithAppointments = async (
    executor: Transaction | Database,
    seriesId: string,
  ): Promise<SeriesView> => {
    const seriesResult = await executor.execute<SeriesRow>(sql`
      SELECT id,
             therapist_id AS "therapistId",
             patient_id   AS "patientId",
             frequency,
             occurrences,
             status,
             created_at   AS "createdAt"
        FROM recurring_series
       WHERE id = ${seriesId}::uuid
    `);

    const series = seriesResult.rows[0];
    if (!series) {
      throw notFound('Recurring series', seriesId);
    }

    // The same projection the one-time appointment queries use, so a series occurrence and a
    // standalone appointment are never described differently to a client.
    const appointments = await executor.execute<AppointmentRowResult>(sql`
      ${APPOINTMENT_SELECT}
      WHERE a.series_id = ${seriesId}::uuid
      ORDER BY a.occurrence_index
    `);

    return {
      id: series.id,
      therapistId: series.therapistId,
      patientId: series.patientId,
      frequency: series.frequency,
      occurrences: series.occurrences,
      status: series.status,
      createdAt: parseTimestamp(series.createdAt).toISOString(),
      appointments: appointments.rows.map(toAppointmentView),
    };
  };

  return {
    createSeries: async ({
      patientId,
      therapistId,
      startTime,
      frequency,
      occurrences,
      idempotencyKey,
      requestId,
    }) => {
      try {
        const result = await withIdempotency(
          db,
          {
            actorId: patientId,
            operation: 'recurring.create',
            key: idempotencyKey,
            payload: {
              therapistId,
              startTime: startTime.toISOString(),
              frequency,
              occurrences,
            },
            ttlHours: config.IDEMPOTENCY_TTL_HOURS,
            successStatus: 201,
            execute: async ({ tx }) => {
              const therapistExists = await tx.execute<{ exists: boolean }>(
                sql`SELECT EXISTS (SELECT 1 FROM therapists WHERE id = ${therapistId}::uuid) AS exists`,
              );
              if (therapistExists.rows[0]?.exists !== true) {
                throw notFound('Therapist', therapistId);
              }

              // Taken before any validation so that the entire validate-then-insert sequence is
              // serialised per therapist. Acquiring it after validating would leave the exact
              // window this lock exists to close.
              await lockTherapistForTransaction(tx, therapistId);

              const now = await databaseNow(tx);

              if (startTime.getTime() <= now.getTime()) {
                throw validationError('A recurring series cannot start in the past.', {
                  startTime: startTime.toISOString(),
                  serverTime: now.toISOString(),
                });
              }

              const anchorEnd = new Date(
                startTime.getTime() + config.SLOT_GRANULARITY_MINUTES * 60_000,
              );

              const expanded = expandRecurrence({
                frequency,
                anchorStart: startTime,
                anchorEnd,
                occurrences,
                timezone: config.APP_TIMEZONE,
                maxOccurrences: config.RECURRENCE_MAX_OCCURRENCES,
                maxHorizonDays: config.RECURRENCE_MAX_HORIZON_DAYS,
              });

              if (expanded.length === 0) {
                throw validationError('The recurrence rule produced no occurrences.');
              }

              const first = expanded[0];
              const last = expanded[expanded.length - 1];
              if (!first || !last) {
                throw validationError('The recurrence rule produced no occurrences.');
              }

              const windowStart = first.interval.start;
              const windowEnd = last.interval.end;

              const fromIso = DateTime.fromJSDate(windowStart, {
                zone: config.APP_TIMEZONE,
              }).toISODate();
              const toIso = DateTime.fromJSDate(windowEnd, {
                zone: config.APP_TIMEZONE,
              }).toISODate();
              if (fromIso === null || toIso === null) {
                throw validationError('The recurrence window is not a valid date range.');
              }

              // ---- Validate every occurrence before writing anything ----
              const conflicts: ConflictingOccurrence[] = [];

              // One query for the whole window instead of one per occurrence: a 26-week series
              // would otherwise mean 26 round trips inside a lock held against this therapist.
              const rules = await schedules.findRulesForRange(tx, therapistId, fromIso, toIso);
              const offered = expandSlots({
                rules,
                fromDate: fromIso,
                toDate: toIso,
                timezone: config.APP_TIMEZONE,
                slotGranularityMinutes: config.SLOT_GRANULARITY_MINUTES,
              });
              const offeredKeys = new Set(offered.map((slot) => slot.interval.start.getTime()));

              const busy = await tx.execute<{
                startTime: string;
                endTime: string;
                kind: string;
              }>(sql`
                SELECT a.start_time AS "startTime", a.end_time AS "endTime", 'appointment' AS kind
                  FROM appointments a
                 WHERE a.therapist_id = ${therapistId}::uuid
                   AND a.status <> 'CANCELLED'
                   AND tstzrange(a.start_time, a.end_time, '[)')
                       && tstzrange(${windowStart.toISOString()}::timestamptz, ${windowEnd.toISOString()}::timestamptz, '[)')
                UNION ALL
                SELECT h.start_time AS "startTime", h.end_time AS "endTime", 'hold' AS kind
                  FROM holds h
                 WHERE h.therapist_id = ${therapistId}::uuid
                   AND h.status = 'ACTIVE'
                   AND h.expires_at > now()
                   AND h.patient_id <> ${patientId}::uuid
                   AND tstzrange(h.start_time, h.end_time, '[)')
                       && tstzrange(${windowStart.toISOString()}::timestamptz, ${windowEnd.toISOString()}::timestamptz, '[)')
              `);

              const busyIntervals = busy.rows.map((row) => ({
                interval: TimeInterval.of(
                  parseTimestamp(row.startTime),
                  parseTimestamp(row.endTime),
                ),
                kind: row.kind,
              }));

              for (const occurrence of expanded) {
                if (!offeredKeys.has(occurrence.interval.start.getTime())) {
                  conflicts.push({
                    startTime: occurrence.interval.start.toISOString(),
                    endTime: occurrence.interval.end.toISOString(),
                    reason: 'OUTSIDE_SCHEDULE',
                  });
                  continue;
                }

                const clash = busyIntervals.find((entry) =>
                  entry.interval.overlaps(occurrence.interval),
                );
                if (clash) {
                  conflicts.push({
                    startTime: occurrence.interval.start.toISOString(),
                    endTime: occurrence.interval.end.toISOString(),
                    reason: clash.kind === 'hold' ? 'HELD_BY_OTHER' : 'ALREADY_BOOKED',
                  });
                }
              }

              if (conflicts.length > 0) {
                // Rolls the transaction back, so nothing is written and the advisory lock is
                // released immediately.
                throw recurringConflict(conflicts);
              }

              // ---- Write the series and all its occurrences ----
              const seriesInsert = await tx.execute<{ id: string }>(sql`
                INSERT INTO recurring_series (therapist_id, patient_id, frequency, anchor_start, anchor_end, occurrences)
                VALUES (
                  ${therapistId}::uuid,
                  ${patientId}::uuid,
                  ${frequency},
                  ${first.interval.start.toISOString()}::timestamptz,
                  ${first.interval.end.toISOString()}::timestamptz,
                  ${expanded.length}
                )
                RETURNING id
              `);

              const seriesId = seriesInsert.rows[0]?.id;
              if (!seriesId) {
                throw new Error('Series insert returned no row.');
              }

              const values = expanded.map(
                (occurrence) =>
                  sql`(${therapistId}::uuid, ${patientId}::uuid, ${seriesId}::uuid, ${occurrence.index}, ${occurrence.interval.start.toISOString()}::timestamptz, ${occurrence.interval.end.toISOString()}::timestamptz)`,
              );

              // A single multi-row INSERT: one statement, one round trip, and the exclusion
              // constraint still evaluates every row. If any row conflicts the whole statement
              // fails, which is exactly the all-or-nothing semantics we want.
              await tx.execute(sql`
                INSERT INTO appointments (therapist_id, patient_id, series_id, occurrence_index, start_time, end_time)
                VALUES ${sql.join(values, sql`, `)}
              `);

              // Any hold this patient already had on one of these slots is now redundant.
              await tx.execute(sql`
                UPDATE holds
                   SET status = 'CONSUMED', consumed_at = now()
                 WHERE patient_id = ${patientId}::uuid
                   AND therapist_id = ${therapistId}::uuid
                   AND status = 'ACTIVE'
                   AND tstzrange(start_time, end_time, '[)')
                       && tstzrange(${windowStart.toISOString()}::timestamptz, ${windowEnd.toISOString()}::timestamptz, '[)')
              `);

              await appendOutboxEvent(tx, {
                aggregateType: AggregateType.RECURRING_SERIES,
                aggregateId: seriesId,
                eventType: EventType.RECURRING_SERIES_CREATED,
                payload: {
                  seriesId,
                  therapistId,
                  patientId,
                  frequency,
                  occurrences: expanded.length,
                  firstStartTime: first.interval.start.toISOString(),
                  requestId,
                },
              });

              const view = await loadSeriesWithAppointments(tx, seriesId);
              const horizon = describeHorizonLimit(
                occurrences,
                expanded.length,
                config.RECURRENCE_MAX_OCCURRENCES,
                config.RECURRENCE_MAX_HORIZON_DAYS,
              );

              const clamped = expanded
                .filter((occurrence) => occurrence.clamped)
                .map((occurrence) => occurrence.interval.start.toISOString());

              return {
                ...view,
                // Surfaced rather than silent: the patient asked for 52 sessions and got 26, or
                // asked for the 31st and got the 28th in February. Both are things they should see.
                ...(horizon.truncated
                  ? {
                      truncated: true,
                      ...(horizon.reason === undefined ? {} : { truncationReason: horizon.reason }),
                    }
                  : {}),
                ...(clamped.length > 0 ? { clampedOccurrences: clamped } : {}),
              };
            },
          },
          metrics,
          { replay: Metric.IDEMPOTENCY_REPLAY, conflict: Metric.IDEMPOTENCY_CONFLICT },
        );

        if (!result.replayed) {
          metrics.increment(Metric.RECURRING_CONFIRMED, { frequency });
          logger.info(
            {
              seriesId: result.body.id,
              therapistId,
              frequency,
              occurrences: result.body.appointments.length,
              event: 'recurring.created',
            },
            'recurring series created',
          );
        }

        return { series: result.body, status: result.status, replayed: result.replayed };
      } catch (error) {
        const translated = translateWriteError(error);

        if (
          translated.code === 'RECURRING_CONFLICT' ||
          translated.code === 'APPOINTMENT_CONFLICT'
        ) {
          metrics.increment(Metric.RECURRING_CONFLICT, { code: translated.code });
        }

        throw translated;
      }
    },

    getSeries: async ({ actor, seriesId }) => {
      const view = await loadSeriesWithAppointments(db, seriesId);
      assertCanViewAppointment(actor, { patientId: view.patientId, therapistId: view.therapistId });
      return view;
    },

    /**
     * Cancels the series and its future occurrences.
     *
     * Past and already-completed occurrences are left untouched. Cancelling a session that
     * already happened would erase clinical history, and marking a completed session as cancelled
     * would corrupt reporting. "Cancel the series" means "stop the future ones".
     */
    cancelSeries: async ({ actor, seriesId, idempotencyKey, requestId }) => {
      let cancelledCount = 0;

      const result = await withIdempotency(
        db,
        {
          actorId: actor.userId,
          operation: 'recurring.cancel',
          key: idempotencyKey,
          payload: { seriesId },
          ttlHours: config.IDEMPOTENCY_TTL_HOURS,
          successStatus: 200,
          execute: async ({ tx }) => {
            const locked = await tx.execute<{
              id: string;
              patientId: string;
              therapistId: string;
              status: 'ACTIVE' | 'CANCELLED';
            }>(sql`
              SELECT id,
                     patient_id   AS "patientId",
                     therapist_id AS "therapistId",
                     status
                FROM recurring_series
               WHERE id = ${seriesId}::uuid
                 FOR UPDATE
            `);

            const series = locked.rows[0];
            if (!series) {
              throw notFound('Recurring series', seriesId);
            }

            assertCanViewAppointment(actor, {
              patientId: series.patientId,
              therapistId: series.therapistId,
            });

            if (series.status === 'CANCELLED') {
              throw seriesAlreadyCancelled(seriesId);
            }

            const cancelled = await tx.execute(sql`
              UPDATE appointments
                 SET status = 'CANCELLED',
                     cancelled_at = now(),
                     cancelled_by = ${actor.userId}::uuid,
                     cancellation_scope = 'SERIES'
               WHERE series_id = ${seriesId}::uuid
                 AND status = 'SCHEDULED'
                 AND start_time > now()
            `);

            cancelledCount = cancelled.rowCount ?? 0;

            await tx.execute(sql`
              UPDATE recurring_series
                 SET status = 'CANCELLED', cancelled_at = now()
               WHERE id = ${seriesId}::uuid
            `);

            await appendOutboxEvent(tx, {
              aggregateType: AggregateType.RECURRING_SERIES,
              aggregateId: seriesId,
              eventType: EventType.RECURRING_SERIES_CANCELLED,
              payload: {
                seriesId,
                therapistId: series.therapistId,
                patientId: series.patientId,
                cancelledInstances: cancelledCount,
                cancelledBy: actor.userId,
                requestId,
              },
            });

            return loadSeriesWithAppointments(tx, seriesId);
          },
        },
        metrics,
        { replay: Metric.IDEMPOTENCY_REPLAY, conflict: Metric.IDEMPOTENCY_CONFLICT },
      );

      if (!result.replayed) {
        metrics.increment(Metric.APPOINTMENT_CANCELLED, { scope: 'SERIES' });
        logger.info(
          { seriesId, cancelledCount, actorId: actor.userId, event: 'recurring.cancelled' },
          'recurring series cancelled',
        );
      }

      return {
        series: result.body,
        cancelledCount,
        status: result.status,
        replayed: result.replayed,
      };
    },
  };
};
