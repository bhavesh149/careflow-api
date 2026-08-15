import { pino, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from '@/shared/config/index.js';

/**
 * Redaction is defined here, once, rather than trusted to call sites. Privacy-by-design
 * means a developer must not be able to leak a token by logging a whole request object.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'password_hash',
  '*.password',
  '*.passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  'body.password',
  'body.token',
  'body.refreshToken',
  'jwtSecret',
  'DATABASE_URL',
  'DB_PASSWORD',
  'JWT_SECRET',
];

export const createLogger = (config: AppConfig): Logger => {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: {
      service: config.SERVICE_NAME,
      env: config.NODE_ENV,
    },
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
      remove: false,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // CloudWatch parses one JSON object per line; pretty printing is a local nicety only.
    ...(config.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service,env',
            },
          },
        }
      : {}),
  };

  return pino(options);
};

export type { Logger };
