import { pingDatabase } from '@/shared/database/index.js';
import { installSignalHandlers } from '@/shared/http/graceful-shutdown.js';
import { composeApp } from '@/composition.js';

/**
 * API entrypoint.
 *
 * Object construction lives in `composition.ts`, which the OpenAPI exporter and the test suites
 * share. What is unique to the deployed process stays here: shutdown ordering, signal handlers,
 * the startup database probe, and binding the port.
 */
const start = async (): Promise<void> => {
  const { app, config, logger, database, cache, shutdown } = await composeApp();

  // Registered in dependency order; the controller closes them in reverse, so the HTTP server
  // stops accepting work before the pool it depends on is torn down.
  shutdown.register('http-server', async () => {
    await app.close();
  });
  shutdown.register('redis', async () => {
    await cache.close();
  });
  shutdown.register('postgres', async () => {
    await database.close();
  });

  installSignalHandlers(shutdown, logger);

  // Prove the database is reachable before accepting traffic. This lives in the entrypoint rather
  // than in the composition root so that constructing the application performs no I/O: that is
  // what lets tooling (the OpenAPI export) build the real app without infrastructure, while the
  // deployed process still refuses to serve if Postgres is missing.
  await pingDatabase(database.pool);

  await app.listen({ port: config.PORT, host: config.HOST });

  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      instanceId: config.INSTANCE_ID,
      swagger: config.SWAGGER_ENABLED ? `http://localhost:${config.PORT}/docs` : 'disabled',
    },
    'careflow api listening',
  );
};

start().catch((error: unknown) => {
  // The logger may not exist yet if configuration parsing failed, so this is the one place a
  // raw console write is correct.
  // eslint-disable-next-line no-console
  console.error('Failed to start the API:', error);
  process.exit(1);
});
