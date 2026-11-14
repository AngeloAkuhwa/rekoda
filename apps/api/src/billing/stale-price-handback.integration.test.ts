/**
 * A pending charge at a price other than today's is never handed back as what is owed, and never
 * strands the merchant either (review of fe9c3c5, finding 1). An upgrade is prorated on whole days
 * left, so yesterday's honest, unpaid upgrade no longer matches today's price; a pack's price
 * moves with the catalogue. Either is retired and today's charge opened in its place.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, withBusiness, type Db } from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
  setPricingSource,
} from '@rekoda/db/testing';
import { BillingService } from './billing.service.js';
import { honestTerms } from './priced-charge.fixtures.js';

let urls: Urls;
let appDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 4 });
    set(db);
    closers.push(close);
  }
});

afterAll(async () => {
  for (const close of closers) await close();
});

beforeEach(async () => {
  await truncateAll(urls);
  /* This suite prices from the compiled constants; the database is told so (OD-51.6, 0215). */
  await setPricingSource(urls, 'constants');
});

const DAY = 86_400_000;
const config = { planCatalogueReads: false, paystackSecretKey: 'sk_test_x' };
const billing = () => new BillingService(config as never, appDb);

let seq = 0;
/** A provider-bought Chat cycle with 20 days left, decided well before any charge here. */
async function onChat(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481790${String(seq).padStart(4, '0')}`);
  const { id } = await identity.createBusinessWithOwner(appDb, {
    name: 'Stale Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  const renewsAt = new Date(Date.now() + 20 * DAY);
  await withBusiness(appDb, id, (tx) =>
    applyFixtureCycle(tx, id, {
      plan: 'chat',
      cycleStartedAt: new Date(renewsAt.getTime() - 30 * DAY),
      renewsAt,
      anchorDay: new Date(renewsAt.getTime() + 3_600_000).getUTCDate(),
    }),
  );
  /* Decided days ago, so yesterday's charge is not retired as stale (G-104) for another reason. */
  await ownerDb.execute(sql`UPDATE businesses SET subscription_origin = 'provider',
    plan_decided_at = now() - interval '3 days' WHERE id = ${id}::uuid`);
  return id;
}

/** Move a charge's opening and pricing back a day, at the price it would honestly have had then. */
async function openedYesterday(businessId: string, reference: string, amountK: number) {
  await ownerDb.execute(sql`UPDATE subscription_charges SET amount_k = ${amountK},
    created_at = created_at - interval '1 day', priced_at = priced_at - interval '1 day'
    WHERE business_id = ${businessId}::uuid AND reference = ${reference}`);
}

const pendingOf = async (businessId: string) => [
  ...(await ownerDb.execute<{ reference: string; amount_k: string; superseded: boolean }>(sql`
      SELECT reference, amount_k::text, superseded_at IS NOT NULL AS superseded
      FROM subscription_charges WHERE business_id = ${businessId}::uuid AND status = 'pending'
      ORDER BY created_at`)),
];

describe('a pending charge priced on another day', () => {
  it("an upgrade asked for again a day later opens today's price instead of refusing", async () => {
    const businessId = await onChat();
    const first = await billing().changePlan(businessId, 'complete');
    if (first.state !== 'payment_required') throw new Error(`payable, got ${first.state}`);
    const yesterday = new Date(Date.now() - DAY);
    const then = await withBusiness(appDb, businessId, (tx) =>
      honestTerms(
        tx,
        config as never,
        { businessId, kind: 'upgrade', plan: 'complete' },
        yesterday,
      ),
    );
    expect(then!.amountK).toBeGreaterThan(first.amountK);
    await openedYesterday(businessId, first.reference, then!.amountK);

    const again = await billing().changePlan(businessId, 'complete');

    expect(again).toMatchObject({ state: 'payment_required', amountK: first.amountK });
    if (again.state !== 'payment_required') return;
    expect(again.reference).not.toBe(first.reference);
    expect(await pendingOf(businessId)).toEqual([
      { reference: first.reference, amount_k: String(then!.amountK), superseded: true },
      { reference: again.reference, amount_k: String(first.amountK), superseded: false },
    ]);
  });

  it('the same upgrade asked for twice on the same day is still handed back, not reopened', async () => {
    const businessId = await onChat();
    const first = await billing().changePlan(businessId, 'complete');
    expect(await billing().changePlan(businessId, 'complete')).toEqual(first);
    expect((await pendingOf(businessId)).length).toBe(1);
  });

  it("a pack whose pending charge is not at today's price opens today's price", async () => {
    /* The stored amount is moved, not the catalogue: what this pins is the slot, which a repriced
     * pack and a charge this code never opened (OD-51) both reach the same way. */
    const businessId = await onChat();
    const first = await billing().buyPack(businessId, 'documents_50');
    if (first.state !== 'payment_required') throw new Error(`payable, got ${first.state}`);
    await openedYesterday(businessId, first.reference, first.amountK + 10_000);

    const again = await billing().buyPack(businessId, 'documents_50');

    expect(again).toMatchObject({ state: 'payment_required', amountK: first.amountK });
    if (again.state !== 'payment_required') return;
    expect(again.reference).not.toBe(first.reference);
    expect((await pendingOf(businessId)).map((row) => row.superseded)).toEqual([true, false]);
  });
});
