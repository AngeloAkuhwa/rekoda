/**
 * A pool seen from the outside, for the connection-budget tests (closeout round G of PR #432):
 * how many transactions it has asked for and not finished at the same time. Each `transaction`
 * holds one connection for its whole body, so the high-water mark is how many connections a code
 * path holds or waits for at once.
 */
import type { Db } from '@rekoda/db';

export interface ProbedPool {
  db: Db;
  /** The most transactions requested and unfinished at once since the probe was made (or reset). */
  highWater: () => number;
  reset: () => void;
}

export function probePool(pool: Db): ProbedPool {
  let open = 0;
  let high = 0;
  const db = new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (body: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => {
        /* Counted from the request, not from the connection: a transaction waiting for a
         * connection is demand the pool must meet, and hold-and-wait is what starves it. */
        open += 1;
        high = Math.max(high, open);
        try {
          return await (target.transaction as (...a: unknown[]) => Promise<unknown>)(body, ...rest);
        } finally {
          open -= 1;
        }
      };
    },
  });
  return { db, highWater: () => high, reset: () => (high = 0) };
}
