import { composeApp, type ComposedApp } from '@/composition.js';
import { createLogger } from '@/shared/logging/index.js';
import { getConfig } from '@/shared/config/index.js';

/**
 * Builds the real application against the throwaway database.
 *
 * Rate limits are raised so the suite is testing booking behaviour, not the login throttle.
 * Production values stay the defaults and are asserted by a dedicated test that restores them.
 */
export const startTestApp = async (
  overrides: Partial<ComposedApp['config']> = {},
): Promise<ComposedApp> => {
  const config = getConfig();

  return composeApp({
    configOverrides: {
      REDIS_ENABLED: false,
      QUEUE_DRIVER: 'noop',
      SWAGGER_ENABLED: false,
      COOKIE_SECURE: false,
      RATE_LIMIT_LOGIN_MAX: 1_000,
      RATE_LIMIT_GLOBAL_MAX: 10_000,
      RATE_LIMIT_MUTATION_MAX: 1_000,
      DB_POOL_MAX: 20,
      LOG_LEVEL: 'silent',
      ...overrides,
    },
    logger: createLogger({ ...config, LOG_LEVEL: 'silent' }),
  });
};
