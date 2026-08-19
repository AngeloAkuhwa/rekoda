import { defineConfig } from 'vitest/config';

/**
 * Integration tests, kept in their own config on purpose.
 *
 * They need a real PostgreSQL — RLS, advisory locks and `ON CONFLICT` races
 * have no meaningful in-memory imitation, and a mock of the thing under test
 * would prove nothing. Separating them means `pnpm test` stays fast and
 * hermetic, and it means these can be made to FAIL rather than skip when the
 * database is missing, so a green CI run cannot quietly mean "ran nothing".
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    // Each file gets its own tenant fixtures; running them in one process
    // keeps connection counts low and makes the pooling assertions honest.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
