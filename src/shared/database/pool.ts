import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import { schema } from '@/shared/database/schema.js';

/**
 * Postgres connection management.
 *
 * A note on why `numeric` and `int8` parsers are left alone but timestamps are not: node-pg
 * parses TIMESTAMPTZ into a JS Date using the *client's* local timezone offset for the
 * string it receives. Because every container is pinned to UTC and every column is
 * TIMESTAMPTZ, the resulting Date instants are correct. We assert that explicitly below
 * rather than leaving it to chance, since a misconfigured TZ would silently shift every
 * appointment.
 */

export type Database = NodePgDatabase<typeof schema>;

/**
 * The transaction handle Drizzle hands to a `transaction()` callback. Deriving it from the
 * library rather than hand-writing the generic keeps repositories working across upgrades.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Repositories accept either the pool-backed database or an open transaction. This is the
 * whole unit-of-work contract: a use case decides the transaction boundary, and every
 * repository it calls enlists in that same transaction instead of opening its own.
 */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

// DATE columns (schedule effective dates) are calendar dates, not instants. Returning them
// as plain 'YYYY-MM-DD' strings avoids the classic bug where `new Date('2026-03-01')` is
// parsed as UTC midnight and then displayed as the previous day in a positive-offset zone.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

export const createDatabase = (config: AppConfig, logger: Logger): DatabaseHandle => {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    min: config.DB_POOL_MIN,
    // Named so that `pg_stat_activity` shows which task a connection belongs to during an
    // incident. Invaluable when three API tasks and three workers share one RDS instance.
    application_name: `${config.SERVICE_NAME}:${config.INSTANCE_ID}`,
    ssl: config.DB_SSL ? { rejectUnauthorized: true } : undefined,
    // A runaway query must not pin a pool slot forever. This is the last line of defence
    // behind explicit query design; 10s is far above our p99 and far below a user's patience.
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    // Guards against a connection that a NAT/firewall has silently dropped.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Recycle connections so a long-lived task cannot accumulate server-side state.
    maxLifetimeSeconds: 1_800,
  });

  // An error on an *idle* client is emitted on the pool, not on a query. Without this
  // listener Node treats it as an unhandled 'error' event and kills the process.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle postgres client error');
  });

  const db = drizzle(pool, { schema, logger: false });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
};

/**
 * Readiness probe. Deliberately trivial and cheap: it proves the pool can obtain a
 * connection and the server answers, without touching application tables.
 */
export const pingDatabase = async (pool: Pool): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
};

export interface PoolStats {
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
  readonly max: number;
}

/** Exposed as metrics: `waiting` climbing above zero is the earliest sign of pool starvation. */
export const poolStats = (pool: Pool, max: number): PoolStats => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
  max,
});
