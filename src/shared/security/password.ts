import argon2 from 'argon2';

/**
 * Password hashing with Argon2id.
 *
 * Argon2id over bcrypt: it is the OWASP first choice and, unlike bcrypt, is deliberately
 * memory-hard, which is what makes GPU and ASIC cracking expensive rather than merely slow.
 * Bcrypt also silently truncates input at 72 bytes.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum (19 MiB, 2 iterations,
 * 1 degree of parallelism). They are tuned for a 0.5 vCPU Fargate task: raising memoryCost
 * further would make a burst of logins compete with request handling for RAM.
 *
 * The parameters are embedded in the resulting hash string, so these values can be
 * increased later and old hashes will continue to verify — `needsRehash` detects them.
 */
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = async (plaintext: string): Promise<string> =>
  argon2.hash(plaintext, HASH_OPTIONS);

/**
 * Verifies a password. Never throws for a wrong password; a malformed or truncated stored
 * hash also yields `false` rather than a 500, so a single corrupt row cannot turn the login
 * endpoint into an error page.
 */
export const verifyPassword = async (hash: string, plaintext: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
};

/** True when a stored hash was produced with weaker parameters than we now require. */
export const needsRehash = (hash: string): boolean => {
  try {
    return argon2.needsRehash(hash, HASH_OPTIONS);
  } catch {
    return false;
  }
};

/**
 * Burns roughly the same CPU as a real verification.
 *
 * Called when the email does not exist, so that "unknown account" and "wrong password" take
 * comparable time. Without this the response latency is a reliable account-enumeration
 * oracle no matter how carefully the error messages are worded.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHlzYWx0eXNhbHR5c2E$3jZ5vX8Qm1Yh2kFqPzL4tVn6wB7cD8eG9hJ0kM1nO2p';

export const performDummyVerification = async (): Promise<void> => {
  await verifyPassword(DUMMY_HASH, 'not-a-real-password');
};
