import { rateLimited } from '@/shared/errors/domain-errors.js';
import type { AppError } from '@/shared/errors/app-error.js';

/**
 * `@fastify/rate-limit` *throws* whatever its `errorResponseBuilder` returns, so the return value
 * has to be an Error — returning a plain response body lands in the error handler as an
 * unrecognised object and is reported as a 500, which is exactly the wrong answer for a caller
 * that is merely being throttled.
 *
 * Returning our own `AppError` also means throttling shares the standard error envelope and
 * `Retry-After` handling with every other rejection, so a client's error handling keeps working
 * precisely when it is being rate limited and needs to back off correctly.
 */
export const rateLimitError = (retryAfterMs: number): AppError =>
  rateLimited(Math.max(1, Math.ceil(retryAfterMs / 1000)));
