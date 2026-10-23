/**
 * Staging check for document storage (G-40): write, read back and delete one
 * object against the storage this environment is configured with.
 *
 *   node dist/documents/probe-storage.js
 *
 * Exits 0 on success and 1 on any failure, printing the failed step but never
 * a credential or a provider message.
 */
import { loadConfig } from '../config.js';
import { storageFromConfig } from './storage-from-config.js';
import { probeStorage } from './storage.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const kind = config.r2AccountId ? 'R2' : config.localStorageRoot ? 'local filesystem' : 'none';
  if (kind === 'none') {
    console.error(
      'storage probe: no storage is configured (R2_* values and REKODA_LOCAL_STORAGE are unset)',
    );
    process.exit(1);
  }
  await probeStorage(storageFromConfig(config));
  console.log(`storage probe OK: wrote, read and deleted one object on ${kind}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'storage probe failed');
  process.exit(1);
});
