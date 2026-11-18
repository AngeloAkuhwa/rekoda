/**
 * Runs in every integration test file (vitest `setupFiles`), before the file's own hooks.
 *
 * - Starts the file with no enrolled key fingerprint (`resetKeyEnrolment`), as a fresh deployment:
 *   what a previous file enrolled (boot-checks, the settlement suites) never decides this one.
 * - Closes the OD-37 principal pools the file opened through `principalDb`, so connections never
 *   accumulate across files.
 */
import { afterAll, beforeAll } from 'vitest';
import { closePrincipalPools, resetKeyEnrolment } from './testing.js';

beforeAll(async () => {
  await resetKeyEnrolment();
});

afterAll(async () => {
  await closePrincipalPools();
});
