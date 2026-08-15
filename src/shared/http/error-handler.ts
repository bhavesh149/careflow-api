import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError } from '@/shared/errors/app-error.js';
import { ErrorCode, type ErrorCodeValue } from '@/shared/errors/error-codes.js';
import type { CareflowApp } from '@/shared/http/types.js';

/**
 * The single place where anything thrown becomes an HTTP response.
 *
 * Contract, per the technical design:
 *   { "error": { "code", "message", "requestId", "details"? } }
 *
 * Two rules are absolute here:
 *   1. A client never receives a stack trace, SQL fragment, table name or upstream message.
 *      Unrecognised failures collapse to INTERNAL_ERROR with a generic message, while the
 *      full error is logged server-side against the requestId so support can still trace it.
 *   2. 5xx is logged at error level and 4xx at warn/info. A misconfigured level here means
 *      either real incidents drown in client-error noise, or genuine bugs go unnoticed.
 */

export interface ErrorResponseBody {
  error: {
    code: ErrorCodeValue;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

const buildBody = (
  code: ErrorCodeValue,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ErrorResponseBody => ({
  error: {
    code,
    message,
    requestId,
    ...(details === undefined ? {} : { details }),
  },
});

export const registerErrorHandler = (app: CareflowApp): void => {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.requestId;

    // ---- Deliberate domain and application errors -------------------------
    if (AppError.isAppError(error)) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header('retry-after', String(error.retryAfterSeconds));
      }

      const logPayload = {
        err: error,
        code: error.code,
        statusCode: error.httpStatus,
        details: error.details,
      };

      if (error.httpStatus >= 500) {
        request.log.error(logPayload, 'request failed');
      } else {
        request.log.info(logPayload, 'request rejected');
      }

      return reply.status(error.httpStatus).send(
        buildBody(
          error.code,
          // A non-exposable message is an internal diagnostic, not something to leak.
          error.expose ? error.message : 'An unexpected error occurred.',
          requestId,
          error.expose ? error.details : undefined,
        ),
      );
    }

    // ---- Request schema validation (Zod) ----------------------------------
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.info({ issues: error.validation }, 'request validation failed');

      return reply.status(400).send(
        buildBody(ErrorCode.VALIDATION_ERROR, 'The request payload is invalid.', requestId, {
          issues: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message,
          })),
        }),
      );
    }

    // ---- Response schema violation ---------------------------------------
    // Our bug, not the caller's: we promised a shape in the OpenAPI contract and broke it.
    // Returning 500 (rather than leaking the malformed payload) keeps the contract honest.
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, route: error.method }, 'response did not match its schema');

      return reply
        .status(500)
        .send(buildBody(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.', requestId));
    }

    // ---- Framework-level errors we can map faithfully ---------------------
    switch (error.code) {
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        return reply
          .status(413)
          .send(
            buildBody(ErrorCode.PAYLOAD_TOO_LARGE, 'The request body is too large.', requestId),
          );

      case 'FST_ERR_VALIDATION':
        return reply
          .status(400)
          .send(
            buildBody(ErrorCode.VALIDATION_ERROR, 'The request payload is invalid.', requestId),
          );

      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        return reply
          .status(415)
          .send(buildBody(ErrorCode.VALIDATION_ERROR, 'Unsupported content type.', requestId));

      default:
        break;
    }

    // Rate limiting is answered by @fastify/rate-limit's own handler, but a 429 can also
    // arrive here if a plugin throws one.
    if (error.statusCode === 429) {
      return reply
        .status(429)
        .send(buildBody(ErrorCode.RATE_LIMITED, 'Too many requests. Please slow down.', requestId));
    }

    // A 4xx raised by the framework is safe to pass through with its own message; a 5xx is not.
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.info({ err: error }, 'request rejected by framework');
      return reply
        .status(error.statusCode)
        .send(buildBody(ErrorCode.VALIDATION_ERROR, error.message, requestId));
    }

    // ---- Anything else is a bug ------------------------------------------
    request.log.error({ err: error }, 'unhandled error');

    return reply
      .status(500)
      .send(buildBody(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.', requestId));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send(
        buildBody(
          ErrorCode.RESOURCE_NOT_FOUND,
          `Route ${request.method} ${request.url} does not exist.`,
          request.requestId,
        ),
      ),
  );
};
