import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import {
  authenticationRequired,
  forbidden,
  invalidCredentials,
} from '@/shared/errors/app-error.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  needsRehash,
  performDummyVerification,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
  hashPassword,
} from '@/shared/security/index.js';
import { normalizeEmail, type User } from '@/modules/auth/domain/user.js';
import type { RefreshTokenRepository, UserRepository } from '@/modules/auth/application/ports.js';
import type { CacheClient } from '@/shared/cache/index.js';

export interface SessionTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

export interface LoginResult extends SessionTokens {
  readonly user: User;
}

export interface AuthService {
  login(email: string, password: string): Promise<LoginResult>;
  refresh(presentedToken: string): Promise<LoginResult>;
  logout(presentedToken: string | undefined, accessToken?: string): Promise<void>;
  /** False after logout / reuse detection, even if the JWT has not yet expired. */
  isSessionActive(sessionId: string): Promise<boolean>;
  getCurrentUser(userId: string): Promise<User>;
}

const revokedSessionKey = (sessionId: string): string => `auth:revoked:${sessionId}`;

export const createAuthService = (dependencies: {
  config: AppConfig;
  logger: Logger;
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  cache: CacheClient;
}): AuthService => {
  const { config, logger, users, refreshTokens, cache } = dependencies;

  const revokeSession = async (
    familyId: string,
    reason: 'LOGOUT' | 'REUSE_DETECTED',
  ): Promise<number> => {
    const revoked = await refreshTokens.revokeFamily(familyId, reason);
    await cache.set(revokedSessionKey(familyId), '1', config.ACCESS_TOKEN_TTL_SECONDS);
    return revoked;
  };

  const issueSession = async (
    user: User,
    familyId: string,
    rotateFrom?: { tokenId: string },
  ): Promise<SessionTokens> => {
    const sessionId = familyId;
    const refreshToken = generateRefreshToken();
    const refreshTokenExpiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_SECONDS * 1000);
    const tokenHash = hashRefreshToken(refreshToken);

    if (rotateFrom) {
      await refreshTokens.rotate({
        currentTokenId: rotateFrom.tokenId,
        userId: user.id,
        familyId,
        newTokenHash: tokenHash,
        expiresAt: refreshTokenExpiresAt,
      });
    } else {
      await refreshTokens.create({
        userId: user.id,
        familyId,
        tokenHash,
        expiresAt: refreshTokenExpiresAt,
      });
    }

    const { token: accessToken, expiresAt: accessTokenExpiresAt } = await signAccessToken(config, {
      sub: user.id,
      role: user.role,
      sid: sessionId,
      ...(user.therapistId === undefined ? {} : { tid: user.therapistId }),
    });

    return { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt };
  };

  const loadUser = async (userId: string): Promise<User> => {
    const user = await users.findById(userId);

    if (!user) {
      throw authenticationRequired('The account no longer exists.');
    }

    // Re-checked on every refresh, not just at login: a disabled account must lose access
    // within one access-token lifetime rather than whenever its refresh token happens to expire.
    if (user.status !== 'ACTIVE') {
      throw forbidden('This account has been disabled.');
    }

    return user;
  };

  return {
    login: async (email, password) => {
      const normalizedEmail = normalizeEmail(email);
      const credentials = await users.findCredentialsByEmail(normalizedEmail);

      if (!credentials) {
        // Spend comparable CPU to a real verification so response time does not reveal
        // whether the account exists.
        await performDummyVerification();
        throw invalidCredentials();
      }

      const passwordMatches = await verifyPassword(credentials.passwordHash, password);
      if (!passwordMatches) {
        throw invalidCredentials();
      }

      // Identical error to a bad password: whether an account exists but is disabled is not
      // information an unauthenticated caller should be able to extract.
      if (credentials.status !== 'ACTIVE') {
        throw invalidCredentials();
      }

      // Transparent upgrade when hashing parameters are strengthened later.
      if (needsRehash(credentials.passwordHash)) {
        const upgraded = await hashPassword(password);
        await users.updatePasswordHash(credentials.userId, upgraded).catch((error: unknown) => {
          // A failed rehash must not fail the login; the old hash is still valid.
          logger.warn({ err: error, userId: credentials.userId }, 'password rehash failed');
        });
      }

      const user = await loadUser(credentials.userId);
      // Each login starts its own family, so signing out on a phone does not sign out a laptop.
      const tokens = await issueSession(user, randomUUID());

      logger.info({ userId: user.id, role: user.role, event: 'login.success' }, 'login succeeded');

      return { ...tokens, user };
    },

    /**
     * Refresh with rotation and reuse detection.
     *
     * A refresh token is single-use. Presenting one that has already been rotated means two
     * parties hold it, which in practice means one of them stole it. We cannot tell which is
     * legitimate, so the entire family is revoked and both must re-authenticate. Allowing the
     * replay instead would hand an attacker indefinite access.
     */
    refresh: async (presentedToken) => {
      if (presentedToken.length === 0) {
        throw authenticationRequired('A refresh token is required.');
      }

      const stored = await refreshTokens.findByHash(hashRefreshToken(presentedToken));

      if (!stored) {
        throw authenticationRequired('The session is no longer valid.');
      }

      if (stored.revokedAt !== null) {
        await revokeSession(stored.familyId, 'REUSE_DETECTED');
        logger.warn(
          { userId: stored.userId, familyId: stored.familyId, event: 'refresh.reuse_detected' },
          'revoked refresh token replayed; family revoked',
        );
        throw authenticationRequired('The session is no longer valid.');
      }

      if (stored.expiresAt.getTime() <= Date.now()) {
        throw authenticationRequired('The session has expired.');
      }

      const user = await loadUser(stored.userId);
      const tokens = await issueSession(user, stored.familyId, { tokenId: stored.id });

      logger.info({ userId: user.id, event: 'refresh.success' }, 'session refreshed');

      return { ...tokens, user };
    },

    /**
     * Logout revokes the whole family rather than just the presented token, so the session
     * cannot be resurrected by a token issued earlier in the same chain.
     *
     * Always resolves: a client clearing its cookie must not be blocked by an unknown token.
     * The matching access token is refused immediately via `isSessionActive`, not left valid
     * until its 15-minute JWT expiry.
     */
    logout: async (presentedToken, accessToken) => {
      let familyId: string | undefined;
      let userId: string | undefined;

      if (presentedToken !== undefined && presentedToken.length > 0) {
        const stored = await refreshTokens.findByHash(hashRefreshToken(presentedToken));
        familyId = stored?.familyId;
        userId = stored?.userId;
      }

      if (familyId === undefined && accessToken !== undefined && accessToken.length > 0) {
        try {
          const claims = await verifyAccessToken(config, accessToken);
          familyId = claims.sid;
          userId = claims.sub;
        } catch {
          // Expired or malformed access tokens must not block logout.
        }
      }

      if (familyId === undefined) {
        return;
      }

      const revoked = await revokeSession(familyId, 'LOGOUT');
      logger.info({ userId, familyId, revoked, event: 'logout' }, 'session revoked');
    },

    isSessionActive: async (sessionId) => {
      if (await cache.get(revokedSessionKey(sessionId))) {
        return false;
      }

      const active = await refreshTokens.isFamilyActive(sessionId);
      if (!active) {
        await cache.set(revokedSessionKey(sessionId), '1', config.ACCESS_TOKEN_TTL_SECONDS);
      }
      return active;
    },

    getCurrentUser: loadUser,
  };
};
