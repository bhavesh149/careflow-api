import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '@/shared/config/index.js';
import { AppError, authenticationRequired } from '@/shared/errors/app-error.js';
import type { UserRole } from '@/shared/database/schema.js';

/**
 * Access tokens (JWT) and refresh tokens (opaque).
 *
 * Why the split:
 *   * The access token is a short-lived signed JWT so that the three API tasks can
 *     authenticate a request without trusting client-supplied identity. Signature, issuer,
 *     audience and expiry are checked first. Session liveness (`sid`) is then checked so
 *     logout and reuse-detection take effect immediately, rather than leaving a stolen JWT
 *     valid until its clock runs out.
 *   * The refresh token is an opaque random string, NOT a JWT. It must be revocable, and
 *     revoking a stateless JWT requires a server-side denylist anyway — at which point the
 *     JWT format buys nothing and only invites someone to trust its claims without a lookup.
 *
 * Only a SHA-256 hash of the refresh token is persisted. SHA-256 rather than Argon2 because
 * the token is 256 bits of CSPRNG output, not a human-chosen password: there is no
 * dictionary to attack, so a slow hash would add latency to every refresh for no gain.
 */

export interface AccessTokenClaims {
  readonly sub: string;
  readonly role: UserRole;
  /** Present only for therapists: their therapist profile id. */
  readonly tid?: string;
  readonly sid: string;
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  readonly expiresAt: Date;
}

const encoder = new TextEncoder();

const secretKey = (config: AppConfig): Uint8Array => encoder.encode(config.JWT_SECRET);

export const signAccessToken = async (
  config: AppConfig,
  claims: AccessTokenClaims,
): Promise<{ token: string; expiresAt: Date }> => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAt + config.ACCESS_TOKEN_TTL_SECONDS;

  const payload: JWTPayload = {
    sub: claims.sub,
    role: claims.role,
    sid: claims.sid,
  };

  if (claims.tid !== undefined) {
    payload.tid = claims.tid;
  }

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(issuedAt)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setExpirationTime(expiresAtSeconds)
    .sign(secretKey(config));

  return { token, expiresAt: new Date(expiresAtSeconds * 1000) };
};

/**
 * Verifies signature, issuer, audience and expiry.
 *
 * `algorithms` is pinned explicitly. Omitting it is the classic JWT vulnerability: a library
 * that accepts whatever the token's own header claims can be handed `alg: none`, or tricked
 * into verifying an HMAC using a public key as the secret.
 */
export const verifyAccessToken = async (
  config: AppConfig,
  token: string,
): Promise<VerifiedAccessToken> => {
  try {
    const { payload } = await jwtVerify(token, secretKey(config), {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: 5,
    });

    const sub = payload.sub;
    const role = payload.role;
    const sid = payload.sid;

    if (
      typeof sub !== 'string' ||
      (role !== 'PATIENT' && role !== 'THERAPIST') ||
      typeof sid !== 'string'
    ) {
      throw authenticationRequired('Malformed access token.');
    }

    const therapistId = typeof payload.tid === 'string' ? payload.tid : undefined;

    return {
      sub,
      role,
      sid,
      ...(therapistId === undefined ? {} : { tid: therapistId }),
      expiresAt: new Date((payload.exp ?? 0) * 1000),
    };
  } catch (error) {
    if (AppError.isAppError(error)) {
      throw error;
    }
    // Never surface the underlying reason (expired vs bad signature vs wrong audience):
    // it tells an attacker which part of a forged token to fix next.
    throw authenticationRequired('The access token is invalid or has expired.');
  }
};

/** 256 bits of CSPRNG output, URL-safe so it can travel in a cookie without escaping. */
export const generateRefreshToken = (): string => randomBytes(32).toString('base64url');

export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Constant-time comparison, for the rare case where two hashes are compared in process. */
export const secureCompare = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};
