/**
 * The `sql` tag is re-exported so that no layer above this one imports `drizzle-orm` directly
 * (the lint configuration forbids it). Queries are written against this single seam, which is
 * what makes "which files would a change of data-access library touch?" answerable.
 */
export { sql } from 'drizzle-orm';
export { createDatabase, pingDatabase, poolStats } from '@/shared/database/pool.js';
export type {
  Database,
  DatabaseHandle,
  Executor,
  PoolStats,
  Transaction,
} from '@/shared/database/pool.js';
export {
  databaseNow,
  lockTherapistForTransaction,
  tryLockForTransaction,
  withRetryableTransaction,
  withTransaction,
} from '@/shared/database/unit-of-work.js';
export type { TransactionOptions } from '@/shared/database/unit-of-work.js';
export {
  ConstraintName,
  PgErrorCode,
  asPostgresError,
  isConstraintViolation,
  isPgError,
  isRetryableTransactionError,
  translateWriteError,
} from '@/shared/database/pg-errors.js';
export {
  parseCount,
  parseNullableTimestamp,
  parseTimestamp,
} from '@/shared/database/rows.js';
export * from '@/shared/database/schema.js';
