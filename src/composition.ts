import type { AppConfig } from '@/shared/config/index.js';
import { getConfig } from '@/shared/config/index.js';
import { createLogger, type Logger } from '@/shared/logging/index.js';
import { createDatabase, type DatabaseHandle } from '@/shared/database/index.js';
import { createCacheClient, type CacheClient } from '@/shared/cache/index.js';
import { createMetricsRegistry, type MetricsRegistry } from '@/shared/observability/index.js';
import {
  createShutdownController,
  type ShutdownController,
} from '@/shared/http/graceful-shutdown.js';
import { buildApp } from '@/app.js';
import type { CareflowApp } from '@/shared/http/types.js';
import { createAuthService } from '@/modules/auth/application/auth-service.js';
import { createPgUserRepository } from '@/modules/auth/infrastructure/pg-user-repository.js';
import { createPgRefreshTokenRepository } from '@/modules/auth/infrastructure/pg-refresh-token-repository.js';
import { createPgScheduleRepository } from '@/modules/scheduling/infrastructure/pg-schedule-repository.js';
import { createPgTherapistDirectory } from '@/modules/scheduling/infrastructure/pg-therapist-directory.js';
import { createScheduleService } from '@/modules/scheduling/application/schedule-service.js';
import { createAvailabilityService } from '@/modules/availability/application/availability-service.js';
import { createHoldService } from '@/modules/booking/application/hold-service.js';
import { createBookingService } from '@/modules/booking/application/booking-service.js';
import { createRecurringSeriesService } from '@/modules/booking/application/recurring-series-service.js';

/**
 * Wires concrete adapters to the application services and hands the result to `buildApp`.
 *
 * This exists in one place because three callers need the identical object graph: the API
 * entrypoint, the OpenAPI exporter, and the integration/E2E suites. When that wiring was copied
 * per caller, a new dependency meant remembering all three, and the suites were the one most
 * likely to be forgotten — meaning the tests would exercise an application shaped differently
 * from the deployed one.
 *
 * No I/O happens here. The pool is created but not connected, so this is safe to call in CI
 * without infrastructure; the entrypoint pings the database separately before it starts listening.
 */
export interface ComposedApp {
  readonly app: CareflowApp;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly database: DatabaseHandle;
  readonly cache: CacheClient;
  readonly metrics: MetricsRegistry;
  readonly shutdown: ShutdownController;
  /** Closes the HTTP server, then Redis, then the pool — the reverse of construction order. */
  readonly close: () => Promise<void>;
}

export interface ComposeOptions {
  /** Overrides merged over the parsed environment; used by the exporter and by tests. */
  readonly configOverrides?: Partial<AppConfig>;
  readonly logger?: Logger;
}

export const composeApp = async (options: ComposeOptions = {}): Promise<ComposedApp> => {
  const config: AppConfig = { ...getConfig(), ...options.configOverrides };
  const logger = options.logger ?? createLogger(config).child({ instanceId: config.INSTANCE_ID });

  const shutdown = createShutdownController({
    logger,
    // Must exceed the load balancer's deregistration delay, otherwise the listener closes while
    // the ALB is still forwarding connections and clients see 502s during every deploy.
    drainDelayMs: config.NODE_ENV === 'production' ? 15_000 : 500,
    shutdownTimeoutMs: 30_000,
  });

  const database = createDatabase(config, logger);
  const { db, pool } = database;
  const cache = createCacheClient(config, logger);
  const metrics = createMetricsRegistry();

  const schedules = createPgScheduleRepository(db);

  const app = await buildApp({
    config,
    logger,
    db,
    pool,
    cache,
    metrics,
    shutdown,
    authService: createAuthService({
      config,
      logger,
      users: createPgUserRepository(db),
      refreshTokens: createPgRefreshTokenRepository(db),
    }),
    scheduleService: createScheduleService({ config, logger, db, cache, schedules }),
    therapistDirectory: createPgTherapistDirectory(db),
    availabilityService: createAvailabilityService({ config, db, schedules }),
    holdService: createHoldService({ config, logger, db, metrics, schedules }),
    bookingService: createBookingService({ config, logger, db, metrics }),
    recurringSeriesService: createRecurringSeriesService({
      config,
      logger,
      db,
      metrics,
      schedules,
    }),
  });

  const close = async (): Promise<void> => {
    await app.close();
    await cache.close();
    await database.close();
  };

  return { app, config, logger, database, cache, metrics, shutdown, close };
};
