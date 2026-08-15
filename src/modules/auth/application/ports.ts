import type { User, UserCredentials } from '@/modules/auth/domain/user.js';
import type { RefreshTokenRevokedReason } from '@/shared/database/schema.js';

/**
 * Ports the auth use cases depend on. Infrastructure implements these; the application layer
 * never learns that the store is Postgres.
 */

export interface UserRepository {
  findCredentialsByEmail(email: string): Promise<UserCredentials | undefined>;
  findById(userId: string): Promise<User | undefined>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
}

export interface StoredRefreshToken {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface RefreshTokenRepository {
  /** Starts a new family (a fresh login). */
  create(input: {
    userId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<string>;

  findByHash(tokenHash: string): Promise<StoredRefreshToken | undefined>;

  /**
   * Atomically rotates: marks the presented token used/revoked and inserts its successor.
   * Must be one transaction, or a crash between the two steps would either lock the user out
   * or leave two live tokens in the family.
   */
  rotate(input: {
    currentTokenId: string;
    userId: string;
    familyId: string;
    newTokenHash: string;
    expiresAt: Date;
  }): Promise<string>;

  /** Revokes every token in a family. Used on logout and on reuse detection. */
  revokeFamily(familyId: string, reason: RefreshTokenRevokedReason): Promise<number>;

  deleteExpired(): Promise<number>;
}
