import type { Database, Transaction } from '@/shared/database/pool.js';
import { withTransaction } from '@/shared/database/unit-of-work.js';
import { idempotencyInProgress, idempotencyKeyReused } from '@/shared/errors/domain-errors.js';
import { hashRequestPayload } from '@/shared/security/request-hash.js';
import {
  claimIdempotencyKey,
  completeIdempotencyRecord,
  failIdempotencyRecord,
  reopenIdempotencyRecord,
} from '@/shared/idempotency/idempotency-store.js';
import type { Metric, MetricsRegistry } from '@/shared/observability/metrics.js';

/**
 * Wraps a mutating use case so that retrying it with the same Idempotency-Key is safe.
 *
 * The critical design point is that the key claim, the business work and the stored response
 * all happen in ONE transaction. Consequences:
 *
 *   * Commit means both the appointment and its replayable response exist. A retry can never
 *     find "booking committed but key still PROCESSING" and book a second time.
 *   * Rollback means the key row disappears with it, so the client's retry gets a clean
 *     attempt rather than being told "in progress" forever.
 *
 * The `FAILED` state exists for the narrower case where the work threw *after* we chose to
 * record the failure deliberately (see `markFailure`), so a doomed key is not wedged until TTL.
 */

export interface IdempotencyContext {
  readonly tx: Transaction;
}

/** Statuses a successful mutation can return. Narrow so route schemas stay exhaustive. */
export type SuccessStatus = 200 | 201;

export interface IdempotentOperation<T, S extends SuccessStatus = SuccessStatus> {
  readonly actorId: string;
  readonly operation: string;
  readonly key: string;
  /** Hashed to detect the same key being reused with different content. */
  readonly payload: unknown;
  readonly ttlHours: number;
  /** HTTP status stored for replays; 201 for creations, 200 for state changes. */
  readonly successStatus: S;
  readonly execute: (context: IdempotencyContext) => Promise<T>;
}

export interface IdempotentResult<T, S extends SuccessStatus = SuccessStatus> {
  readonly body: T;
  readonly status: S;
  /** True when the response came from a stored record rather than fresh work. */
  readonly replayed: boolean;
}

export const withIdempotency = async <T, S extends SuccessStatus>(
  db: Database,
  operation: IdempotentOperation<T, S>,
  metrics?: MetricsRegistry,
  metricNames?: {
    replay: typeof Metric.IDEMPOTENCY_REPLAY;
    conflict: typeof Metric.IDEMPOTENCY_CONFLICT;
  },
): Promise<IdempotentResult<T, S>> => {
  const requestHash = hashRequestPayload(operation.payload);

  try {
    return await withTransaction(db, async (tx) => {
      const claim = await claimIdempotencyKey(tx, {
        key: operation.key,
        actorId: operation.actorId,
        operation: operation.operation,
        requestHash,
        ttlHours: operation.ttlHours,
      });

      switch (claim.kind) {
        case 'MISMATCH':
          if (metrics && metricNames)
            metrics.increment(metricNames.conflict, { operation: operation.operation });
          throw idempotencyKeyReused();

        case 'IN_PROGRESS':
          // A duplicate arrived while the original is still running. We deliberately do not
          // block waiting for it: holding a request (and a pool connection) hostage to
          // another transaction is how a burst of retries exhausts the pool. Tell the client
          // to retry shortly instead.
          throw idempotencyInProgress(1);

        case 'REPLAY':
          if (metrics && metricNames)
            metrics.increment(metricNames.replay, { operation: operation.operation });
          // The stored status arrives from the database as a plain number. It can only ever be a
          // value this same code path wrote, so narrowing it back is safe.
          return { body: claim.body as T, status: claim.status as S, replayed: true };

        case 'RETRY_AFTER_FAILURE': {
          await reopenIdempotencyRecord(tx, claim.recordId);
          const body = await operation.execute({ tx });
          await completeIdempotencyRecord(tx, claim.recordId, operation.successStatus, body);
          return { body, status: operation.successStatus, replayed: false };
        }

        case 'CLAIMED':
        default: {
          const body = await operation.execute({ tx });
          await completeIdempotencyRecord(tx, claim.recordId, operation.successStatus, body);
          return { body, status: operation.successStatus, replayed: false };
        }
      }
    });
  } catch (error) {
    // The transaction rolled back, so the PROCESSING row is gone and a retry starts fresh.
    // This call only matters in the rare case where a record survived (a failure recorded in
    // a prior attempt), and it must run outside the aborted transaction to have any effect.
    await failIdempotencyRecord(db, operation.actorId, operation.operation, operation.key).catch(
      () => undefined,
    );
    throw error;
  }
};
