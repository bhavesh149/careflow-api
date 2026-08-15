import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
};

/**
 * Four projects rather than one suite, because they have very different cost profiles:
 * `unit` is pure and runs on every save, while the others need real infrastructure and
 * therefore run with a single fork so that they never fight over the same database rows.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    globals: false,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          testTimeout: 10_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/setup/global-infra.ts'],
          setupFiles: ['tests/setup/reset-db.ts'],
          pool: 'forks',
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'concurrency',
          include: ['tests/concurrency/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/setup/global-infra.ts'],
          setupFiles: ['tests/setup/reset-db.ts'],
          pool: 'forks',
          fileParallelism: false,
          testTimeout: 90_000,
          hookTimeout: 180_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/setup/global-infra.ts'],
          setupFiles: ['tests/setup/reset-db.ts'],
          pool: 'forks',
          fileParallelism: false,
          testTimeout: 90_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/main.ts', 'src/workers/**/main.ts', 'src/**/*.d.ts'],
    },
  },
});
