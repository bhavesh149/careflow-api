import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import type { AppConfig } from '@/shared/config/index.js';
import { createAuthenticateHook } from '@/modules/auth/presentation/authenticate.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Verifies the bearer access token and populates `request.principal`. */
    authenticate: preHandlerAsyncHookHandler;
  }
}

/**
 * Exposes the authenticate hook as an instance decorator so routes opt in explicitly with
 * `preHandler: app.authenticate`.
 *
 * Deliberately opt-in rather than a global `onRequest` hook with an exclusion list. A global
 * guard fails in the dangerous direction: forget to add a new route to the allow-list and it
 * breaks loudly, but restructure the list wrongly and a route silently becomes public. Making
 * each route state its own requirement means an unprotected endpoint is visible in review, and
 * the E2E suite asserts that every mutating route rejects anonymous callers.
 */
const authPlugin: FastifyPluginAsync<{
  config: AppConfig;
  isSessionActive: (sessionId: string) => Promise<boolean>;
}> = async (app, options) => {
  app.decorate('authenticate', createAuthenticateHook(options.config, options.isSessionActive));
};

export default fp(authPlugin, {
  name: 'auth',
  fastify: '5.x',
});
