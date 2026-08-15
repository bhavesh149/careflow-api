/**
 * Production runtime knobs for ECS.
 *
 * Secrets (JWT, RDS password) are not here — they come from Secrets Manager.
 * Hosts (RDS, Redis, SQS) are not here — CDK wires those from the resources it creates.
 *
 * Keep these in lockstep with `.env.aws` (gitignored). That file is the human-readable
 * copy; this module is what actually gets injected into the task definition.
 */
export const runtimeConfig: Record<string, string> = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  HOST: '0.0.0.0',

  DB_SSL: 'true',
  // t4g.micro has ~87 max_connections. Six tasks × 5 = 30, leaving headroom for
  // migrations, admin, and a burst of Testcontainers-style scripts.
  DB_POOL_MAX: '5',
  DB_POOL_MIN: '0',
  DB_STATEMENT_TIMEOUT_MS: '10000',

  REDIS_ENABLED: 'true',

  JWT_ISSUER: 'careflow',
  JWT_AUDIENCE: 'careflow-api',
  ACCESS_TOKEN_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_SECONDS: '1209600',
  COOKIE_SECURE: 'false',
  COOKIE_DOMAIN: '',
  COOKIE_SAME_SITE: 'lax',

  APP_TIMEZONE: 'Asia/Kolkata',
  SLOT_GRANULARITY_MINUTES: '60',
  HOLD_TTL_SECONDS: '60',
  MAX_ACTIVE_HOLDS_PER_PATIENT: '3',
  AVAILABILITY_MAX_RANGE_DAYS: '60',
  RECURRENCE_MAX_OCCURRENCES: '26',
  RECURRENCE_MAX_HORIZON_DAYS: '183',
  STATUS_UPDATE_GRACE_HOURS: '24',
  IDEMPOTENCY_TTL_HOURS: '24',

  RATE_LIMIT_GLOBAL_MAX: '300',
  RATE_LIMIT_GLOBAL_WINDOW_SECONDS: '60',
  RATE_LIMIT_LOGIN_MAX: '15',
  RATE_LIMIT_LOGIN_WINDOW_SECONDS: '300',
  RATE_LIMIT_MUTATION_MAX: '30',
  RATE_LIMIT_MUTATION_WINDOW_SECONDS: '60',

  QUEUE_DRIVER: 'sqs',
  SQS_WAIT_TIME_SECONDS: '20',

  OUTBOX_POLL_INTERVAL_MS: '1000',
  OUTBOX_BATCH_SIZE: '25',
  OUTBOX_MAX_ATTEMPTS: '8',
  HOLD_SWEEPER_INTERVAL_MS: '5000',
  WORKER_HEALTH_PORT: '3100',

  // Showcase: Swagger on the ALB. Turn off if this stack ever stays up longer.
  SWAGGER_ENABLED: 'true',
};
