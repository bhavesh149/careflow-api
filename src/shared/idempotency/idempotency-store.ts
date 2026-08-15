import { sql } from 'drizzle-orm';
import type { Executor } from '@/shared/database/pool.js';

/**
 * Idempotency claim/complete operations.
 *
 * The mechanism in one sentence: claiming a key is a single atomic
 * `INSERT ... ON CONFLICT DO NOTHING`, and whoever inserts the row owns the operation.
 *
 * Why not "SELECT then INSERT if absent": between the SELECT and the INSERT a second request
 * on another task does the same thing, both find nothing, and both proceed to book. That is
 * the exact bug idempotency is supposed to prevent, so the check and the claim must be one
 * statement. The unique index on (actor_id, operation, key) is what makes it atomic.
 */

export type ClaimOutcome =
  | { readonly kind: 'CLAIMED'; readonly recordId: string }
  | { readonly kind: 'IN_PROGRESS' }
  | { readonly kind: 'REPLAY'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'MISMATCH' }
  /** A previous attempt failed and was recorded; the caller may retry the work. */
  | { readonly kind: 'RETRY_AFTER_FAILURE'; readonly recordId: string };

// Type alias, not interface: Drizzle's `execute<T>` requires an index signature, which
// TypeScript infers for type aliases but not for interfaces.
type ExistingRecord = {
  id: string;
  state: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown;
};

export const claimIdempotencyKey = async (
  executor: Executor,
  input: {
    key: string;
    actorId: string;
    operation: string;
    requestHash: string;
    ttlHours: number;
  },
): Promise<ClaimOutcome> => {
  const inserted = await executor.execute<{ id: string }>(sql`
    INSERT INTO idempotency_records (key, actor_id, operation, request_hash, state, expires_at)
    VALUES (
      ${input.key},
      ${input.actorId}::uuid,
      ${input.operation},
      ${input.requestHash},
      'PROCESSING',
      now() + (${input.ttlHours} * interval '1 hour')
    )
    ON CONFLICT (actor_id, operation, key) DO NOTHING
    RETURNING id
  `);

  const claimedId = inserted.rows[0]?.id;
  if (claimedId !== undefined) {
    return { kind: 'CLAIMED', recordId: claimedId };
  }

  // The insert lost, so a record already exists. Read it to decide what the caller sees.
  const existing = await executor.execute<ExistingRecord>(sql`
    SELECT id,
           state,
           request_hash    AS "requestHash",
           response_status AS "responseStatus",
           response_body   AS "responseBody"
      FROM idempotency_records
     WHERE actor_id = ${input.actorId}::uuid
       AND operation = ${input.operation}
       AND key = ${input.key}
  `);

  const record = existing.rows[0];
  if (!record) {
    // Vanishingly rare: the row was removed by TTL cleanup between the two statements.
    // Treating it as in-progress asks the client to retry, which is the safe direction.
    return { kind: 'IN_PROGRESS' };
  }

  // Same key, different payload. Almost always a client bug (a reused key, or a key derived
  // from something insufficiently unique). Returning the *original* response would be
  // actively dangerous: the caller would believe a different booking succeeded.
  if (record.requestHash !== input.requestHash) {
    return { kind: 'MISMATCH' };
  }

  switch (record.state) {
    case 'COMPLETED':
      return {
        kind: 'REPLAY',
        status: record.responseStatus ?? 200,
        body: record.responseBody,
      };
    case 'FAILED':
      return { kind: 'RETRY_AFTER_FAILURE', recordId: record.id };
    case 'PROCESSING':
    default:
      return { kind: 'IN_PROGRESS' };
  }
};

/**
 * Stores the response for future replays.
 *
 * Called inside the same transaction as the business change, so it is impossible to have a
 * committed appointment whose idempotency record still says PROCESSING (which would let a
 * retry create a second one).
 */
export const completeIdempotencyRecord = async (
  executor: Executor,
  recordId: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> => {
  await executor.execute(sql`
    UPDATE idempotency_records
       SET state = 'COMPLETED',
           response_status = ${responseStatus},
           response_body = ${JSON.stringify(responseBody)}::jsonb,
           completed_at = now()
     WHERE id = ${recordId}::uuid
  `);
};

/**
 * Marks a failed attempt so the key can be retried rather than being wedged as PROCESSING
 * until its TTL expires.
 *
 * Runs on its own connection: the business transaction has already rolled back, so writing
 * this inside it would roll back too and leave the key stuck.
 */
export const failIdempotencyRecord = async (
  executor: Executor,
  actorId: string,
  operation: string,
  key: string,
): Promise<void> => {
  await executor.execute(sql`
    UPDATE idempotency_records
       SET state = 'FAILED', completed_at = now()
     WHERE actor_id = ${actorId}::uuid
       AND operation = ${operation}
       AND key = ${key}
       AND state = 'PROCESSING'
  `);
};

/** Reopens a previously failed record for another attempt. */
export const reopenIdempotencyRecord = async (
  executor: Executor,
  recordId: string,
): Promise<void> => {
  await executor.execute(sql`
    UPDATE idempotency_records
       SET state = 'PROCESSING', response_status = NULL, response_body = NULL, completed_at = NULL
     WHERE id = ${recordId}::uuid
  `);
};

/** TTL cleanup, run by the sweeper worker. Keeps the table from growing without bound. */
export const purgeExpiredIdempotencyRecords = async (executor: Executor): Promise<number> => {
  const result = await executor.execute(
    sql`DELETE FROM idempotency_records WHERE expires_at < now()`,
  );
  return result.rowCount ?? 0;
};
