import { sql } from 'drizzle-orm';
import type { Executor } from '@/shared/database/pool.js';
import { outboxEvents } from '@/shared/database/schema.js';
import type { NewDomainEvent } from '@/shared/events/domain-events.js';

/**
 * Outbox writes and claims.
 *
 * `append` is called with the *same* transaction as the business change, which is the entire
 * point of the pattern: the appointment and its notification either both exist or neither does.
 */
// A type alias rather than an interface: Drizzle's `execute<T>` constrains T to
// Record<string, unknown>, and only type aliases receive an implicit index signature.
export type ClaimedOutboxEvent = {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  /** Postgres string from a raw query, converted by the caller; see shared/database/rows.ts. */
  readonly occurredAt: string;
  readonly attempts: number;
};

export const appendOutboxEvent = async (
  executor: Executor,
  event: NewDomainEvent,
): Promise<void> => {
  await executor.insert(outboxEvents).values({
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: event.payload,
  });
};

export const appendOutboxEvents = async (
  executor: Executor,
  events: readonly NewDomainEvent[],
): Promise<void> => {
  if (events.length === 0) return;

  await executor.insert(outboxEvents).values(
    events.map((event) => ({
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
    })),
  );
};

/**
 * Claims a batch of due events for this worker.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes the publisher horizontally scalable: each worker
 * locks the rows it takes, and a second worker simply steps over them instead of blocking or
 * double-publishing. Without SKIP LOCKED, running two publishers would either serialise them
 * completely or hand both the same event.
 *
 * The subquery-plus-update shape is used because `UPDATE ... RETURNING` cannot itself use
 * SKIP LOCKED; we select-and-lock the ids first, then mark them attempted in the same
 * statement so a crash mid-batch cannot lose the attempt count.
 */
export const claimOutboxBatch = async (
  executor: Executor,
  batchSize: number,
): Promise<ClaimedOutboxEvent[]> => {
  const result = await executor.execute<ClaimedOutboxEvent>(sql`
    WITH claimed AS (
      SELECT id
        FROM outbox_events
       WHERE status = 'PENDING'
         AND next_attempt_at <= now()
       ORDER BY occurred_at
         FOR UPDATE SKIP LOCKED
       LIMIT ${batchSize}
    )
    UPDATE outbox_events AS o
       SET attempts = o.attempts + 1
      FROM claimed
     WHERE o.id = claimed.id
    RETURNING o.id,
              o.aggregate_type AS "aggregateType",
              o.aggregate_id   AS "aggregateId",
              o.event_type     AS "eventType",
              o.payload,
              o.occurred_at    AS "occurredAt",
              o.attempts
  `);

  return [...result.rows];
};

export const markOutboxPublished = async (
  executor: Executor,
  eventIds: readonly string[],
): Promise<void> => {
  if (eventIds.length === 0) return;

  await executor.execute(sql`
    UPDATE outbox_events
       SET status = 'PUBLISHED',
           published_at = now(),
           last_error = NULL
     WHERE id = ANY(${sql.param(eventIds)}::uuid[])
  `);
};

/**
 * Schedules a retry with exponential backoff, or gives up.
 *
 * Capping backoff at ~5 minutes keeps a transient SQS outage from pushing recovery hours
 * out, while `DEAD` (rather than endless retries) means a permanently malformed event stops
 * consuming worker capacity and shows up on the dead-event alarm for a human to look at.
 */
export const markOutboxFailed = async (
  executor: Executor,
  eventId: string,
  attempts: number,
  maxAttempts: number,
  error: string,
): Promise<'RETRY' | 'DEAD'> => {
  const exhausted = attempts >= maxAttempts;

  if (exhausted) {
    await executor.execute(sql`
      UPDATE outbox_events
         SET status = 'DEAD', last_error = ${error.slice(0, 1000)}
       WHERE id = ${eventId}::uuid
    `);
    return 'DEAD';
  }

  const backoffSeconds = Math.min(2 ** attempts, 300);

  await executor.execute(sql`
    UPDATE outbox_events
       SET last_error = ${error.slice(0, 1000)},
           next_attempt_at = now() + (${backoffSeconds} * interval '1 second')
     WHERE id = ${eventId}::uuid
  `);

  return 'RETRY';
};

/** Backlog depth, exported as a gauge; a rising value means the publisher is losing ground. */
export const countPendingOutboxEvents = async (executor: Executor): Promise<number> => {
  const result = await executor.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM outbox_events WHERE status = 'PENDING'`,
  );
  return Number(result.rows[0]?.count ?? '0');
};
