import { Redis } from 'ioredis';
import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';

/**
 * Redis is used for rate-limit counters and schedule read caching. It is deliberately NOT
 * used for anything that decides whether a slot can be booked.
 *
 * The failure policy is therefore explicit: if Redis is unavailable, booking must keep
 * working. Every method degrades to a miss instead of throwing, and the outage is logged
 * once (not per request) plus surfaced via /ready and a CloudWatch alarm. The security
 * trade-off is real and accepted: with Redis down, distributed rate limiting falls back to
 * Fastify's in-process limiter, so the effective limit becomes per-task rather than global.
 * That is strictly better than refusing to serve appointments because a cache is down.
 */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  delByPrefix(prefix: string): Promise<void>;
  isHealthy(): boolean;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Used when REDIS_ENABLED=false, and in unit tests. Every read is a miss. */
export const nullCache: CacheClient = {
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
  delByPrefix: async () => undefined,
  isHealthy: () => true,
  ping: async () => true,
  close: async () => undefined,
};

export const createCacheClient = (config: AppConfig, logger: Logger): CacheClient => {
  if (!config.REDIS_ENABLED) {
    logger.warn('redis disabled by configuration; caching and distributed rate limiting are off');
    return nullCache;
  }

  const redis = new Redis(config.REDIS_URL, {
    // Fail fast rather than queueing commands behind a dead connection: a request must
    // never block on the cache.
    maxRetriesPerRequest: 2,
    connectTimeout: 3_000,
    enableOfflineQueue: false,
    lazyConnect: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  let healthy = false;
  // Without this guard a Redis outage would emit one error log per command and drown the
  // logs we actually need during the incident.
  let outageLogged = false;

  redis.on('ready', () => {
    healthy = true;
    outageLogged = false;
    logger.info('redis connected');
  });

  redis.on('error', (error: Error) => {
    healthy = false;
    if (!outageLogged) {
      outageLogged = true;
      logger.error({ err: error }, 'redis unavailable; degrading to in-process rate limiting');
    }
  });

  redis.on('close', () => {
    healthy = false;
  });

  const swallow = (operation: string) => (error: unknown) => {
    logger.debug({ err: error, operation }, 'cache operation failed; treated as a miss');
    return undefined;
  };

  return {
    get: async (key) => {
      if (!healthy) return null;
      return redis.get(key).catch(() => null);
    },

    set: async (key, value, ttlSeconds) => {
      if (!healthy) return;
      await redis.set(key, value, 'EX', ttlSeconds).catch(swallow('set'));
    },

    del: async (...keys) => {
      if (!healthy || keys.length === 0) return;
      await redis.del(...keys).catch(swallow('del'));
    },

    /**
     * Prefix invalidation via SCAN rather than KEYS. `KEYS *pattern*` is O(n) over the whole
     * keyspace and blocks the single-threaded server; SCAN iterates in small batches and
     * lets other commands interleave.
     */
    delByPrefix: async (prefix) => {
      if (!healthy) return;

      try {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
          cursor = nextCursor;
          if (keys.length > 0) {
            await redis.unlink(...keys);
          }
        } while (cursor !== '0');
      } catch (error) {
        swallow('delByPrefix')(error);
      }
    },

    isHealthy: () => healthy,

    ping: async () => {
      try {
        return (await redis.ping()) === 'PONG';
      } catch {
        return false;
      }
    },

    close: async () => {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
};
