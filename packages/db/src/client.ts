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
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type TenantDb = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createDb(databaseUrl: string): { db: Db; close: () => Promise<void> } {
  const client = postgres(databaseUrl, {
    max: 10,
    // Financial writes must never be silently retried by the driver.
    prepare: true,
    onnotice: () => {},
  });
  return { db: drizzle(client, { schema }), close: () => client.end() };
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
  if (!/^[0-9a-f-]{36}$/i.test(businessId)) {
    throw new Error('withBusiness: businessId must be a UUID');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.business_id', ${businessId}, true)`);
    return fn(tx);
  });
}

export { schema };
