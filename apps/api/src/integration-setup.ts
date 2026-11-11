/**
 * Runs in every integration test file (vitest `setupFiles`): closes the OD-37 principal pools the
 * file opened through `principalDb`, so connections never accumulate across files.
 */
import { afterAll } from 'vitest';
import { closePrincipalPools } from '@rekoda/db/testing';

afterAll(async () => {
  await closePrincipalPools();
});
