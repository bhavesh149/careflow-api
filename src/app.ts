import { randomUUID } from 'node:crypto';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type RawServerDefault,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
} from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import underPressure from '@fastify/under-pressure';
import { Redis } from 'ioredis';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import type { CacheClient } from '@/shared/cache/index.js';
import type { Database } from '@/shared/database/index.js';
import { poolStats } from '@/shared/database/index.js';
import type { Pool } from 'pg';
import { Metric, type MetricsRegistry } from '@/shared/observability/index.js';
import { registerErrorHandler } from '@/shared/http/error-handler.js';
import type { CareflowApp } from '@/shared/http/types.js';
import requestContextPlugin from '@/shared/http/request-context.js';
import { registerObservabilityRoutes } from '@/shared/http/observability-routes.js';
import type { ShutdownController } from '@/shared/http/graceful-shutdown.js';
import { rateLimitError } from '@/shared/http/rate-limit.js';
import authPlugin from '@/modules/auth/presentation/auth-plugin.js';
import {
  registerAuthRoutes,
  registerIdentityRoutes,
} from '@/modules/auth/presentation/auth-routes.js';
import type { AuthService } from '@/modules/auth/application/auth-service.js';
import type { ScheduleService } from '@/modules/scheduling/application/schedule-service.js';
import type { TherapistDirectory } from '@/modules/scheduling/application/ports.js';
import { registerScheduleRoutes } from '@/modules/scheduling/presentation/schedule-routes.js';
import type { AvailabilityService } from '@/modules/availability/application/availability-service.js';
import { registerAvailabilityRoutes } from '@/modules/availability/presentation/availability-routes.js';
import type { HoldService } from '@/modules/booking/application/hold-service.js';
import { registerHoldRoutes } from '@/modules/booking/presentation/hold-routes.js';
import type { BookingService } from '@/modules/booking/application/booking-service.js';
import { registerAppointmentRoutes } from '@/modules/booking/presentation/appointment-routes.js';
import type { RecurringSeriesService } from '@/modules/booking/application/recurring-series-service.js';
import { registerRecurringRoutes } from '@/modules/booking/presentation/recurring-routes.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly pool: Pool;
  readonly cache: CacheClient;
  readonly metrics: MetricsRegistry;
  readonly shutdown: ShutdownController;
  readonly authService: AuthService;
  readonly scheduleService: ScheduleService;
  readonly therapistDirectory: TherapistDirectory;
  readonly availabilityService: AvailabilityService;
  readonly holdService: HoldService;
  readonly bookingService: BookingService;
  readonly recurringSeriesService: RecurringSeriesService;
}

/**
 * Composition root for the HTTP application.
 *
 * Everything is passed in rather than constructed here, so tests can build the same app with a
 * throwaway database and no Redis. Plugin registration order matters and is commented where it
 * is load-bearing.
 */
export const buildApp = async (dependencies: AppDependencies): Promise<CareflowApp> => {
  const { config, logger, db, pool, cache, metrics, shutdown } = dependencies;

  // The logger generic is pinned to Fastify's own interface rather than left to infer from the
  // pino instance we pass in. Inference would bind it to pino's concrete type, and every helper
  // that accepts a plain FastifyInstance would then be incompatible with this app.
  const app = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    FastifyBaseLogger
  >({
    loggerInstance: logger,
    // Trust the ALB/nginx in front of us so that req.ip is the real client address. Without
    // this, per-IP rate limiting would see only the load balancer and throttle everyone as one.
    trustProxy: true,
    // Correlation ids are minted here, not by the request-context plugin, so that Fastify's
    // own `reqId` (which pino stamps on every log line) is the same value the client sees in
    // X-Request-Id and in an error body. Two competing ids would make log correlation a trap.
    genReqId: (request) => {
      const inbound = request.headers['x-request-id'];
      // Bounded: an unbounded client-supplied value would land in every log line for this
      // request, which is a cheap way to inflate log volume.
      const candidate = typeof inbound === 'string' ? inbound.trim().slice(0, 128) : '';
      return candidate.length > 0 ? candidate : randomUUID();
    },
    // 64 KiB is generous for this API's largest payload (a weekly schedule) and small enough
    // that a flood of large bodies cannot exhaust memory.
    bodyLimit: 64 * 1024,
    // Fastify's own request/response pair is switched off because the onResponse hook below
    // emits one structured record per request instead. Configured through the log controller
    // rather than the top-level `disableRequestLogging`, which is deprecated in Fastify 5 and
    // removed in 6 — and which logged a deprecation warning on every container start.
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<ZodTypeProvider>();

  // Zod becomes the single source of truth for validation, serialisation and the OpenAPI doc.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

  await app.register(requestContextPlugin, { instanceId: config.INSTANCE_ID });

  // ---- Security headers -------------------------------------------------
  await app.register(helmet, {
    // This is a JSON API; a restrictive CSP costs nothing and blunts any HTML that does get
    // reflected. `upgrade-insecure-requests` and HSTS are HTTPS-only: on a plain-HTTP ALB they
    // make the browser rewrite /docs to https:// and hang, because nothing is listening on 443.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.COOKIE_SECURE ? [] : null,
      },
    },
    hsts: config.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  // ---- CORS -------------------------------------------------------------
  await app.register(cors, {
    // Explicit allow-list from configuration; production config rejects '*' outright.
    origin: config.CORS_ORIGINS.length > 0 ? [...config.CORS_ORIGINS] : false,
    // Required for the refresh cookie to be sent from the SPA's origin.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'X-Instance-Id', 'Retry-After'],
    maxAge: 600,
  });

  await app.register(cookie, {
    parseOptions: {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: config.COOKIE_SAME_SITE,
    },
  });

  // ---- Rate limiting ----------------------------------------------------
  // Backed by Redis so the limit is global across all three tasks. With three tasks and an
  // in-process limiter, a client would get three times the intended allowance.
  //
  // The limiter needs its own connection (it issues its own commands and must not contend with
  // cache reads), so this owns the connection's lifecycle: closing the app closes it, which is
  // what keeps `app.close()` sufficient for a clean exit instead of leaving the event loop with
  // a live socket and the process hanging.
  const rateLimitRedis = config.REDIS_ENABLED
    ? new Redis(config.REDIS_URL, {
        connectTimeout: 2_000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: false,
      })
    : undefined;

  if (rateLimitRedis) {
    app.addHook('onClose', async () => {
      await rateLimitRedis.quit().catch(() => rateLimitRedis.disconnect());
    });
  }

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_SECONDS * 1000,
    // Authenticated callers are limited per account, anonymous ones per IP. Keying everything
    // by IP would let one corporate NAT exhaust the limit for all its users.
    keyGenerator: (request) => request.principal?.userId ?? request.ip,
    ...(rateLimitRedis === undefined ? {} : { redis: rateLimitRedis }),
    // Documented degradation: if Redis is unreachable the limiter falls back to in-process
    // counting rather than rejecting traffic. Booking availability outweighs perfect limits.
    skipOnError: true,
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
    errorResponseBuilder: (_request, context) => rateLimitError(context.ttl),
  });

  // ---- Load shedding ----------------------------------------------------
  // Returns 503 before the event loop is so far behind that every request times out. Shedding
  // some traffic keeps the rest fast, and keeps ECS health checks passing.
  await app.register(underPressure, {
    maxEventLoopDelay: 1_000,
    maxEventLoopUtilization: 0.98,
    retryAfter: 5,
    // Health endpoints are served by our own handlers so they can distinguish liveness
    // from readiness; under-pressure only sheds load here.
    exposeStatusRoute: false,
  });

  // ---- OpenAPI ----------------------------------------------------------
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Careflow Appointment Booking API',
        version: '1.0.0',
        description: [
          'Therapist appointment booking API.',
          '',
          '**Authentication.** Call `POST /v1/auth/login`, then send the returned access token as',
          '`Authorization: Bearer <token>`. The refresh token is set as an httpOnly cookie and is',
          'exchanged at `POST /v1/auth/refresh`.',
          '',
          '**Idempotency.** Every mutating endpoint accepts an `Idempotency-Key` header. Retrying',
          'with the same key returns the original response instead of performing the work twice,',
          'which makes the API safe to retry after a timeout. Reusing a key with a different body',
          'returns `422 IDEMPOTENCY_KEY_REUSED`.',
          '',
          '**Concurrency.** Slot conflicts are resolved by the database, not the application, so a',
          'losing request receives a deterministic `409` rather than an inconsistent success.',
          '',
          '**Time.** All timestamps are ISO-8601 with an explicit offset. Slots are half-open',
          '`[start, end)`, so a 10:00-11:00 and an 11:00-12:00 appointment do not conflict.',
        ].join('\n'),
      },
      servers: [
        { url: 'http://localhost:8080', description: 'Local stack via nginx (3 API tasks)' },
        { url: 'http://localhost:3000', description: 'Single local API process' },
      ],
      tags: [
        { name: 'Auth', description: 'Authentication and session management' },
        { name: 'Availability', description: 'Derived appointment slots' },
        { name: 'Holds', description: 'Temporary one-minute slot reservations' },
        { name: 'Appointments', description: 'One-time bookings, cancellation and status' },
        { name: 'Recurring', description: 'Recurring series and their instances' },
        { name: 'Schedule', description: 'Therapist recurring availability' },
        { name: 'Therapists', description: 'Therapist directory' },
        { name: 'System', description: 'Health, readiness and metrics' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Access token from POST /v1/auth/login',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  if (config.SWAGGER_ENABLED) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
      // Helmet already sets CSP. swagger-ui's static CSP includes `upgrade-insecure-requests`,
      // which breaks the UI on an HTTP ALB.
      staticCSP: false,
    });
  }

  // ---- Request logging --------------------------------------------------
  // Hand-rolled rather than Fastify's default pair of lines, so that one structured record per
  // request carries exactly the fields the design specifies and nothing sensitive.
  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Number(process.hrtime.bigint() - request.startedAt) / 1_000_000;
    const route = request.routeOptions.url ?? request.url;
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;

    metrics.increment(Metric.HTTP_REQUESTS, {
      route,
      method: request.method,
      status: statusClass,
    });
    metrics.observe(Metric.HTTP_DURATION, durationMs / 1000, { route, method: request.method });

    // Health checks fire every few seconds per task; logging them buries real traffic.
    if (route === '/health' || route === '/ready' || route === '/metrics') {
      return;
    }

    request.log.info(
      {
        event: 'http.request',
        route,
        method: request.method,
        statusCode: reply.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        // actorId and role are not repeated here: `authenticate` binds them to the request
        // logger, so they are already on this line (and on every other line for the request).
      },
      'request completed',
    );
  });

  await app.register(authPlugin, {
    config,
    isSessionActive: (sessionId) => dependencies.authService.isSessionActive(sessionId),
  });

  // ---- Routes -----------------------------------------------------------
  await app.register(registerObservabilityRoutes({ config, db, pool, cache, metrics, shutdown }));

  await app.register(
    async (v1) => {
      await v1.register(registerAuthRoutes(dependencies), { prefix: '/auth' });
      await v1.register(registerIdentityRoutes(dependencies));
      await v1.register(registerScheduleRoutes(dependencies));
      await v1.register(registerAvailabilityRoutes(dependencies));
      await v1.register(registerHoldRoutes(dependencies));
      await v1.register(registerAppointmentRoutes(dependencies));
      await v1.register(registerRecurringRoutes(dependencies));
    },
    { prefix: '/v1' },
  );

  // Fails fast at boot if a route was registered with an invalid schema, rather than on the
  // first request that happens to hit it.
  await app.ready();

  metrics.registerGaugeProvider(
    Metric.DB_POOL_WAITING,
    'Requests waiting for a database connection.',
    () => poolStats(pool, config.DB_POOL_MAX).waiting,
  );
  metrics.registerGaugeProvider(
    Metric.DB_POOL_TOTAL,
    'Open database connections.',
    () => poolStats(pool, config.DB_POOL_MAX).total,
  );
  metrics.registerGaugeProvider(
    Metric.DB_POOL_IDLE,
    'Idle database connections.',
    () => poolStats(pool, config.DB_POOL_MAX).idle,
  );
  // Exposed so saturation is a ratio in the dashboard query (total / max) rather than a
  // number that only means something to whoever remembers the configured pool size.
  metrics.registerGaugeProvider(
    Metric.DB_POOL_MAX,
    'Configured maximum database connections per task.',
    () => config.DB_POOL_MAX,
  );
  metrics.registerGaugeProvider(Metric.CACHE_HEALTHY, 'Redis reachable (1) or not (0).', () =>
    cache.isHealthy() ? 1 : 0,
  );

  return app;
};
