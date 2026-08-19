import { defineConfig } from 'vitest/config';

/**
 * API integration tests: a real Nest application over a real PostgreSQL.
 *
 * The properties worth testing here — attempt limits under concurrency, RLS,
 * single-use codes, role boundaries — are all properties of the seam between
 * rules and storage. A mocked database would test the mock.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
