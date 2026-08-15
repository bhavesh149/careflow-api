import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * The `no-restricted-imports` blocks below are the machine-enforced version of the
 * hexagonal dependency rule (presentation -> application -> domain). Without them the
 * layering is only a convention that erodes on the first deadline.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'drizzle/**', 'docs/**', 'infra/**', '.github/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'prefer-const': 'error',
    },
  },

  {
    files: ['src/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'fastify',
                'fastify/*',
                '@fastify/*',
                'pg',
                'drizzle-orm',
                'drizzle-orm/*',
                'ioredis',
                '@aws-sdk/*',
                'argon2',
                'jose',
                'pino',
                '**/infrastructure/**',
                '**/presentation/**',
                '**/application/**',
                '@/shared/database/**',
                '@/shared/http/**',
              ],
              message:
                'Domain layer must stay free of frameworks, I/O and outer layers. Define a port instead and let infrastructure implement it.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['src/modules/*/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'fastify',
                'fastify/*',
                '@fastify/*',
                'pg',
                'drizzle-orm',
                'drizzle-orm/*',
                'ioredis',
                '@aws-sdk/*',
                '**/infrastructure/**',
                '**/presentation/**',
              ],
              message:
                'Application layer depends on ports, not on concrete adapters or the HTTP framework.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'src/shared/database/seed.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  {
    files: ['eslint.config.js', 'vitest.config.ts', 'drizzle.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
