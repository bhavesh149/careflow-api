import { sql } from 'drizzle-orm';
import type { Database } from '@/shared/database/pool.js';
import type { UserRole, UserStatus } from '@/shared/database/schema.js';
import type { UserRepository } from '@/modules/auth/application/ports.js';
import type { User, UserCredentials } from '@/modules/auth/domain/user.js';

type CredentialsRow = {
  userId: string;
  passwordHash: string;
  status: UserStatus;
  role: UserRole;
  therapistId: string | null;
};

type UserRowWithProfile = {
  id: string;
  email: string;
  role: UserRole;
  fullName: string;
  status: UserStatus;
  therapistId: string | null;
};

export const createPgUserRepository = (db: Database): UserRepository => ({
  /**
   * One query, joining the therapist profile, so login does not need a second round trip to
   * discover whether the account has one. LEFT JOIN because patients legitimately do not.
   */
  findCredentialsByEmail: async (email: string): Promise<UserCredentials | undefined> => {
    const result = await db.execute<CredentialsRow>(sql`
      SELECT u.id            AS "userId",
             u.password_hash AS "passwordHash",
             u.status,
             u.role,
             t.id            AS "therapistId"
        FROM users u
        LEFT JOIN therapists t ON t.user_id = u.id
       WHERE u.email = ${email}
    `);

    const row = result.rows[0];
    if (!row) return undefined;

    return {
      userId: row.userId,
      passwordHash: row.passwordHash,
      status: row.status,
      role: row.role,
      ...(row.therapistId === null ? {} : { therapistId: row.therapistId }),
    };
  },

  findById: async (userId: string): Promise<User | undefined> => {
    const result = await db.execute<UserRowWithProfile>(sql`
      SELECT u.id,
             u.email,
             u.role,
             u.full_name AS "fullName",
             u.status,
             t.id        AS "therapistId"
        FROM users u
        LEFT JOIN therapists t ON t.user_id = u.id
       WHERE u.id = ${userId}::uuid
    `);

    const row = result.rows[0];
    if (!row) return undefined;

    return {
      id: row.id,
      email: row.email,
      role: row.role,
      fullName: row.fullName,
      status: row.status,
      ...(row.therapistId === null ? {} : { therapistId: row.therapistId }),
    };
  },

  updatePasswordHash: async (userId: string, passwordHash: string): Promise<void> => {
    await db.execute(sql`
      UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userId}::uuid
    `);
  },
});
