/**
 * Database client with tenant-scoped execution — the RLS half of the
 * double-enforcement rule (ADR 0001 / spec §40).
 *
 * The application role (`rekoda_app`) is NOT the table owner and has no
 * BYPASSRLS, so the policies in migrations/0001_rls.sql are live for every
 * query it runs. `withBusiness` pins `app.business_id` for the duration of
 * one transaction; code that forgets to scope a WHERE clause reads zero
 * rows instead of another tenant's ledger.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type TenantDb = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbOptions {
  /** Pool size. Tests pin this to 1 to force every tenant onto one connection. */
  max?: number;
  /** Per-statement ceiling in ms (default 30s): a hung query, not a slow one. */
  statementTimeoutMs?: number;
  /** Idle-in-transaction ceiling in ms (default 60s): a crashed handler's shape. */
  idleInTxTimeoutMs?: number;
}

export function createDb(
  databaseUrl: string,
  options: DbOptions = {},
): { db: Db; close: () => Promise<void> } {
  const client = postgres(databaseUrl, {
    max: options.max ?? 10,
    // Financial writes must never be silently retried by the driver.
    prepare: true,
    onnotice: () => {},
    connection: {
      /**
       * A single statement running this long is code that hung, not code that
       * is slow: nothing here legitimately runs one query for half a minute.
       * Without it a wedged provider socket inside a sweep pins a connection
       * indefinitely, and an open snapshot blocks autovacuum estate-wide.
       */
      statement_timeout: options.statementTimeoutMs ?? 30_000,
      /**
       * A connection left mid-transaction with nothing running is the shape of
       * a crashed handler. Reaping it returns the connection and, more to the
       * point, releases the snapshot its idle transaction was pinning.
       */
      idle_in_transaction_session_timeout: options.idleInTxTimeoutMs ?? 60_000,
    },
  });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

/**
 * Advisory-lock class ids, kept distinct so their 32-bit key hashes never
 * collide across purposes. Two single-argument `hashtext` locks over the same
 * keyspace could otherwise let a sweep key and a business key block each other.
 */
export const LOCK_CLASS = {
  /** Background sweeps: one leader per sweep per pass. */
  sweep: 1,
  /** Per-business serialisation of inbound work. */
  business: 2,
} as const;

/**
 * A connection pool used ONLY to hold advisory locks — never for query work.
 * Kept separate from the working pool on purpose: a session-level lock is
 * held for the whole duration of the work it guards, so if the lock and the
 * work drew from the same pool they would compete for connections and, on a
 * small pool, deadlock (a lock holder pinning the connection its own body
 * needs). Two pools means a lock never blocks a body and a body never blocks
 * a lock, whatever the sizes.
 */
export type LockClient = Sql;

export function createLockClient(
  databaseUrl: string,
  max = 4,
): { client: LockClient; close: () => Promise<void> } {
  const client = postgres(databaseUrl, {
    max,
    // No prepared statements: these connections only ever run two fixed
    // advisory-lock calls, and reserved connections outlive a statement cache.
    prepare: false,
    onnotice: () => {},
    // A lock call that hangs is a bug; do not let it pin a lock connection.
    connection: { statement_timeout: 10_000 },
  });
  return { client, close: () => client.end() };
}

/**
 * Run `work` under a SESSION-level advisory lock held on a connection from the
 * DEDICATED lock pool, so exactly one holder across every process runs it at a
 * time.
 *
 * Not transaction-scoped, and that is the whole point. The previous shape
 * wrapped the body in `db.transaction()` and took a `pg_try_advisory_xact_lock`
 * inside it, so the body's own queries — each needing a connection from the
 * same small pool — had to be served while one connection sat idle holding the
 * lock. Four such sweeps sharing a three-connection worker pool deadlocked
 * about an hour after boot, silently, with a healthy liveness probe. Here the
 * lock lives on its own pool and the body uses the working pool untouched.
 * Returns false for the loser, which is information, not an error.
 */
export async function withAdvisoryLock(
  lock: LockClient,
  classId: number,
  name: string,
  work: () => Promise<void>,
): Promise<boolean> {
  const conn = await lock.reserve();
  try {
    const rows = await conn`SELECT pg_try_advisory_lock(${classId}, hashtext(${name})) AS locked`;
    if (!rows[0]?.locked) return false;
    try {
      await work();
      return true;
    } finally {
      await conn`SELECT pg_advisory_unlock(${classId}, hashtext(${name}))`;
    }
  } finally {
    conn.release();
  }
}

/**
 * Run `fn` inside a transaction pinned to one tenant. SET LOCAL scopes the
 * setting to this transaction only — no leakage across pooled connections.
 */
export async function withBusiness<T>(
  db: Db,
  businessId: string,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) {
    throw new Error('withBusiness: businessId must be a UUID');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.business_id', ${businessId}, true)`);
    return fn(tx);
  });
}

/**
 * Pin `app.user_id` for one transaction — the bootstrap counterpart to
 * `withBusiness`.
 *
 * Answering "which businesses may this user enter?" necessarily happens before
 * a tenant is known, so it cannot be done under a tenant pin. The policy this
 * unlocks (migrations/0002_identity.sql) is SELECT-only and covers exactly one
 * table, `memberships`. Writes remain reachable only through
 * `tenant_isolation`, so a pinned user can discover memberships and never mint
 * one.
 */
export async function withUser<T>(
  db: Db,
  userId: string,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('withUser: userId must be a UUID');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

export { schema };
