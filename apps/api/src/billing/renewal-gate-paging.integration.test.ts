/**
 * OWN-70: once the payment gate opens the sweep closes every blocked renewal, even when the
 * oldest ones cannot be closed. A page of persistent failures must not keep the later blocks open
 * (CodeRabbit on #432, `renewal-sweep.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { sweepRenewals } from './renewal-sweep.js';

const DAY = 86_400_000;
const LIVE = ['sk', 'live', 'p'.repeat(24)].join('_');
const gate = (paystackPlatformConfirmed: boolean) => ({
  planCatalogueReads: false,
  paystackSecretKey: LIVE,
  paystackPlatformConfirmed,
});

let urls: Urls;
let db: Db;
let workerDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (db = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db: made, close } = createDb(url, { max: 4 });
    set(made);
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

let seq = 0;
async function dueBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481940000${String(seq).padStart(2, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const renewsAt = new Date(Date.now() - DAY);
  await withBusiness(db, business.id, (tx) =>
    subscriptionsRepo.applyCycle(tx, business.id, {
      plan: 'chat',
      cycleStartedAt: new Date(renewsAt.getTime() - 30 * DAY),
      renewsAt,
      anchorDay: renewsAt.getUTCDate(),
    }),
  );
  return business.id;
}

describe('closing blocked renewals after the gate opens', () => {
  it('closes the later blocks when the oldest ones persistently fail to close', async () => {
    for (let i = 0; i < 4; i++) await dueBusiness();
    // The live key without the §47 confirmation: four renewals raised and blocked.
    await sweepRenewals({ workerDb, appDb: db, config: gate(false) });
    const blocked = await subscriptionsRepo.blockedRenewals(workerDb, 50);
    expect(blocked).toHaveLength(4);

    // The two oldest cannot be closed (a persistent failure on their rows).
    const stuck = blocked.slice(0, 2).map((b) => b.reference);
    await ownerDb.execute(sql`
      CREATE FUNCTION refuse_block_close() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'cannot close'; END $f$`);
    await ownerDb.execute(
      sql.raw(`CREATE TRIGGER refuse_block_close BEFORE UPDATE ON subscription_charges
        FOR EACH ROW WHEN (OLD.reference IN (${stuck.map((r) => `'${r}'`).join(',')})
                           AND NEW.blocked_resolved_at IS NOT NULL)
        EXECUTE FUNCTION refuse_block_close()`),
    );

    // The gate opens; the page holds one row at a time, so the two stuck rows fill the first pages.
    await sweepRenewals({ workerDb, appDb: db, config: gate(true), blockPageSize: 1 });

    const still = await subscriptionsRepo.blockedRenewals(workerDb, 50);
    expect(still.map((b) => b.reference).sort()).toEqual([...stuck].sort());
    expect(await subscriptionsRepo.blockedRenewalCount(workerDb)).toBe(2);
  });
});
