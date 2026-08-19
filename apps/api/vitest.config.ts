import { defineConfig } from 'vitest/config';

/**
 * The default `test` task is UNIT only, and stays hermetic.
 *
 * Integration suites live behind `test:integration` with their own config,
 * because they require a real PostgreSQL and are written to FAIL rather than
 * skip without one. Left in this config they would break `pnpm test` for anyone
 * without a database running — and the usual fix for that is to make them skip,
 * which is how a green tick comes to mean nothing.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
  },
});
