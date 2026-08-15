import { sql } from 'drizzle-orm';
import type { Database, Executor, Transaction } from '@/shared/database/pool.js';
import { isRetryableTransactionError } from '@/shared/database/pg-errors.js';
import { parseTimestamp } from '@/shared/database/rows.js';

/**
 * Transaction boundaries and lock primitives.
 *
 * Isolation choice, deliberately documented because it is the kind of decision a reviewer
 * will ask about:
 *
 * We use READ COMMITTED (Postgres' default) plus *explicit* locking rather than
 * SERIALIZABLE. SERIALIZABLE would give correctness for free, but it detects conflicts by
 * aborting transactions with a serialization failure, which every caller must then retry.
 * On a contended slot — precisely our worst case, many patients racing for one 15:00
 * Monday — that degenerates into a retry storm where most work is thrown away.
 *
 * Instead we make contention explicit and cheap:
 *   * `SELECT ... FOR UPDATE` on the hold row, so exactly one confirmation proceeds per hold.
 *   * A per-therapist advisory lock around multi-row recurring validation, so the
 *     check-then-insert sequence over many occurrences cannot interleave with another series.
 *   * GiST exclusion constraints as the final, unconditional guarantee.
 *
 * The result is that races serialise by *waiting* briefly rather than by failing and
 * retrying, and the loser gets a deterministic 409 instead of an opaque retry error.
 */

export interface TransactionOptions {
  /** Only raise above READ COMMITTED for a specific, justified reason. */
  readonly isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  readonly readOnly?: boolean;
}

export const withTransaction = async <T>(
  db: Database,
  handler: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> =>
  db.transaction(handler, {
    isolationLevel: options.isolationLevel ?? 'read committed',
    accessMode: options.readOnly === true ? 'read only' : 'read write',
  });

/**
 * Retries only transactions that failed with a serialization or deadlock error, and only
 * those. Anything else — a conflict, a validation failure, a bug — is returned immediately,
 * because retrying a deterministic failure just multiplies load during an incident.
 *
 * Safe to use because a transaction that aborted for these reasons left no visible trace.
 */
export const withRetryableTransaction = async <T>(
  db: Database,
  handler: (tx: Transaction) => Promise<T>,
  options: TransactionOptions & { maxAttempts?: number } = {},
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTransaction(db, handler, options);
    } catch (error) {
      lastError = error;

      if (!isRetryableTransactionError(error) || attempt === maxAttempts) {
        throw error;
      }

      // Small randomised backoff so concurrent losers do not retry in lockstep.
      const delayMs = Math.min(50 * 2 ** (attempt - 1), 250) + Math.random() * 25;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
};

/**
 * Serialises work per therapist for the duration of the current transaction.
 *
 * Needed because recurring confirmation validates N occurrences and then inserts N rows.
 * Row-level locks cannot protect rows that do not exist yet, so without this two concurrent
 * series for the same therapist could each validate successfully and then collide
 * half-way through inserting — leaving one series partially created, which violates the
 * all-or-nothing policy. (The exclusion constraint would still prevent double booking; the
 * lock is what preserves atomic *series* semantics and avoids nondeterministic partial work.)
 *
 * `pg_advisory_xact_lock` is released automatically at COMMIT or ROLLBACK, so no code path
 * can leak it. `hashtextextended` maps the UUID onto the bigint the lock API expects.
 */
export const lockTherapistForTransaction = async (
  tx: Transaction,
  therapistId: string,
): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`therapist:${therapistId}`}, 0))`,
  );
};

/**
 * Non-blocking variant. Returns false instead of waiting, which lets a background job skip
 * work another instance is already doing rather than queueing behind it.
 */
export const tryLockForTransaction = async (tx: Transaction, key: string): Promise<boolean> => {
  const result = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`,
  );
  return result.rows[0]?.locked === true;
};

/**
 * The database's own clock.
 *
 * Every decision about whether a hold is still valid must come from here, not from
 * `new Date()`. Three ECS tasks have three system clocks; if task A's clock runs 800ms fast
 * it would consider a hold expired while task B still considers it live, and the two would
 * disagree about who owns a slot. Postgres has exactly one clock, so it arbitrates.
 */
export const databaseNow = async (executor: Executor): Promise<Date> => {
  const result = await executor.execute<{ now: string }>(sql`SELECT now() AS now`);
  const now = result.rows[0]?.now;

  if (now === undefined) {
    throw new Error('Failed to read the database clock.');
  }

  return parseTimestamp(now);
};
