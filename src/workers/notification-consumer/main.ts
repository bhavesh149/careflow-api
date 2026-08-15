import { getConfig } from '@/shared/config/index.js';
import { createLogger } from '@/shared/logging/index.js';
import { createDatabase } from '@/shared/database/index.js';
import { createMetricsRegistry } from '@/shared/observability/index.js';
import {
  createShutdownController,
  installSignalHandlers,
} from '@/shared/http/graceful-shutdown.js';
import { createQueuePublisher } from '@/shared/events/index.js';
import { runWorkerLoop, startWorkerHealthServer } from '@/workers/worker-runtime.js';
import {
  createNotificationConsumer,
  pruneProcessedMessages,
} from '@/workers/notification-consumer/consumer.js';
import { createLoggingNotificationSender } from '@/workers/notification-consumer/notification-sender.js';

const WORKER_NAME = 'notification-consumer';
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const start = async (): Promise<void> => {
  const config = getConfig();
  const logger = createLogger(config).child({
    component: WORKER_NAME,
    instanceId: config.INSTANCE_ID,
  });

  const shutdown = createShutdownController({
    logger,
    drainDelayMs: 0,
    // Longer than the other workers: an iteration can be parked in a 20-second long poll, and
    // the timeout must not fire while a message is mid-flight.
    shutdownTimeoutMs: 40_000,
  });

  const database = createDatabase(config, logger);
  const metrics = createMetricsRegistry();
  const queue = createQueuePublisher(config, logger);
  const sender = createLoggingNotificationSender(logger);

  const consumer = createNotificationConsumer({
    config,
    logger,
    db: database.db,
    metrics,
    queue,
    sender,
  });

  let prunedAt = Date.now();

  const loop = runWorkerLoop({
    name: WORKER_NAME,
    logger,
    metrics,
    shutdown,
    // Long polling already provides the wait, so this only applies after an error.
    intervalMs: 1_000,
    tick: async () => {
      const hadWork = await consumer.consumeBatch();

      // Housekeeping rides along on the consumer loop rather than a fourth container: it runs
      // hourly, takes milliseconds, and does not justify its own task definition.
      if (Date.now() - prunedAt > PRUNE_INTERVAL_MS) {
        prunedAt = Date.now();
        const pruned = await pruneProcessedMessages(database.db);
        if (pruned > 0) logger.info({ pruned }, 'pruned expired deduplication records');
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
    // A completed long poll counts as a successful iteration, so a healthy consumer reports in
    // at least every 20 seconds even with an empty queue.
    stalenessThresholdMs: (config.SQS_WAIT_TIME_SECONDS + 40) * 1_000,
  });

  shutdown.register('queue', async () => {
    await queue.close();
  });
  shutdown.register('postgres', async () => {
    await database.close();
  });

  installSignalHandlers(shutdown, logger);

  logger.info(
    { queueDriver: config.QUEUE_DRIVER, waitTimeSeconds: config.SQS_WAIT_TIME_SECONDS },
    'notification consumer started',
  );

  await loop.done;
};

start().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start the notification consumer:', error);
  process.exit(1);
});
