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
  verifyPassword,
  hashPassword,
} from '@/shared/security/index.js';
import { normalizeEmail, type User } from '@/modules/auth/domain/user.js';
import type { RefreshTokenRepository, UserRepository } from '@/modules/auth/application/ports.js';

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
  logout(presentedToken: string | undefined): Promise<void>;
  getCurrentUser(userId: string): Promise<User>;
}

export const createAuthService = (dependencies: {
  config: AppConfig;
  logger: Logger;
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
}): AuthService => {
  const { config, logger, users, refreshTokens } = dependencies;

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
        await refreshTokens.revokeFamily(stored.familyId, 'REUSE_DETECTED');
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
     */
    logout: async (presentedToken) => {
      if (presentedToken === undefined || presentedToken.length === 0) {
        return;
      }

      const stored = await refreshTokens.findByHash(hashRefreshToken(presentedToken));
      if (!stored) {
        return;
      }

      const revoked = await refreshTokens.revokeFamily(stored.familyId, 'LOGOUT');
      logger.info({ userId: stored.userId, revoked, event: 'logout' }, 'session revoked');
    },

    getCurrentUser: loadUser,
  };
};
