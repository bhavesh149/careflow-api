import { z } from 'zod';
import { ErrorCode } from '@/shared/errors/error-codes.js';

/**
 * Shared request/response schemas.
 *
 * These serve double duty: Fastify validates against them at runtime, and
 * `fastify-type-provider-zod` derives the OpenAPI document from the same objects. There is no
 * second, hand-maintained API description that can drift from actual behaviour — if a field
 * is documented, it is validated, and vice versa.
 */

export const uuidSchema = z.string().uuid().describe('UUID v4 identifier');

/**
 * ISO-8601 timestamp with an explicit offset, coerced to a Date.
 *
 * The offset is required rather than optional. Accepting a naive '2026-09-07T10:00:00' would
 * force the server to guess a timezone, and guessing wrong silently books the wrong hour.
 */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .describe('ISO-8601 timestamp including a UTC offset, e.g. 2026-09-07T10:00:00.000Z');

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date in YYYY-MM-DD form')
  .describe('Calendar date, e.g. 2026-09-07');

export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a 24-hour time in HH:MM form')
  .describe('Wall-clock time in the application timezone, e.g. 09:30');

/** The single error envelope every non-2xx response uses. */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z
        .enum(Object.values(ErrorCode) as [string, ...string[]])
        .describe('Stable machine-readable code'),
      message: z.string().describe('Human-readable description, safe to display'),
      requestId: z.string().describe('Correlation id; quote this when reporting a problem'),
      details: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Structured context, when available'),
    }),
  })
  .describe('Error response');

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * Keyset-friendly page metadata. Offset pagination is used for appointment lists because
 * users jump to arbitrary pages there and the result sets are small and bounded.
 */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).describe('Page size (1-100)'),
  offset: z.coerce.number().int().min(0).default(0).describe('Rows to skip'),
});

export const paginationMetaSchema = z.object({
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int().describe('Total matching rows'),
  hasMore: z.boolean(),
});

/** Standard error responses attached to authenticated routes, for the OpenAPI document. */
export const commonErrorResponses = {
  400: errorResponseSchema.describe('Validation error'),
  401: errorResponseSchema.describe('Authentication required or token invalid'),
  403: errorResponseSchema.describe('Authenticated but not permitted'),
  429: errorResponseSchema.describe('Rate limited'),
  500: errorResponseSchema.describe('Unexpected server error'),
} as const;

export const notFoundResponse = {
  404: errorResponseSchema.describe('Resource not found'),
} as const;

export const conflictResponse = {
  409: errorResponseSchema.describe(
    'Conflicts with the current state: the slot was taken, the hold expired, the appointment ' +
      'was already cancelled, or a request with the same Idempotency-Key is still in flight',
  ),
} as const;

/**
 * Attached alongside `conflictResponse` on mutating routes. 409 lives in `conflictResponse`
 * because an in-flight duplicate is a state conflict like any other, and declaring the status
 * in one place only keeps its description consistent across endpoints.
 */
export const idempotencyResponses = {
  422: errorResponseSchema.describe('Idempotency-Key reused with a different request body'),
} as const;

/**
 * The Idempotency-Key header, described once so it appears identically on every mutating
 * endpoint in the OpenAPI document.
 */
export const idempotencyHeaderSchema = z.object({
  'idempotency-key': z
    .string()
    .min(16)
    .max(255)
    .describe(
      'Unique key for this logical operation, e.g. a UUID v4. Retrying with the same key ' +
        'returns the original result instead of creating a duplicate.',
    ),
});
