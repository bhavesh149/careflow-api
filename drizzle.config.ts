import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit is used for schema diffing and introspection only. The migrations that
 * actually run are the reviewed `.sql` files in `migrations/`, applied by our own
 * runner, because the booking invariants rely on GiST exclusion constraints and
 * partial indexes that a schema differ cannot be trusted to author correctly.
 */
export default defineConfig({
  schema: './src/shared/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://careflow_app:careflow_local_pw@localhost:5432/careflow',
  },
  verbose: true,
  strict: true,
});
