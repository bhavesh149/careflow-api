import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

/**
 * Real Postgres for every suite above `unit`, started once per run.
 *
 * There are no repository mocks anywhere in this test suite, and that is a deliberate decision
 * rather than thoroughness for its own sake. The behaviour this system depends on most —
 * `EXCLUDE USING gist` arbitrating two simultaneous bookings, `SELECT ... FOR UPDATE` serialising
 * hold consumption, `ON CONFLICT DO NOTHING` making an idempotency claim atomic — exists only in
 * Postgres. A mocked repository would happily agree with whatever the application believes and
 * would prove nothing about the property we actually care about.
 *
 * In CI the workflow provides a Postgres service via `TEST_DATABASE_URL` so we do not pay for
 * a nested Docker daemon. Locally, and anywhere else that variable is unset, Testcontainers
 * starts the same image RDS and Compose run.
 */

const POSTGRES_IMAGE = 'postgres:17.6-alpine';

const TEST_JWT_SECRET = 'test_secret_that_is_long_enough_to_pass_validation_000000000000';

let postgres: StartedPostgreSqlContainer | undefined;

const applyProcessEnv = (databaseUrl: string): void => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.MIGRATION_DATABASE_URL = databaseUrl;
  process.env.DB_SSL = 'false';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
  process.env.JWT_SECRET ??= TEST_JWT_SECRET;
  process.env.QUEUE_DRIVER = 'noop';
  process.env.REDIS_ENABLED = 'false';
  process.env.COOKIE_SECURE = 'false';
  process.env.SWAGGER_ENABLED = 'false';
};

export default async ({ provide }: TestProject): Promise<() => Promise<void>> => {
  const providedUrl = process.env.TEST_DATABASE_URL;
  const databaseUrl =
    providedUrl !== undefined && providedUrl.length > 0
      ? providedUrl
      : await (async () => {
          postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
            .withDatabase('careflow_test')
            .withUsername('careflow_test')
            .withPassword('careflow_test')
            // Durability is irrelevant for a throwaway container, and turning fsync off makes
            // the concurrency suites (which commit constantly) several times faster.
            .withCommand(['postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off'])
            .start();
          return postgres.getConnectionUri();
        })();

  applyProcessEnv(databaseUrl);

  // Imported after the environment is set: the module graph reads configuration eagerly enough
  // that importing it first would capture the developer's local database instead.
  const { runMigrations } = await import('@/shared/database/migrate.js');
  await runMigrations();

  provide('databaseUrl', databaseUrl);
  provide('redisUrl', process.env.TEST_REDIS_URL ?? 'redis://localhost:6379');

  return async () => {
    await postgres?.stop();
  };
};

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}
