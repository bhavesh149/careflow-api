import { sql } from 'drizzle-orm';
import type { Database } from '@/shared/database/pool.js';
import type { TherapistDirectory } from '@/modules/scheduling/application/ports.js';

/**
 * Therapist listing.
 *
 * Only the professional profile is exposed — display name and specialization. The therapist's
 * user row holds an email address, and joining it in "because it might be useful" is how contact
 * details end up in a public list. A patient does not need it to book.
 */
export const createPgTherapistDirectory = (db: Database): TherapistDirectory => ({
  list: async ({ limit, offset }) => {
    // Drizzle's `execute<T>` requires an index signature, which an interface does not carry, so
    // the row shape is spelled out as a local type alias.
    const rows = await db.execute<{
      id: string;
      displayName: string;
      specialization: string | null;
    }>(sql`
      SELECT id,
             display_name   AS "displayName",
             specialization
        FROM therapists
       ORDER BY display_name
       LIMIT ${limit} OFFSET ${offset}
    `);

    const totalResult = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM therapists`,
    );

    return {
      therapists: [...rows.rows],
      total: Number(totalResult.rows[0]?.count ?? '0'),
    };
  },
});
