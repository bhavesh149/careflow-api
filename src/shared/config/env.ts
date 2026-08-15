import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Configuration is parsed once, at startup, and the process refuses to boot if anything
 * is missing or malformed. A container that fails fast is far easier to diagnose than one
 * that starts happily and then throws `undefined is not a string` on the booking path.
 *
 * `.env` is loaded here (not by a separate dotenv library) so every entrypoint — API, workers,
 * migrator, OpenAPI export — sees the same file. Existing process env wins, which is what lets
 * Docker Compose and CI override hostnames without editing the file.
 */

const loadLocalEnvFile = (): void => {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(fileURLToPath(new URL('../../../.env', import.meta.url))),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    process.loadEnvFile(path);
    return;
  }
};

loadLocalEnvFile();

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),
    SERVICE_NAME: z.string().min(1).default('careflow-api'),
    // Surfaced in every log line and in the X-Instance-Id response header so that a
    // request can be attributed to a specific task when three of them are running.
    INSTANCE_ID: z.string().min(1).default('local'),

    // Full URL, or the DB_* parts below (ECS injects the password from Secrets Manager
    // as its own env var; it cannot splice that value into DATABASE_URL at deploy time).
    DATABASE_URL: z.string().default(''),
    DB_HOST: z.string().default(''),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DB_NAME: z.string().default(''),
    DB_USER: z.string().default(''),
    DB_PASSWORD: z.string().default(''),
    // The migration job connects as the schema owner; the API never has DDL rights.
    MIGRATION_DATABASE_URL: z.string().default(''),
    DB_SSL: booleanFromString.default(false),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_POOL_MIN: z.coerce.number().int().min(0).max(50).default(0),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),

    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    REDIS_ENABLED: booleanFromString.default(true),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().min(1).default('careflow'),
    JWT_AUDIENCE: z.string().min(1).default('careflow-api'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).default(1_209_600),
    COOKIE_SECURE: booleanFromString.default(true),
    COOKIE_DOMAIN: z.string().default(''),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    CORS_ORIGINS: csv.default([]),

    APP_TIMEZONE: z.string().min(1).default('Asia/Kolkata'),
    SLOT_GRANULARITY_MINUTES: z.coerce.number().int().min(5).max(480).default(60),
    HOLD_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    MAX_ACTIVE_HOLDS_PER_PATIENT: z.coerce.number().int().min(1).max(50).default(3),
    AVAILABILITY_MAX_RANGE_DAYS: z.coerce.number().int().min(1).max(365).default(60),
    RECURRENCE_MAX_OCCURRENCES: z.coerce.number().int().min(1).max(500).default(26),
    RECURRENCE_MAX_HORIZON_DAYS: z.coerce.number().int().min(1).max(1095).default(183),
    STATUS_UPDATE_GRACE_HOURS: z.coerce.number().int().min(0).max(720).default(24),
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),

    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_GLOBAL_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).default(5),
    RATE_LIMIT_LOGIN_WINDOW_SECONDS: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_MUTATION_MAX: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_MUTATION_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

    QUEUE_DRIVER: z.enum(['sqs', 'noop']).default('sqs'),
    AWS_REGION: z.string().min(1).default('ap-south-1'),
    SQS_QUEUE_URL: z.string().default(''),
    SQS_ENDPOINT: z.string().default(''),
    // Long-poll duration. 20s is the SQS maximum and the right default: it minimises both empty
    // receives (cost) and delivery latency compared with short polling.
    SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),

    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
    HOLD_SWEEPER_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3100),

    SWAGGER_ENABLED: booleanFromString.default(false),
  })
  .superRefine((value, ctx) => {
    if (value.DB_POOL_MIN > value.DB_POOL_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['DB_POOL_MIN'],
        message: 'DB_POOL_MIN cannot exceed DB_POOL_MAX',
      });
    }

    if (value.DATABASE_URL.length === 0) {
      const missingParts = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter(
        (key) => (value as Record<string, unknown>)[key] === '',
      );
      if (missingParts.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message:
            'Set DATABASE_URL, or provide DB_HOST, DB_NAME, DB_USER and DB_PASSWORD so it can be composed',
        });
      }
    }

    if (value.QUEUE_DRIVER === 'sqs' && value.SQS_QUEUE_URL.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['SQS_QUEUE_URL'],
        message: 'SQS_QUEUE_URL is required when QUEUE_DRIVER=sqs',
      });
    }

    if (value.NODE_ENV === 'production') {
      if (value.CORS_ORIGINS.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: 'CORS_ORIGINS must list explicit origins in production',
        });
      }

      if (value.CORS_ORIGINS.some((origin) => origin === '*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: 'Wildcard CORS origin is not permitted in production',
        });
      }

      if (value.JWT_SECRET.startsWith('local_dev_only')) {
        ctx.addIssue({
          code: 'custom',
          path: ['JWT_SECRET'],
          message: 'The development JWT secret must not be used in production',
        });
      }
    }
  });

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

export class ConfigurationError extends Error {
  constructor(issues: string) {
    super(`Invalid configuration:\n${issues}`);
    this.name = 'ConfigurationError';
  }
}

export const parseConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigurationError(issues);
  }

  const parsed = result.data;
  const databaseUrl =
    parsed.DATABASE_URL.length > 0
      ? parsed.DATABASE_URL
      : composePostgresUrl(
          parsed.DB_USER,
          parsed.DB_PASSWORD,
          parsed.DB_HOST,
          parsed.DB_PORT,
          parsed.DB_NAME,
        );

  return Object.freeze({ ...parsed, DATABASE_URL: databaseUrl });
};

const composePostgresUrl = (
  user: string,
  password: string,
  host: string,
  port: number,
  database: string,
): string =>
  `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;

let cached: AppConfig | undefined;

export const getConfig = (): AppConfig => {
  cached ??= parseConfig();
  return cached;
};

/** Test-only escape hatch so suites can build a config without mutating `process.env`. */
export const resetConfigCache = (): void => {
  cached = undefined;
};
