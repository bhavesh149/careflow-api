import { getConfig } from '@/shared/config/index.js';
import { createLogger } from '@/shared/logging/index.js';
import { createDatabase } from '@/shared/database/index.js';
import { createMetricsRegistry } from '@/shared/observability/index.js';
import {
  createShutdownController,
  installSignalHandlers,
} from '@/shared/http/graceful-shutdown.js';
import { purgeExpiredIdempotencyRecords } from '@/shared/idempotency/index.js';
import { runWorkerLoop, startWorkerHealthServer } from '@/workers/worker-runtime.js';
import { createHoldSweeper } from '@/workers/hold-sweeper/sweeper.js';

const WORKER_NAME = 'hold-sweeper';
const SWEEP_BATCH_SIZE = 200;
const PURGE_INTERVAL_MS = 15 * 60 * 1000;

const start = async (): Promise<void> => {
  const config = getConfig();
  const logger = createLogger(config).child({
    component: WORKER_NAME,
    instanceId: config.INSTANCE_ID,
  });

  const shutdown = createShutdownController({
    logger,
    drainDelayMs: 0,
    shutdownTimeoutMs: 15_000,
  });

  const database = createDatabase(config, logger);
  const metrics = createMetricsRegistry();

  const sweeper = createHoldSweeper({
    logger,
    db: database.db,
    metrics,
    batchSize: SWEEP_BATCH_SIZE,
  });

  let purgedAt = Date.now();

  const loop = runWorkerLoop({
    name: WORKER_NAME,
    logger,
    metrics,
    shutdown,
    intervalMs: config.HOLD_SWEEPER_INTERVAL_MS,
    tick: async () => {
      const hadWork = await sweeper.sweep();

      // Idempotency records are the other thing in this schema with a TTL, and this is the only
      // process already in the business of periodic cleanup. Without it the table grows by one
      // row per mutation forever, which eventually turns a fast unique-index lookup on the
      // booking hot path into a slow one.
      if (Date.now() - purgedAt > PURGE_INTERVAL_MS) {
        purgedAt = Date.now();
        const purged = await purgeExpiredIdempotencyRecords(database.db);
        if (purged > 0) logger.info({ purged }, 'purged expired idempotency records');
      }

      return hadWork;
    },
  });

  startWorkerHealthServer({
    config,
    logger,
    metrics,
    shutdown,
    name: WORKER_NAME,
    loop,
    stalenessThresholdMs: Math.max(config.HOLD_SWEEPER_INTERVAL_MS * 6, 60_000),
  });

  shutdown.register('postgres', async () => {
    await database.close();
  });

  installSignalHandlers(shutdown, logger);

  logger.info(
    { intervalMs: config.HOLD_SWEEPER_INTERVAL_MS, batchSize: SWEEP_BATCH_SIZE },
    'hold sweeper started',
  );

  await loop.done;
};

start().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start the hold sweeper:', error);
  process.exit(1);
});
