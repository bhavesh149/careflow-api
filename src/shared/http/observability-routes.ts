import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import type { AppConfig } from '@/shared/config/index.js';
import type { CacheClient } from '@/shared/cache/index.js';
import type { Database } from '@/shared/database/index.js';
import { pingDatabase } from '@/shared/database/index.js';
import type { MetricsRegistry } from '@/shared/observability/index.js';
import type { ShutdownController } from '@/shared/http/graceful-shutdown.js';

/**
 * Health, readiness and metrics.
 *
 * The distinction between the two health endpoints is what makes zero-downtime deployment
 * work, and getting it backwards is a classic outage:
 *
 *   /health (liveness)  -- "is this process alive?" Checks nothing external. If it consulted
 *                          the database, a brief RDS failover would make ECS conclude that all
 *                          three tasks are broken and kill them, turning a 30-second database
 *                          blip into a full outage.
 *
 *   /ready (readiness)  -- "should I receive traffic?" Checks dependencies, and returns 503
 *                          while draining so the load balancer removes this task before the
 *                          listener closes.
 */

export interface ObservabilityDependencies {
  readonly config: AppConfig;
  readonly db: Database;
  readonly pool: Pool;
  readonly cache: CacheClient;
  readonly metrics: MetricsRegistry;
  readonly shutdown: ShutdownController;
}

const healthResponseSchema = z.object({
  status: z.literal('ok'),
  instanceId: z.string(),
  uptimeSeconds: z.number(),
});

const readyResponseSchema = z.object({
  status: z.enum(['ready', 'draining', 'degraded']),
  instanceId: z.string(),
  checks: z.object({
    database: z.enum(['ok', 'failed']),
    cache: z.enum(['ok', 'degraded', 'disabled']),
  }),
});

export const registerObservabilityRoutes = (
  dependencies: ObservabilityDependencies,
): FastifyPluginAsyncZod => {
  const { config, pool, cache, metrics, shutdown } = dependencies;

  return async (app) => {
    app.get(
      '/health',
      {
        schema: {
          tags: ['System'],
          summary: 'Liveness probe',
          description:
            'Process-level health only; performs no dependency checks so that a transient ' +
            'database or cache problem cannot cause the orchestrator to kill healthy tasks.',
          response: { 200: healthResponseSchema },
        },
      },
      async (_request, reply) =>
        reply.status(200).send({
          status: 'ok' as const,
          instanceId: config.INSTANCE_ID,
          uptimeSeconds: Math.round(process.uptime()),
        }),
    );

    app.get(
      '/ready',
      {
        schema: {
          tags: ['System'],
          summary: 'Readiness probe',
          description:
            'Reports whether this task should receive traffic. Returns 503 while draining ' +
            'during shutdown, or if Postgres is unreachable. A Redis outage is reported as ' +
            'degraded but stays ready, because booking does not depend on the cache.',
          response: {
            200: readyResponseSchema,
            503: readyResponseSchema,
          },
        },
      },
      async (_request, reply) => {
        // Checked first: once draining, the answer is no regardless of dependency state.
        if (shutdown.isDraining()) {
          return reply.status(503).send({
            status: 'draining' as const,
            instanceId: config.INSTANCE_ID,
            checks: { database: 'ok' as const, cache: 'ok' as const },
          });
        }

        let databaseOk = true;
        try {
          await pingDatabase(pool);
        } catch {
          databaseOk = false;
        }

        const cacheStatus = !config.REDIS_ENABLED
          ? ('disabled' as const)
          : cache.isHealthy()
            ? ('ok' as const)
            : ('degraded' as const);

        // Postgres is the source of truth, so losing it means we cannot serve correctly.
        // Redis is not, so its absence degrades features but does not remove the task.
        if (!databaseOk) {
          return reply.status(503).send({
            status: 'degraded' as const,
            instanceId: config.INSTANCE_ID,
            checks: { database: 'failed' as const, cache: cacheStatus },
          });
        }

        return reply.status(200).send({
          status: 'ready' as const,
          instanceId: config.INSTANCE_ID,
          checks: { database: 'ok' as const, cache: cacheStatus },
        });
      },
    );

    app.get(
      '/metrics',
      {
        schema: {
          tags: ['System'],
          summary: 'Prometheus metrics',
          description:
            'Prometheus exposition format. In AWS this is scraped by the CloudWatch agent ' +
            'sidecar; the endpoint is not exposed through the public listener.',
          response: { 200: z.string() },
        },
      },
      async (_request, reply) =>
        reply
          .status(200)
          .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
          .send(metrics.render()),
    );
  };
};
