import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { UserRole } from '@/shared/database/schema.js';

/**
 * The authenticated principal.
 *
 * This is the *only* source of identity for authorization decisions. A patientId or
 * therapistId appearing in a request body or path is treated as a target to be checked
 * against this principal, never as evidence of who the caller is — that confusion is
 * exactly how broken-access-control bugs happen.
 */
export interface Principal {
  readonly userId: string;
  readonly role: UserRole;
  /** Therapist profile id; present only when role is THERAPIST. */
  readonly therapistId?: string;
  readonly sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    principal?: Principal;
    startedAt: bigint;
  }
}

/**
 * Correlation IDs and instance attribution.
 *
 * An inbound X-Request-Id from the ALB is reused rather than replaced, so one identifier
 * follows a request through the load balancer, whichever API task handled it, the outbox row
 * it wrote and the worker that later published it. Reproducing a distributed bug without
 * that thread is guesswork.
 *
 * X-Instance-Id is echoed back so it is directly observable which of the three tasks served
 * a response — used by the E2E suite to prove that requests really are spread across tasks.
 */
export const requestContextPlugin: FastifyPluginAsync<{ instanceId: string }> = async (
  app,
  options,
) => {
  app.decorateRequest('requestId', '');
  app.decorateRequest('principal', undefined);
  app.decorateRequest('startedAt', 0n);

  app.addHook('onRequest', async (request, reply) => {
    // `request.id` comes from the app's genReqId, which already honours an inbound
    // X-Request-Id. Adopting it rather than minting a second id keeps the value in the logs,
    // the response header and the error body identical.
    request.requestId = request.id;
    request.startedAt = process.hrtime.bigint();

    reply.header('x-request-id', request.requestId);
    reply.header('x-instance-id', options.instanceId);
  });
};

export default fp(requestContextPlugin, {
  name: 'request-context',
  fastify: '5.x',
});
