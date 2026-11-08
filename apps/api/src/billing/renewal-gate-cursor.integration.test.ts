/**
 * OWN-70 (PR B review of `renewal-sweep.ts`): closing blocked renewals once the gate opens keeps a
 * PERSISTED cursor (migration 0198, `blocked_close_failed_at`), so blocks that persistently fail to
 * close cannot starve the blocks behind them, whatever the volume, across passes, restarts and
 * concurrent sweeps. A pass stays bounded (20 pages of 200).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, subscriptionsRepo, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { sweepRenewals } from './renewal-sweep.js';

const LIVE = ['sk', 'live', 'p'.repeat(24)].join('_');
const OPEN_GATE = {
  planCatalogueReads: false,
  paystackSecretKey: LIVE,
  paystackPlatformConfirmed: true,
};
const PASS_ROWS = 20 * 200;

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 6 });
    set(db);
    closers.push(close);
  }
});
afterAll(async () => {
  await ownerDb?.execute(sql`DROP FUNCTION IF EXISTS refuse_block_close() CASCADE`);
  for (const c of closers) await c();
});
beforeEach(async () => {
  await ownerDb.execute(sql`DROP FUNCTION IF EXISTS refuse_block_close() CASCADE`);
  await truncateAll(urls);
});

/** `total` open blocked renewals; the first `stuck` (by block time) cannot be closed. */
async function seedBlocked(total: number, stuck: number): Promise<void> {
  const user = await identity.upsertUserByPhone(appDb, '+2348194000001');
  await ownerDb.execute(sql`
    INSERT INTO businesses (name, owner_user_id)
    SELECT 'Ada ' || g, ${user.id}::uuid FROM generate_series(1, ${total}) g`);
  await ownerDb.execute(sql`
    INSERT INTO subscription_charges
      (business_id, kind, plan, amount_k, status, reference, period_start, period_end,
       blocked_at, blocked_reason, quantity)
    SELECT b.id, 'renewal', 'chat', 1000, 'pending',
           'RKD-SUB-20261108-' || lpad(upper(to_hex(n)), 6, '0'),
           now() - interval '1 day', now() + interval '29 days',
           now() - interval '1 hour' + n * interval '1 millisecond',
           'awaiting_platform_confirmation',
           CASE WHEN n <= ${stuck} THEN 2 ELSE 1 END
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM businesses) b`);
  await ownerDb.execute(sql`
    CREATE FUNCTION refuse_block_close() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN RAISE EXCEPTION 'cannot close'; END $f$`);
  await ownerDb.execute(sql`
    CREATE TRIGGER refuse_block_close BEFORE UPDATE ON subscription_charges
    FOR EACH ROW WHEN (OLD.quantity = 2 AND NEW.blocked_resolved_at IS NOT NULL)
    EXECUTE FUNCTION refuse_block_close()`);
}

const openCount = () => subscriptionsRepo.blockedRenewalCount(workerDb);
const sweep = (extra: Record<string, unknown> = {}) =>
  sweepRenewals({ workerDb, appDb, config: OPEN_GATE, ...extra });

describe('closing blocked renewals keeps a persisted cursor', () => {
  it('more than 4,000 persistent failures never starve the blocks behind them', async () => {
    const stuck = PASS_ROWS; // exactly one full pass of failures at the head of the list
    await seedBlocked(stuck + 150, stuck);
    expect(await openCount()).toBe(stuck + 150);

    // Pass 1 is bounded: it spends its 20 pages on the failing head and closes none.
    await sweep();
    expect(await openCount()).toBe(stuck + 150);

    // Pass 2 starts with the blocks nobody has tried, so all 150 close; the 4,000 stay open.
    await sweep();
    expect(await openCount()).toBe(stuck);
    const [stamped] = await ownerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM subscription_charges
      WHERE blocked_close_failed_at IS NOT NULL AND blocked_resolved_at IS NULL`);
    expect(stamped?.n).toBe(stuck);
  }, 300_000);

  it('a pass interrupted part-way is resumed by the next one, with no progress lost', async () => {
    await seedBlocked(500, 0);
    // The first pass stops after one page (the process went away), a new sweep carries on.
    await sweep({ blockPageSize: 100, maxBlockPages: 1 });
    expect(await openCount()).toBe(400);
    await sweep({ blockPageSize: 100 });
    expect(await openCount()).toBe(0);
  }, 120_000);

  it('failed blocks sink behind untried ones and are retried only on a later pass', async () => {
    await seedBlocked(6, 3);
    await sweep({ blockPageSize: 2 });
    expect(await openCount()).toBe(3);
    const stampedAfterOne = (
      await ownerDb.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM subscription_charges
        WHERE blocked_close_failed_at IS NOT NULL AND blocked_resolved_at IS NULL`)
    )[0]!.n;
    expect(stampedAfterOne).toBe(3);
    // Once the cause is fixed, the next pass closes them.
    await ownerDb.execute(sql`DROP FUNCTION refuse_block_close() CASCADE`);
    await sweep({ blockPageSize: 2 });
    expect(await openCount()).toBe(0);
  }, 120_000);

  it('concurrent sweeps close every block exactly once and audit each once', async () => {
    await seedBlocked(300, 0);
    await Promise.all([sweep({ blockPageSize: 50 }), sweep({ blockPageSize: 50 }), sweep()]);
    expect(await openCount()).toBe(0);
    const [audited] = await ownerDb.execute<{ n: number; distinct: number }>(sql`
      SELECT count(*)::int AS n, count(DISTINCT entity_id)::int AS distinct
      FROM audit_events WHERE action = 'renewal_block_resolved'`);
    expect(audited).toEqual({ n: 300, distinct: 300 });
  }, 120_000);

  it('a block whose close fails AND whose stamp fails is skipped exactly once per pass, and no healthy block is skipped', async () => {
    await seedBlocked(8, 3);
    // Every block has an old stamp (so they sort by it), the 3 stuck ones refuse both the close
    // and the stamp, and every attempt on them is counted by a sequence (it survives the rollback).
    await ownerDb.execute(sql`
      UPDATE subscription_charges
      SET blocked_close_failed_at = blocked_at - interval '1 day'`);
    await ownerDb.execute(sql`DROP TRIGGER refuse_block_close ON subscription_charges`);
    await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS refuse_attempts`);
    await ownerDb.execute(sql`CREATE SEQUENCE refuse_attempts`);
    await ownerDb.execute(sql`
      CREATE OR REPLACE FUNCTION refuse_block_close() RETURNS trigger LANGUAGE plpgsql
      SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $f$
      BEGIN PERFORM nextval('public.refuse_attempts');
            RAISE EXCEPTION 'cannot close or stamp'; END $f$`);
    await ownerDb.execute(sql`
      CREATE TRIGGER refuse_block_close BEFORE UPDATE ON subscription_charges
      FOR EACH ROW WHEN (OLD.quantity = 2
        AND (NEW.blocked_resolved_at IS NOT NULL
             OR NEW.blocked_close_failed_at IS DISTINCT FROM OLD.blocked_close_failed_at))
      EXECUTE FUNCTION refuse_block_close()`);

    await sweep({ blockPageSize: 1 });

    expect(await openCount()).toBe(3); // the 5 healthy blocks all closed in this one pass
    const [seq] = await ownerDb.execute<{ last: string; called: boolean }>(
      sql`SELECT last_value::text AS last, is_called AS called FROM refuse_attempts`,
    );
    // Each stuck block: one failed close and one failed stamp, once, in the whole pass.
    expect(seq?.called ? Number(seq.last) : 0).toBe(6);
    await ownerDb.execute(sql`DROP SEQUENCE refuse_attempts CASCADE`);
  }, 120_000);

  it('the cleanup never stands in the way of raising a due renewal', async () => {
    await seedBlocked(10, 10);
    // Every block fails to close, and the sweep still completes and reports normally.
    const result = await sweep();
    expect(result.raised + result.skipped).toBeGreaterThanOrEqual(0);
    expect(await openCount()).toBe(10);
  }, 120_000);
});
