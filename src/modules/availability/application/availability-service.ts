import { DateTime } from 'luxon';
import type { AppConfig } from '@/shared/config/index.js';
import { databaseNow, parseTimestamp, sql } from '@/shared/database/index.js';
import type { Database, Executor } from '@/shared/database/index.js';
import { notFound, validationError } from '@/shared/errors/app-error.js';
import { TimeInterval } from '@/shared/time/interval.js';
import {
  expandSlots,
  subtractBusyIntervals,
} from '@/modules/availability/domain/availability-calculator.js';
import type { ScheduleRepository } from '@/modules/scheduling/application/ports.js';

/**
 * Availability queries.
 *
 * Slots are always derived, never stored. The flow is: load the therapist's effective rules for
 * the window, expand them into candidate slots, then subtract everything that already occupies
 * the time.
 *
 * The backend is authoritative about availability. A slot appearing here means "nothing blocked
 * it when you asked", not "this is reserved for you" — which is precisely why holds exist, and
 * why the confirmation path revalidates inside a transaction rather than trusting this result.
 */

export interface AvailabilityResponse {
  readonly therapistId: string;
  readonly timezone: string;
  readonly slotGranularityMinutes: number;
  readonly from: string;
  readonly to: string;
  readonly serverTime: string;
  readonly slots: { startTime: string; endTime: string }[];
}

export interface AvailabilityService {
  getAvailability(input: {
    therapistId: string;
    from: string;
    to: string;
  }): Promise<AvailabilityResponse>;
}

// Temporal columns arrive as Postgres strings from a raw query; see shared/database/rows.ts.
type BusyRow = { startTime: string; endTime: string };

/**
 * Everything occupying the therapist's time in one query.
 *
 * A UNION ALL of appointments and live holds rather than two round trips, and rather than
 * loading each and merging in Node. Both branches are served by the partial GiST indexes on
 * `(therapist_id, tstzrange(...))`, so this is an index scan over the window instead of a
 * scan of the therapist's entire history.
 *
 * Note `h.expires_at > now()`: the hold table's exclusion constraint cannot include that
 * predicate (now() is not IMMUTABLE), so expired-but-unswept holds still exist as ACTIVE rows.
 * Filtering on the database clock here is what stops a stale hold from hiding a free slot.
 */
export const loadBusyIntervals = async (
  executor: Executor,
  therapistId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<TimeInterval[]> => {
  const result = await executor.execute<BusyRow>(sql`
    SELECT a.start_time AS "startTime", a.end_time AS "endTime"
      FROM appointments a
     WHERE a.therapist_id = ${therapistId}::uuid
       AND a.status <> 'CANCELLED'
       AND tstzrange(a.start_time, a.end_time, '[)')
           && tstzrange(${windowStart.toISOString()}::timestamptz, ${windowEnd.toISOString()}::timestamptz, '[)')
    UNION ALL
    SELECT h.start_time AS "startTime", h.end_time AS "endTime"
      FROM holds h
     WHERE h.therapist_id = ${therapistId}::uuid
       AND h.status = 'ACTIVE'
       AND h.expires_at > now()
       AND tstzrange(h.start_time, h.end_time, '[)')
           && tstzrange(${windowStart.toISOString()}::timestamptz, ${windowEnd.toISOString()}::timestamptz, '[)')
  `);

  return result.rows.map((row) =>
    TimeInterval.of(parseTimestamp(row.startTime), parseTimestamp(row.endTime)),
  );
};

export const createAvailabilityService = (dependencies: {
  config: AppConfig;
  db: Database;
  schedules: ScheduleRepository;
}): AvailabilityService => {
  const { config, db, schedules } = dependencies;

  return {
    getAvailability: async ({ therapistId, from, to }) => {
      const zone = config.APP_TIMEZONE;
      const fromDate = DateTime.fromISO(from, { zone }).startOf('day');
      const toDate = DateTime.fromISO(to, { zone }).startOf('day');

      if (!fromDate.isValid || !toDate.isValid) {
        throw validationError('from and to must be valid calendar dates.');
      }

      if (toDate < fromDate) {
        throw validationError('The "to" date must not precede the "from" date.');
      }

      // Bounded window. Without this, `from=2020-01-01&to=2099-12-31` would expand millions of
      // candidate slots and turn a public read endpoint into a denial-of-service vector.
      const spanDays = toDate.diff(fromDate, 'days').days + 1;
      if (spanDays > config.AVAILABILITY_MAX_RANGE_DAYS) {
        throw validationError(
          `The requested range is too large. Request at most ${config.AVAILABILITY_MAX_RANGE_DAYS} days.`,
          { requestedDays: Math.round(spanDays), maxDays: config.AVAILABILITY_MAX_RANGE_DAYS },
        );
      }

      const therapistExists = await db.execute<{ exists: boolean }>(
        sql`SELECT EXISTS (SELECT 1 FROM therapists WHERE id = ${therapistId}::uuid) AS exists`,
      );

      if (therapistExists.rows[0]?.exists !== true) {
        throw notFound('Therapist', therapistId);
      }

      const fromIso = fromDate.toISODate();
      const toIso = toDate.toISODate();
      if (fromIso === null || toIso === null) {
        throw validationError('from and to must be valid calendar dates.');
      }

      const rules = await schedules.findRulesForRange(db, therapistId, fromIso, toIso);

      // The database clock, not the process clock: three tasks must agree on what "already
      // past" means, and on whether a hold is still live.
      const serverTime = await databaseNow(db);

      const candidates = expandSlots({
        rules,
        fromDate: fromIso,
        toDate: toIso,
        timezone: zone,
        slotGranularityMinutes: config.SLOT_GRANULARITY_MINUTES,
        notBefore: serverTime,
      });

      const windowStart = fromDate.toJSDate();
      const windowEnd = toDate.endOf('day').toJSDate();
      const busy = await loadBusyIntervals(db, therapistId, windowStart, windowEnd);

      const available = subtractBusyIntervals(candidates, busy);

      return {
        therapistId,
        timezone: zone,
        slotGranularityMinutes: config.SLOT_GRANULARITY_MINUTES,
        from: fromIso,
        to: toIso,
        // Returned so the client can render countdowns and "is this in the past" against the
        // server's clock rather than a possibly-wrong device clock.
        serverTime: serverTime.toISOString(),
        slots: available.map((slot) => ({
          startTime: slot.interval.start.toISOString(),
          endTime: slot.interval.end.toISOString(),
        })),
      };
    },
  };
};
