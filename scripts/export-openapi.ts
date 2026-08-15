/**
 * Writes the OpenAPI document to `docs/api/openapi.json`.
 *
 * The document is generated from the very same Zod schemas that validate requests at runtime, so
 * a committed copy cannot describe behaviour the service does not have. Committing it is what
 * makes contract drift visible: CI regenerates and fails on a diff, which turns "someone changed
 * the API and forgot to say so" into a review comment instead of a client bug.
 *
 * No infrastructure is required. Composition performs no I/O, so this runs in CI without a
 * database — the pool is constructed but never connected.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '@/shared/config/index.js';
import { createLogger } from '@/shared/logging/index.js';
import { composeApp } from '@/composition.js';

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'api',
  'openapi.json',
);

const main = async (): Promise<void> => {
  const { app, close } = await composeApp({
    // Redis off: generating a document needs no rate-limit counters or cache, and an unreachable
    // Redis must not be able to fail a docs build.
    configOverrides: { REDIS_ENABLED: false, SWAGGER_ENABLED: true, QUEUE_DRIVER: 'noop' },
    // Silent: the only thing this process should write to stdout is where it put the file.
    logger: createLogger({ ...getConfig(), LOG_LEVEL: 'silent' }),
  });

  const document = app.swagger();

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  await close();

  const paths = Object.keys(document.paths ?? {}).length;

  console.log(`Wrote ${paths} paths to ${OUTPUT}`);
};

main().catch((error: unknown) => {
  console.error('Failed to export the OpenAPI document:', error);
  process.exit(1);
});
