import { afterAll, beforeEach, inject } from 'vitest';
import { Pool } from 'pg';

/**
 * Points this worker at the container database and gives every test a clean slate.
 *
 * The environment is set before any application module is imported, because configuration is
 * read once and cached — importing first would capture the developer's local database.
 *
 * TRUNCATE rather than a transaction-per-test wrapper: the code under test opens its own
 * transactions and takes advisory locks, and the concurrency suites deliberately run several
 * connections at once. A shared outer transaction would make all of that untestable, since none of
 * those connections would see each other's uncommitted work.
 */

const databaseUrl = inject('databaseUrl');
const redisUrl = inject('redisUrl');

process.env.DATABASE_URL = databaseUrl;
process.env.MIGRATION_DATABASE_URL = databaseUrl;
process.env.REDIS_URL = redisUrl;
process.env.DB_SSL = 'false';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.JWT_SECRET ??= 'test_secret_that_is_long_enough_to_pass_validation_000000000000';
process.env.REDIS_ENABLED = 'false';
process.env.QUEUE_DRIVER = 'noop';
process.env.COOKIE_SECURE = 'false';
process.env.SWAGGER_ENABLED = 'false';

/**
 * Everything except `schema_migrations`, which holds the schema history the migrator wrote and
 * must survive. Ordered irrelevantly: one TRUNCATE with CASCADE handles the foreign keys.
 */
const TABLES = [
  'processed_messages',
  'outbox_events',
  'idempotency_records',
  'appointments',
  'recurring_series',
  'holds',
  'therapist_schedules',
  'refresh_tokens',
  'therapists',
  'users',
] as const;

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await pool.end();
});
