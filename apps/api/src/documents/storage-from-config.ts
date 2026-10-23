import type { ApiConfig } from '../config.js';
import { LocalStorage, NoStorageConfigured, R2Storage } from './r2.storage.js';
import type { DocumentStorage } from './storage.js';

/**
 * Three storages, chosen in a fixed order of preference.
 *
 * R2 when it is configured (`loadConfig` has already refused a half-set R2
 * configuration, G-40, so the test here is for "all of it"). The filesystem
 * ONLY when it was asked for explicitly by setting `REKODA_LOCAL_STORAGE`,
 * never as a silent fallback, because a deployment that quietly wrote a
 * merchant's invoices to a container's local disk would lose every one of them
 * on the next restart, and would look like it was working right up until
 * someone asked for a document back. Otherwise nothing, which fails loudly the
 * way an outage does.
 *
 * Its own file so the module and the staging probe choose the same storage.
 */
export function storageFromConfig(config: ApiConfig): DocumentStorage {
  if (config.r2AccountId && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2Bucket) {
    return new R2Storage(
      config.r2AccountId,
      config.r2AccessKeyId,
      config.r2SecretAccessKey,
      config.r2Bucket,
    );
  }
  if (config.localStorageRoot) return new LocalStorage(config.localStorageRoot);
  return new NoStorageConfigured();
}
