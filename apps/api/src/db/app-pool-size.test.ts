import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appPoolSize } from './db.module.js';

/*
 * Codex review of PR #432 (P2, initiate-blocked-renewal.handler.ts): every runner lane holds its
 * handler's application transaction while some handlers open one more on the same pool. With the
 * pool fixed at 10 and REKODA_WORKER_CONCURRENCY at 10 or more, every connection could be held
 * while each lane waited for one more, stalling until the idle-transaction timeout. A worker
 * process now holds at least one connection more than its lanes; an API process (no lanes) keeps
 * 10, so the shared worker setting never enlarges it (review of the first fix).
 */
describe('the application pool leaves room for a lane’s second transaction', () => {
  it('in a worker process: more connections than lanes, never fewer than ten', () => {
    expect(appPoolSize({ workerEnabled: true, workerConcurrency: 4 })).toBe(10); // the default
    for (const lanes of [1, 8, 10, 16, 32]) {
      const size = appPoolSize({ workerEnabled: true, workerConcurrency: lanes });
      expect(size).toBeGreaterThanOrEqual(lanes + 1);
      expect(size).toBeGreaterThanOrEqual(10);
    }
  });

  it('in an API process: ten, whatever the worker setting says', () => {
    for (const lanes of [4, 16, 64]) {
      expect(appPoolSize({ workerEnabled: false, workerConcurrency: lanes })).toBe(10);
    }
  });

  it('is what the module opens the application pool with', () => {
    const source = readFileSync(new URL('./db.module.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/createDb\(config\.databaseUrl, \{ max: appPoolSize\(config\) \}\)/);
    expect(source).toMatch(/provide: DB_HANDLE,\s*inject: \[CONFIG\],\s*useFactory: appDbHandle,/);
  });
});
