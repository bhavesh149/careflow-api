import { DateTime } from 'luxon';
import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import type { Database, Executor } from '@/shared/database/index.js';
import {
  databaseNow,
  parseTimestamp,
  sql,
  translateWriteError,
  withTransaction,
} from '@/shared/database/index.js';
import { notFound, validationError } from '@/shared/errors/app-error.js';
import {
  holdExpired,
  holdNotFound,
  holdNotOwned,
  maxActiveHoldsExceeded,
  slotNotAvailable,
} from '@/shared/errors/domain-errors.js';
import { TimeInterval } from '@/shared/time/interval.js';
import { Metric, type MetricsRegistry } from '@/shared/observability/index.js';
import { expandSlots } from '@/modules/availability/domain/availability-calculator.js';
import type { ScheduleRepository } from '@/modules/scheduling/application/ports.js';

/**
 * Temporary slot holds.
 *
 * A hold is a short ownership claim that stops two patients racing through a booking form for
 * the same slot. The design points that make it correct under concurrency:
 *
 *   * Expiry is a database column, not a timer. A `setTimeout` in one of three tasks is invisible
 *     to the other two and dies with a deployment; `expires_at` is a fact all of them read.
 *   * `expiresAt` and `serverTime` are both returned, so the client counts down against the
 *     server's clock rather than a device clock that may be minutes off.
 *   * Creation is one transaction that reclaims overlapping expired holds and then inserts. The
 *     GiST exclusion constraint arbitrates the race, so two simultaneous requests cannot both win.
 */

export interface HoldView {
  readonly id: string;
  readonly therapistId: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly expiresAt: string;
  readonly serverTime: string;
  readonly expiresInSeconds: number;
}

export interface HoldService {
  createHold(input: {
    patientId: string;
    therapistId: string;
    startTime: Date;
    requestId: string;
  }): Promise<HoldView>;
  listActiveHolds(patientId: string): Promise<HoldView[]>;
  releaseHold(input: { holdId: string; patientId: string }): Promise<void>;
}

// Temporal columns arrive as Postgres strings from a raw query; see shared/database/rows.ts.
type HoldRowResult = {
  id: string;
  therapistId: string;
  startTime: string;
  endTime: string;
  expiresAt: string;
  serverTime: string;
};

const toView = (row: HoldRowResult): HoldView => {
  const expiresAt = parseTimestamp(row.expiresAt);
  const serverTime = parseTimestamp(row.serverTime);

  return {
    id: row.id,
    therapistId: row.therapistId,
    startTime: parseTimestamp(row.startTime).toISOString(),
    endTime: parseTimestamp(row.endTime).toISOString(),
    expiresAt: expiresAt.toISOString(),
    serverTime: serverTime.toISOString(),
    // Both instants come from the same `now()` in the same statement, so the countdown the client
    // renders cannot be skewed by clock drift between tasks or by the device clock.
    expiresInSeconds: Math.max(0, Math.round((expiresAt.getTime() - serverTime.getTime()) / 1000)),
  };
};

export interface LockedHold {
  readonly id: string;
  readonly patientId: string;
  readonly therapistId: string;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly expiresAt: Date;
  readonly status: string;
  /** Evaluated by the database, not by comparing against a process clock. */
  readonly expired: boolean;
}

/**
 * Loads a hold for consumption, taking a row lock.
 *
 * `FOR UPDATE` is the difference between "one confirmation succeeds" and "both do". Two
 * concurrent confirmations of the same hold both reach this statement; the second blocks until
 * the first commits, and then sees status = 'CONSUMED' and is rejected. Without the lock they
 * would both read 'ACTIVE' and attempt to insert an appointment.
 *
 * Expiry is evaluated against `now()` — the database clock — for the same reason.
 */
export const lockHoldForConsumption = async (
  executor: Executor,
  holdId: string,
): Promise<LockedHold> => {
  const result = await executor.execute<{
    id: string;
    patientId: string;
    therapistId: string;
    startTime: string;
    endTime: string;
    expiresAt: string;
    status: string;
    expired: boolean;
  }>(sql`
    SELECT id,
           patient_id   AS "patientId",
           therapist_id AS "therapistId",
           start_time   AS "startTime",
           end_time     AS "endTime",
           expires_at   AS "expiresAt",
           status,
           (expires_at <= now()) AS expired
      FROM holds
     WHERE id = ${holdId}::uuid
       FOR UPDATE
  `);

  const row = result.rows[0];
  if (!row) {
    throw holdNotFound(holdId);
  }

  return {
    ...row,
    startTime: parseTimestamp(row.startTime),
    endTime: parseTimestamp(row.endTime),
    expiresAt: parseTimestamp(row.expiresAt),
  };
};

export const createHoldService = (dependencies: {
  config: AppConfig;
  logger: Logger;
  db: Database;
  metrics: MetricsRegistry;
  schedules: ScheduleRepository;
}): HoldService => {
  const { config, logger, db, metrics, schedules } = dependencies;

  return {
    createHold: async ({ patientId, therapistId, startTime, requestId }) => {
      const interval = TimeInterval.of(
        startTime,
        new Date(startTime.getTime() + config.SLOT_GRANULARITY_MINUTES * 60_000),
      );

      try {
        const row = await withTransaction(db, async (tx) => {
          const now = await databaseNow(tx);

          if (interval.start.getTime() <= now.getTime()) {
            throw validationError('Cannot hold a slot that has already started.', {
              startTime: interval.start.toISOString(),
              serverTime: now.toISOString(),
            });
          }

          const therapistExists = await tx.execute<{ exists: boolean }>(
            sql`SELECT EXISTS (SELECT 1 FROM therapists WHERE id = ${therapistId}::uuid) AS exists`,
          );
          if (therapistExists.rows[0]?.exists !== true) {
            throw notFound('Therapist', therapistId);
          }

          // The requested time must be a real slot in the therapist's schedule. Without this an
          // API client could hold 03:00 on a Sunday, which no schedule offers, and the hold
          // would then block nothing while still consuming the patient's hold allowance.
          const fromIso = DateTime.fromJSDate(interval.start, {
            zone: config.APP_TIMEZONE,
          }).toISODate();
          if (fromIso === null) {
            throw validationError('The requested slot is not a valid instant.');
          }

          const rules = await schedules.findRulesForRange(tx, therapistId, fromIso, fromIso);
          const offered = expandSlots({
            rules,
            fromDate: fromIso,
            toDate: fromIso,
            timezone: config.APP_TIMEZONE,
            slotGranularityMinutes: config.SLOT_GRANULARITY_MINUTES,
          });

          if (!offered.some((slot) => slot.interval.equals(interval))) {
            throw slotNotAvailable(interval.start, interval.end);
          }

          // Per-patient cap. Counted inside the transaction so a burst of parallel requests
          // cannot each observe "2 active" and collectively create six holds. Expired-but-unswept
          // holds are excluded, otherwise a patient who abandoned three forms would be locked out
          // for a minute.
          const activeCount = await tx.execute<{ count: string }>(sql`
            SELECT count(*)::text AS count
              FROM holds
             WHERE patient_id = ${patientId}::uuid
               AND status = 'ACTIVE'
               AND expires_at > now()
          `);

          if (Number(activeCount.rows[0]?.count ?? '0') >= config.MAX_ACTIVE_HOLDS_PER_PATIENT) {
            throw maxActiveHoldsExceeded(config.MAX_ACTIVE_HOLDS_PER_PATIENT);
          }

          // A confirmed appointment beats any hold, so check it explicitly to return the precise
          // SLOT_NOT_AVAILABLE rather than letting the insert fail with a hold conflict.
          const booked = await tx.execute<{ exists: boolean }>(sql`
            SELECT EXISTS (
              SELECT 1 FROM appointments
               WHERE therapist_id = ${therapistId}::uuid
                 AND status <> 'CANCELLED'
                 AND tstzrange(start_time, end_time, '[)')
                     && tstzrange(${interval.start.toISOString()}::timestamptz, ${interval.end.toISOString()}::timestamptz, '[)')
            ) AS exists
          `);

          if (booked.rows[0]?.exists === true) {
            throw slotNotAvailable(interval.start, interval.end);
          }

          // Reclaim overlapping holds that have lapsed. This is required, not merely tidy: the
          // exclusion constraint's predicate is `status = 'ACTIVE'` and cannot test `expires_at`
          // (a partial index predicate must be IMMUTABLE, and now() is not). So a lapsed hold
          // still occupies the constraint until something flips it, and the sweeper may not have
          // run yet. Doing it here means an expired hold never blocks the next patient.
          await tx.execute(sql`
            UPDATE holds
               SET status = 'EXPIRED'
             WHERE therapist_id = ${therapistId}::uuid
               AND status = 'ACTIVE'
               AND expires_at <= now()
               AND tstzrange(start_time, end_time, '[)')
                   && tstzrange(${interval.start.toISOString()}::timestamptz, ${interval.end.toISOString()}::timestamptz, '[)')
          `);

          // expires_at is computed by the database so the TTL is measured on the one clock every
          // task shares. The insert is where the race is decided: whichever transaction commits
          // first owns the slot, and the other gets 23P01, translated to SLOT_ALREADY_HELD.
          const inserted = await tx.execute<HoldRowResult>(sql`
            INSERT INTO holds (therapist_id, patient_id, start_time, end_time, expires_at)
            VALUES (
              ${therapistId}::uuid,
              ${patientId}::uuid,
              ${interval.start.toISOString()}::timestamptz,
              ${interval.end.toISOString()}::timestamptz,
              now() + (${config.HOLD_TTL_SECONDS} * interval '1 second')
            )
            RETURNING id,
                      therapist_id AS "therapistId",
                      start_time   AS "startTime",
                      end_time     AS "endTime",
                      expires_at   AS "expiresAt",
                      now()        AS "serverTime"
          `);

          const row = inserted.rows[0];
          if (!row) {
            throw new Error('Hold insert returned no row.');
          }

          return row;
        });

        metrics.increment(Metric.HOLD_CREATED);
        logger.info(
          {
            holdId: row.id,
            therapistId,
            startTime: parseTimestamp(row.startTime).toISOString(),
            event: 'hold.created',
            requestId,
          },
          'slot hold created',
        );

        return toView(row);
      } catch (error) {
        const translated = translateWriteError(error, { interval });
        metrics.increment(Metric.HOLD_REJECTED, { code: translated.code });
        throw translated;
      }
    },

    /**
     * The patient's live holds.
     *
     * Exists because a hold must survive a page refresh: the browser reloads, asks what it still
     * owns, and resumes the countdown. If holds lived in memory or in a client-side timer this
     * endpoint could not exist, and a refresh would silently abandon the slot.
     */
    listActiveHolds: async (patientId) => {
      const result = await db.execute<HoldRowResult>(sql`
        SELECT id,
               therapist_id AS "therapistId",
               start_time   AS "startTime",
               end_time     AS "endTime",
               expires_at   AS "expiresAt",
               now()        AS "serverTime"
          FROM holds
         WHERE patient_id = ${patientId}::uuid
           AND status = 'ACTIVE'
           AND expires_at > now()
         ORDER BY expires_at
      `);

      return result.rows.map(toView);
    },

    releaseHold: async ({ holdId, patientId }) => {
      await withTransaction(db, async (tx) => {
        const hold = await lockHoldForConsumption(tx, holdId);

        // Ownership is checked against the authenticated principal, never against a body field.
        if (hold.patientId !== patientId) {
          throw holdNotOwned();
        }

        // Releasing an already-consumed hold is a conflict, but releasing one that merely lapsed
        // is exactly what the client intended, so treat it as success.
        if (hold.status !== 'ACTIVE') {
          if (hold.status === 'EXPIRED' || hold.status === 'RELEASED') {
            return;
          }
          throw holdExpired(holdId, hold.expiresAt);
        }

        await tx.execute(sql`
          UPDATE holds
             SET status = 'RELEASED', released_at = now()
           WHERE id = ${holdId}::uuid
             AND status = 'ACTIVE'
        `);
      });

      logger.info({ holdId, event: 'hold.released' }, 'slot hold released');
    },
  };
};
