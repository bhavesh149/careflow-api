import { getConfig } from '@/shared/config/index.js';
import { createLogger } from '@/shared/logging/index.js';
import { createDatabase } from '@/shared/database/index.js';
import { createMetricsRegistry, Metric } from '@/shared/observability/index.js';
import {
  createShutdownController,
  installSignalHandlers,
} from '@/shared/http/graceful-shutdown.js';
import { countPendingOutboxEvents, createQueuePublisher } from '@/shared/events/index.js';
import { runWorkerLoop, startWorkerHealthServer } from '@/workers/worker-runtime.js';
import { createOutboxPublisher } from '@/workers/outbox-publisher/publisher.js';

const WORKER_NAME = 'outbox-publisher';

const start = async (): Promise<void> => {
  const config = getConfig();
  const logger = createLogger(config).child({
    component: WORKER_NAME,
    instanceId: config.INSTANCE_ID,
  });

  const shutdown = createShutdownController({
    logger,
    // No load balancer in front of a worker, so there is nothing to deregister from. Exit as
    // soon as the current batch is done.
    drainDelayMs: 0,
    shutdownTimeoutMs: 20_000,
  });

  const database = createDatabase(config, logger);
  const metrics = createMetricsRegistry();
  const queue = createQueuePublisher(config, logger);
  const publisher = createOutboxPublisher({ config, logger, db: database.db, metrics, queue });

  // Backlog depth is the signal this worker is scaled on and alarmed on: a rising value means
  // notifications are falling behind even though every API request is succeeding.
  //
  // Sampled on a timer rather than read at scrape time, because a `count(*)` triggered by
  // whoever happens to be scraping is an easy way to give the database an unpredictable load.
  metrics.registerGauge(Metric.OUTBOX_PENDING, 'Outbox events awaiting publication.');

  const BACKLOG_SAMPLE_INTERVAL_MS = 15_000;
  let backlogSampledAt = 0;

  const loop = runWorkerLoop({
    name: WORKER_NAME,
    logger,
    metrics,
    shutdown,
    intervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    tick: async () => {
      const hadWork = await publisher.publishBatch();

      if (Date.now() - backlogSampledAt > BACKLOG_SAMPLE_INTERVAL_MS) {
        backlogSampledAt = Date.now();
        metrics.setGauge(Metric.OUTBOX_PENDING, await countPendingOutboxEvents(database.db));
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
    // Generous relative to the poll interval: a healthy worker touches this every second, so
    // half a minute of silence is a real stall rather than a slow batch.
    stalenessThresholdMs: Math.max(config.OUTBOX_POLL_INTERVAL_MS * 10, 30_000),
  });

  shutdown.register('queue', async () => {
    await queue.close();
  });
  shutdown.register('postgres', async () => {
    await database.close();
  });

  installSignalHandlers(shutdown, logger);

  logger.info(
    {
      pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
      batchSize: config.OUTBOX_BATCH_SIZE,
      maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
      queueDriver: config.QUEUE_DRIVER,
    },
    'outbox publisher started',
  );

  await loop.done;
};

start().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start the outbox publisher:', error);
  process.exit(1);
});
