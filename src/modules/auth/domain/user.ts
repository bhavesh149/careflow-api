import type { UserRole, UserStatus } from '@/shared/domain/vocabulary.js';

/**
 * The authenticated account.
 *
 * Note what is absent: no password hash. The hash is needed only inside the credential
 * verification step and is deliberately kept out of the entity so it cannot be
 * accidentally serialised into a response or a log line.
 */
export interface User {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly fullName: string;
  readonly status: UserStatus;
  /** Present only for therapists. */
  readonly therapistId?: string;
}

/** Credentials, used only by the login use case and never returned from it. */
export interface UserCredentials {
  readonly userId: string;
  readonly passwordHash: string;
  readonly status: UserStatus;
  readonly role: UserRole;
  readonly therapistId?: string;
}

export const isActive = (user: Pick<User, 'status'>): boolean => user.status === 'ACTIVE';

/**
 * Emails are normalised at every boundary so that "A@x.com" and "a@x.com" are one account.
 * The database enforces the same rule with a CHECK constraint, so a path that forgets to
 * normalise fails loudly instead of quietly creating a duplicate identity.
 */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
