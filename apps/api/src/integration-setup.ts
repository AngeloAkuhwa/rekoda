/**
 * Runs in every integration test file (vitest `setupFiles`), before the file's own hooks.
 *
 * - Starts the file with no enrolled key fingerprint (`resetKeyEnrolment`): every file boots its
 *   own app with its own random `VAULT_KEY` and `MATCH_KEY`, as a fresh deployment, so what a
 *   previous file enrolled must not decide whether this one boots (the order-dependent
 *   KeyFingerprintMismatch seen in CI run 44209538852 after the settlement suite).
 * - Closes the OD-37 principal pools the file opened through `principalDb`, so connections never
 *   accumulate across files.
 */
import { afterAll, beforeAll } from 'vitest';
import { closePrincipalPools, resetKeyEnrolment } from '@rekoda/db/testing';

beforeAll(async () => {
  await resetKeyEnrolment();
});

afterAll(async () => {
  await closePrincipalPools();
});
