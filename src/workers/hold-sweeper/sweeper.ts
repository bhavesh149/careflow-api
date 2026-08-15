import type { Logger } from '@/shared/logging/index.js';
import type { Database } from '@/shared/database/index.js';
import { parseTimestamp, sql, withTransaction } from '@/shared/database/index.js';
import { Metric, type MetricsRegistry } from '@/shared/observability/index.js';
import { AggregateType, EventType, appendOutboxEvents } from '@/shared/events/index.js';
import type { NewDomainEvent } from '@/shared/events/domain-events.js';

/**
 * The hold-expiry sweeper.
 *
 * Read this together with the holds exclusion constraint, because the two are a pair.
 *
 * The constraint is `EXCLUDE ... WHERE (status = 'ACTIVE')`. It cannot say "and not expired",
 * because a partial-index predicate must be IMMUTABLE and `now()` is not. So a hold whose TTL has
 * lapsed but whose row still says ACTIVE keeps blocking its slot as far as the constraint is
 * concerned.
 *
 * Correctness therefore does not depend on this worker at all. Two other mechanisms already cover
 * it: availability queries filter on `expires_at > now()`, so a lapsed hold is invisible to
 * patients browsing slots, and the hold-create transaction flips overlapping expired rows to
 * EXPIRED before inserting, so a patient can always take a slot whose hold has lapsed.
 *
 * What the sweeper adds is hygiene and observability. It keeps the ACTIVE working set small so
 * the exclusion constraint's index stays tight, it makes `status` mean what it says for anyone
 * querying the table directly, and it emits HoldExpired events that make abandonment rate
 * measurable. Losing this worker for an hour degrades nothing a user can see — which is exactly
 * the property to aim for in a background job.
 */

export interface HoldSweeperDependencies {
  readonly logger: Logger;
  readonly db: Database;
  readonly metrics: MetricsRegistry;
  /** Bounded so one pass cannot lock a huge number of rows after an outage. */
  readonly batchSize: number;
}

export interface HoldSweeper {
  sweep(): Promise<boolean>;
}

type ExpiredHoldRow = {
  id: string;
  therapistId: string;
  patientId: string;
  // Temporal columns arrive as Postgres strings from a raw query; see shared/database/rows.ts.
  startTime: string;
  endTime: string;
};

export const createHoldSweeper = (dependencies: HoldSweeperDependencies): HoldSweeper => {
  const { logger, db, metrics, batchSize } = dependencies;

  return {
    sweep: async () => {
      const expired = await withTransaction(db, async (tx) => {
        // SKIP LOCKED keeps the sweeper out of the way of the request path: if a confirmation is
        // holding this row's lock, the sweeper steps over it rather than waiting, so a booking is
        // never slowed down by housekeeping. It also lets multiple sweepers run safely.
        const result = await tx.execute<ExpiredHoldRow>(sql`
          WITH lapsed AS (
            SELECT id
              FROM holds
             WHERE status = 'ACTIVE'
               AND expires_at <= now()
             ORDER BY expires_at
               FOR UPDATE SKIP LOCKED
             LIMIT ${batchSize}
          )
          UPDATE holds AS h
             SET status = 'EXPIRED'
            FROM lapsed
           WHERE h.id = lapsed.id
          RETURNING h.id,
                    h.therapist_id AS "therapistId",
                    h.patient_id   AS "patientId",
                    h.start_time   AS "startTime",
                    h.end_time     AS "endTime"
        `);

        const rows = [...result.rows];

        if (rows.length > 0) {
          // Written in the same transaction as the status change, so the event and the state it
          // describes cannot disagree.
          const events: NewDomainEvent[] = rows.map((row) => ({
            aggregateType: AggregateType.HOLD,
            aggregateId: row.id,
            eventType: EventType.HOLD_EXPIRED,
            payload: {
              holdId: row.id,
              therapistId: row.therapistId,
              patientId: row.patientId,
              startTime: parseTimestamp(row.startTime).toISOString(),
              endTime: parseTimestamp(row.endTime).toISOString(),
            },
          }));

          await appendOutboxEvents(tx, events);
        }

        return rows;
      });

      if (expired.length > 0) {
        metrics.increment(Metric.HOLD_EXPIRED, {}, expired.length);
        logger.info({ expired: expired.length }, 'expired lapsed holds');
      }

      return expired.length === batchSize;
    },
  };
};
