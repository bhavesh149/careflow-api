import { createServer, type Server } from 'node:http';
import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import type { MetricsRegistry } from '@/shared/observability/index.js';
import type { ShutdownController } from '@/shared/http/graceful-shutdown.js';

/**
 * Shared runtime for the three background workers.
 *
 * Every worker is its own process (and its own container/ECS task) rather than a thread inside
 * the API. That costs a little memory and buys a lot: the sweeper cannot slow down a booking
 * request, a crash-looping consumer does not take the API down with it, and each one scales on
 * its own signal — the publisher on queue backlog, the API on request latency. It also means the
 * local Compose stack has the same process topology as production, so "works locally" means
 * something.
 *
 * This module owns the parts every worker needs and none of them should reinvent:
 *
 *   * a poll loop that never overlaps its own iterations,
 *   * backoff when an iteration fails, so a database outage does not become a hot loop,
 *   * a health endpoint ECS can probe, which reports *staleness* rather than mere liveness,
 *   * shutdown that lets the current iteration finish before the process exits.
 */

export interface WorkerLoopOptions {
  readonly name: string;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  readonly shutdown: ShutdownController;
  /** Idle wait between iterations. Ignored when an iteration reports it did work. */
  readonly intervalMs: number;
  /**
   * One unit of work. Returning `true` means "there was more to do", which suppresses the idle
   * wait so a backlog drains at full speed instead of one batch per interval.
   */
  readonly tick: () => Promise<boolean>;
}

export interface WorkerLoop {
  /** Resolves when the loop has stopped, after shutdown. */
  readonly done: Promise<void>;
  readonly lastSuccessAt: () => number;
  readonly consecutiveFailures: () => number;
}

const MAX_BACKOFF_MS = 30_000;

export const runWorkerLoop = (options: WorkerLoopOptions): WorkerLoop => {
  const { name, logger, shutdown, intervalMs, tick } = options;

  let lastSuccessAt = Date.now();
  let consecutiveFailures = 0;
  let sleepTimer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;

  /** Interruptible sleep: shutdown wakes it immediately instead of waiting out the interval. */
  const sleep = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      wake = resolve;
      sleepTimer = setTimeout(resolve, ms);
    });
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = undefined;
    wake = undefined;
  };

  const loop = async (): Promise<void> => {
    logger.info({ worker: name, intervalMs }, 'worker loop started');

    while (!shutdown.isDraining()) {
      try {
        const hadWork = await tick();
        lastSuccessAt = Date.now();
        consecutiveFailures = 0;

        if (shutdown.isDraining()) break;
        // Only idle when there was nothing to do. A full batch means more is waiting.
        if (!hadWork) await sleep(intervalMs);
      } catch (error) {
        consecutiveFailures += 1;

        // Exponential backoff, capped. Without it, an unreachable database turns this loop into
        // a busy-wait that saturates a CPU and floods the logs with the same error.
        const backoffMs = Math.min(intervalMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);

        logger.error(
          { err: error, worker: name, consecutiveFailures, backoffMs },
          'worker iteration failed; backing off',
        );

        if (shutdown.isDraining()) break;
        await sleep(backoffMs);
      }
    }

    logger.info({ worker: name }, 'worker loop stopped');
  };

  const done = loop();

  // Registered so shutdown waits for the in-flight iteration. Cutting a worker off mid-batch is
  // survivable (the outbox and queue both redeliver) but it produces avoidable duplicate work.
  shutdown.register(`worker-loop:${name}`, async () => {
    wake?.();
    await done;
  });

  return {
    done,
    lastSuccessAt: () => lastSuccessAt,
    consecutiveFailures: () => consecutiveFailures,
  };
};

export interface WorkerHealthOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  readonly shutdown: ShutdownController;
  readonly name: string;
  readonly loop: WorkerLoop;
  /**
   * How long the loop may go without a successful iteration before the worker is called
   * unhealthy. Must exceed the poll interval with room to spare, or normal idling looks like
   * failure.
   */
  readonly stalenessThresholdMs: number;
}

/**
 * A minimal HTTP health endpoint per worker.
 *
 * Workers have no traffic of their own, so without this a wedged worker looks identical to a
 * healthy idle one: the process is up, the container is running, and events quietly stop
 * flowing. Reporting the age of the last successful iteration turns that silent failure into a
 * failing ECS health check and a container replacement.
 *
 * `/metrics` is served here too so the worker's counters are scrapeable exactly like the API's.
 */
export const startWorkerHealthServer = (options: WorkerHealthOptions): Server => {
  const { config, logger, metrics, shutdown, name, loop, stalenessThresholdMs } = options;

  const server = createServer((request, response) => {
    const url = request.url ?? '/';

    if (url.startsWith('/metrics')) {
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      response.end(metrics.render());
      return;
    }

    const staleness = Date.now() - loop.lastSuccessAt();
    const draining = shutdown.isDraining();
    const healthy = !draining && staleness < stalenessThresholdMs;

    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: healthy ? 'healthy' : draining ? 'draining' : 'stale',
        worker: name,
        instanceId: config.INSTANCE_ID,
        lastSuccessAgeMs: staleness,
        consecutiveFailures: loop.consecutiveFailures(),
      }),
    );
  });

  server.listen(config.WORKER_HEALTH_PORT, config.HOST, () => {
    logger.info(
      { worker: name, port: config.WORKER_HEALTH_PORT },
      'worker health endpoint listening',
    );
  });

  shutdown.register(`health-server:${name}`, async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  return server;
};
