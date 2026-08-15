import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * The application's concrete Fastify instance type.
 *
 * Named once here because the type provider generic must be threaded through anything that
 * receives the instance (the error handler, route plugins). Writing plain `FastifyInstance`
 * would silently fall back to the default type provider and lose Zod inference on routes.
 */
export type CareflowApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  FastifyBaseLogger,
  ZodTypeProvider
>;
