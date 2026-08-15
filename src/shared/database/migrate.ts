import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { getConfig } from '@/shared/config/index.js';
import { createLogger } from '@/shared/logging/index.js';

/**
 * Migration runner.
 *
 * Hand-rolled rather than delegated to `drizzle-kit push`, for reasons that matter in
 * production:
 *
 *   * The booking invariants are GiST exclusion constraints, custom range types and partial
 *     indexes. A schema differ cannot be trusted to author or preserve those, and a
 *     "helpful" regeneration that silently drops `appointments_no_overlap` would remove the
 *     system's only real protection against double booking.
 *   * Migrations are reviewed SQL in git. What ran in staging is byte-identical to what
 *     runs in production, and the checksum check proves it.
 *   * A session-level advisory lock makes it safe for this to be triggered concurrently.
 *     During an ECS deployment several things may race to migrate; all but one will wait.
 *
 * Each migration runs inside its own transaction: Postgres supports transactional DDL, so a
 * failure leaves the schema exactly as it was rather than half-applied.
 */

// Arbitrary but fixed: any process holding this lock is the one allowed to migrate.
const MIGRATION_ADVISORY_LOCK_KEY = 4_071_555_001;

const migrationsDir = path.resolve(fileURLToPath(new URL('../../../migrations', import.meta.url)));

interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const loadMigrations = async (): Promise<MigrationFile[]> => {
  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((entry) => entry.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];

  for (const fileName of sqlFiles) {
    const match = /^(\d+)_(.+)\.sql$/.exec(fileName);
    if (!match?.[1] || !match[2]) {
      throw new Error(
        `Migration "${fileName}" does not follow the required <version>_<name>.sql convention.`,
      );
    }

    const sql = await readFile(path.join(migrationsDir, fileName), 'utf8');

    migrations.push({
      version: match[1],
      name: match[2],
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  return migrations;
};

export const runMigrations = async (): Promise<void> => {
  const config = getConfig();
  const logger = createLogger(config).child({ component: 'migrator' });

  // Migrations connect as the schema owner. The API's runtime role has no DDL rights at
  // all, which is what stops an application bug from dropping a table.
  const connectionString =
    config.MIGRATION_DATABASE_URL.length > 0 ? config.MIGRATION_DATABASE_URL : config.DATABASE_URL;

  const client = new Client({
    connectionString,
    ssl: config.DB_SSL ? { rejectUnauthorized: true } : undefined,
    application_name: 'careflow-migrator',
  });

  await client.connect();

  try {
    // Serialise concurrent migrators. pg_advisory_lock blocks rather than failing, so a
    // second deployment task simply waits for the first to finish.
    logger.info('acquiring migration advisory lock');
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        name       TEXT        NOT NULL,
        checksum   TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        duration_ms INTEGER    NOT NULL
      )
    `);

    const applied = await client.query<{ version: string; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations',
    );
    const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row]));

    const migrations = await loadMigrations();
    let executed = 0;

    for (const migration of migrations) {
      const previous = appliedByVersion.get(migration.version);

      if (previous) {
        // An edited migration means the database and the repository disagree about history.
        // Failing loudly here prevents "works on my machine" schema drift.
        if (previous.checksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.version}_${migration.name} has been modified after being applied ` +
              `(recorded checksum ${previous.checksum.slice(0, 12)}, current ${migration.checksum.slice(0, 12)}). ` +
              'Never edit an applied migration; add a new one instead.',
          );
        }
        continue;
      }

      logger.info({ version: migration.version, name: migration.name }, 'applying migration');
      const startedAt = Date.now();

      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        const durationMs = Date.now() - startedAt;
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
          [migration.version, migration.name, migration.checksum, durationMs],
        );
        await client.query('COMMIT');

        executed += 1;
        logger.info({ version: migration.version, durationMs }, 'migration applied');
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error(
          { version: migration.version, err: error },
          'migration failed and was rolled back',
        );
        throw error;
      }
    }

    logger.info(
      { executed, total: migrations.length },
      executed === 0 ? 'schema already up to date' : 'migrations complete',
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {
      // The lock is released automatically when the session ends; nothing to do.
    });
    await client.end();
  }
};

// Executed directly by `npm run db:migrate` and by the one-shot ECS migration task.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isEntrypoint) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console -- the logger may not be constructible if config is invalid
      console.error(error);
      process.exit(1);
    });
}
