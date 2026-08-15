import { ERROR_HTTP_STATUS, ErrorCode, type ErrorCodeValue } from '@/shared/errors/error-codes.js';

export type ErrorDetails = Record<string, unknown>;

/**
 * Every error the API deliberately returns is an `AppError`. Anything else escaping to the
 * error handler is by definition a bug and is reported as INTERNAL_ERROR with the details
 * withheld from the client, so we never leak SQL text or stack traces.
 *
 * `expose` controls whether `message` is safe to hand to the caller.
 */
export class AppError extends Error {
  public readonly code: ErrorCodeValue;
  public readonly httpStatus: number;
  public readonly details?: ErrorDetails;
  public readonly expose: boolean;
  public readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCodeValue,
    message: string,
    options: {
      details?: ErrorDetails;
      cause?: unknown;
      expose?: boolean;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    this.expose = options.expose ?? true;

    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }

    Error.captureStackTrace?.(this, AppError);
  }

  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

export const authenticationRequired = (message = 'Authentication is required.'): AppError =>
  new AppError(ErrorCode.AUTHENTICATION_REQUIRED, message);

export const invalidCredentials = (): AppError =>
  // Deliberately identical for unknown email and wrong password: distinguishing them
  // turns the login endpoint into an account enumeration oracle.
  new AppError(ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect.');

export const forbidden = (message = 'You do not have access to this resource.'): AppError =>
  new AppError(ErrorCode.FORBIDDEN, message);

export const notFound = (resource: string, id?: string): AppError =>
  new AppError(ErrorCode.RESOURCE_NOT_FOUND, `${resource} was not found.`, {
    details: id === undefined ? undefined : { id },
  });

export const validationError = (message: string, details?: ErrorDetails): AppError =>
  new AppError(ErrorCode.VALIDATION_ERROR, message, { details });

export const internalError = (
  message = 'An unexpected error occurred.',
  cause?: unknown,
): AppError => new AppError(ErrorCode.INTERNAL_ERROR, message, { cause, expose: false });

export const serviceUnavailable = (message: string, cause?: unknown): AppError =>
  new AppError(ErrorCode.SERVICE_UNAVAILABLE, message, { cause });
