export { AppError } from '@/shared/errors/app-error.js';
export type { ErrorDetails } from '@/shared/errors/app-error.js';
export {
  authenticationRequired,
  forbidden,
  internalError,
  invalidCredentials,
  notFound,
  serviceUnavailable,
  validationError,
} from '@/shared/errors/app-error.js';
export { ERROR_HTTP_STATUS, ErrorCode } from '@/shared/errors/error-codes.js';
export type { ErrorCodeValue } from '@/shared/errors/error-codes.js';
export * from '@/shared/errors/domain-errors.js';
