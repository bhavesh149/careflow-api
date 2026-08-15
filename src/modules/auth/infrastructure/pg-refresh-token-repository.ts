import { sql } from 'drizzle-orm';
import type { Database } from '@/shared/database/pool.js';
import { withTransaction } from '@/shared/database/unit-of-work.js';
import { parseNullableTimestamp, parseTimestamp } from '@/shared/database/rows.js';
import type { RefreshTokenRevokedReason } from '@/shared/database/schema.js';
import { authenticationRequired } from '@/shared/errors/app-error.js';
import type {
  RefreshTokenRepository,
  StoredRefreshToken,
} from '@/modules/auth/application/ports.js';

// Temporal columns arrive as Postgres strings from a raw query; see shared/database/rows.ts.
type TokenRow = {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: string;
  revokedAt: string | null;
};

export const createPgRefreshTokenRepository = (db: Database): RefreshTokenRepository => ({
  create: async ({ userId, familyId, tokenHash, expiresAt }): Promise<string> => {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
      VALUES (${userId}::uuid, ${familyId}::uuid, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz)
      RETURNING id
    `);

    const id = result.rows[0]?.id;
    if (!id) throw new Error('Failed to persist refresh token.');
    return id;
  },

  findByHash: async (tokenHash: string): Promise<StoredRefreshToken | undefined> => {
    const result = await db.execute<TokenRow>(sql`
      SELECT id,
             user_id    AS "userId",
             family_id  AS "familyId",
             expires_at AS "expiresAt",
             revoked_at AS "revokedAt"
        FROM refresh_tokens
       WHERE token_hash = ${tokenHash}
    `);

    const row = result.rows[0];
    if (!row) return undefined;

    return {
      id: row.id,
      userId: row.userId,
      familyId: row.familyId,
      expiresAt: parseTimestamp(row.expiresAt),
      revokedAt: parseNullableTimestamp(row.revokedAt),
    };
  },

  /**
   * Rotation must be atomic: revoking the old token and issuing its successor in separate
   * transactions risks a crash in between, which would either revoke the user's only token
   * (locking them out) or leave two usable tokens in the family (defeating reuse detection).
   *
   * The `revoked_at IS NULL` guard makes this a compare-and-swap. If two requests present the
   * same token concurrently, only one updates a row; the other sees zero rows and is rejected,
   * so a race cannot mint two live successors.
   */
  rotate: async ({ currentTokenId, userId, familyId, newTokenHash, expiresAt }): Promise<string> =>
    withTransaction(db, async (tx) => {
      const revoked = await tx.execute(sql`
        UPDATE refresh_tokens
           SET revoked_at = now(), revoked_reason = 'ROTATED', used_at = now()
         WHERE id = ${currentTokenId}::uuid
           AND revoked_at IS NULL
      `);

      if ((revoked.rowCount ?? 0) === 0) {
        throw authenticationRequired('The session is no longer valid.');
      }

      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
        VALUES (${userId}::uuid, ${familyId}::uuid, ${newTokenHash}, ${expiresAt.toISOString()}::timestamptz)
        RETURNING id
      `);

      const newId = inserted.rows[0]?.id;
      if (!newId) throw new Error('Failed to persist rotated refresh token.');

      // Chains the family together, which makes the token lineage auditable after a theft.
      await tx.execute(sql`
        UPDATE refresh_tokens SET replaced_by = ${newId}::uuid WHERE id = ${currentTokenId}::uuid
      `);

      return newId;
    }),

  revokeFamily: async (familyId: string, reason: RefreshTokenRevokedReason): Promise<number> => {
    const result = await db.execute(sql`
      UPDATE refresh_tokens
         SET revoked_at = now(), revoked_reason = ${reason}
       WHERE family_id = ${familyId}::uuid
         AND revoked_at IS NULL
    `);

    return result.rowCount ?? 0;
  },

  /** Housekeeping: expired tokens are dead weight and are removed by the sweeper. */
  deleteExpired: async (): Promise<number> => {
    const result = await db.execute(sql`
      DELETE FROM refresh_tokens
       WHERE expires_at < now() - interval '7 days'
    `);

    return result.rowCount ?? 0;
  },
});
