import type { Logger } from '@/shared/logging/index.js';

/**
 * Graceful shutdown.
 *
 * This is what makes a rolling ECS deployment invisible to users. The sequence when SIGTERM
 * arrives is:
 *
 *   1. Mark the process as draining, so /ready starts failing. The ALB notices and stops
 *      routing new requests to this task, while in-flight ones continue.
 *   2. Wait out the load balancer's deregistration delay. Skipping this is the classic cause
 *      of "random 502s during deploy": the task closes its listener while the ALB is still
 *      sending it connections.
 *   3. Close the HTTP server, letting in-flight requests finish.
 *   4. Release resources — database pool, Redis — so no connection is left dangling on RDS.
 *
 * A hard timeout backs the whole thing: if a request hangs, the process still exits rather
 * than blocking the deployment until ECS kills it.
 */

export type ShutdownTask = () => Promise<void>;

export interface ShutdownOptions {
  readonly logger: Logger;
  /** Time to keep serving after SIGTERM so the load balancer can deregister this task. */
  readonly drainDelayMs?: number;
  /** Absolute deadline before the process force-exits. */
  readonly shutdownTimeoutMs?: number;
}

export interface ShutdownController {
  readonly isDraining: () => boolean;
  register(name: string, task: ShutdownTask): void;
  /** Exposed for tests; production triggers this via signals. */
  shutdown(reason: string): Promise<void>;
}

export const createShutdownController = (options: ShutdownOptions): ShutdownController => {
  const { logger } = options;
  const drainDelayMs = options.drainDelayMs ?? 5_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 25_000;

  const tasks: { name: string; task: ShutdownTask }[] = [];
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;

  const runShutdown = async (reason: string): Promise<void> => {
    draining = true;
    logger.info({ reason, drainDelayMs }, 'shutdown initiated; failing readiness checks');

    // Give the load balancer time to take this task out of rotation before we stop listening.
    if (drainDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, drainDelayMs));
    }

    // Reverse order: the HTTP server registers first and must close before the resources it
    // depends on, otherwise an in-flight request finds the pool already gone.
    for (const { name, task } of [...tasks].reverse()) {
      try {
        logger.info({ task: name }, 'closing');
        await task();
      } catch (error) {
        logger.error({ err: error, task: name }, 'error while closing; continuing shutdown');
      }
    }

    logger.info('shutdown complete');
  };

  const shutdown = async (reason: string): Promise<void> => {
    // A second SIGTERM must not start a parallel shutdown.
    shutdownPromise ??= (async () => {
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          logger.error({ shutdownTimeoutMs }, 'graceful shutdown timed out; forcing exit');
          resolve();
        }, shutdownTimeoutMs);
        // Do not let this timer alone keep the event loop alive.
        timer.unref();
      });

      await Promise.race([runShutdown(reason), timeout]);
    })();

    return shutdownPromise;
  };

  return {
    isDraining: () => draining,
    register: (name, task) => {
      tasks.push({ name, task });
    },
    shutdown,
  };
};

/**
 * Wires process signals to the controller.
 *
 * `unhandledRejection` and `uncaughtException` intentionally shut the process down instead of
 * limping on: after an unexpected throw the process state is unknown, and a container that
 * exits is restarted clean by ECS, which is strictly safer than one serving corrupt state.
 */
export const installSignalHandlers = (
  controller: ShutdownController,
  logger: Logger,
  exit: (code: number) => void = (code) => process.exit(code),
): void => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void controller.shutdown(signal).then(() => exit(0));
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection; shutting down');
    void controller.shutdown('unhandledRejection').then(() => exit(1));
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception; shutting down');
    void controller.shutdown('uncaughtException').then(() => exit(1));
  });
};
