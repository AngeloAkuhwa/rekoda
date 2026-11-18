import { describe, expect, it } from 'vitest';
import { appPoolSize } from './db.module.js';

/*
 * Codex review of PR #432 (P2, initiate-blocked-renewal.handler.ts): every runner lane holds its
 * handler's application transaction while a blocked-renewal initiation opens a checkout
 * transaction on the same pool. With the pool fixed at 10 and REKODA_WORKER_CONCURRENCY at 10 or
 * more, a backlog of those jobs could hold every connection while each waited for one more,
 * stalling until the idle-transaction timeout. The pool now leaves a connection per lane for that
 * second transaction, and two for the sweeps, whatever the concurrency.
 */
describe('the application pool leaves room for a lane’s second transaction', () => {
  it('holds two connections per lane plus two, never fewer than the default ten', () => {
    expect(appPoolSize(4)).toBe(10); // the default concurrency: unchanged
    expect(appPoolSize(1)).toBe(10);
    for (const lanes of [10, 16, 32]) {
      expect(appPoolSize(lanes)).toBeGreaterThanOrEqual(2 * lanes + 1);
    }
  });
});
