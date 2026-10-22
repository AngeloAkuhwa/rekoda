/**
 * Who created the current paid cycle is a stored fact (G-115, OWN-33,
 * migration 0167), written by the one subscription-state writer and
 * backfilled only from persisted evidence. Unknown stays unknown.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { billingRepo, identity, subscriptionsRepo } from './index.js';
import { migrate, requireUrls, resetPlanCatalogue, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;
let ownerDb: Db;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await resetPlanCatalogue(urls);
  await closeApp?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  await resetPlanCatalogue(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481600000${String(seq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Origin Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const originOf = async (businessId: string) => {
  const subscription = await withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.subscriptionFor(tx, businessId),
  );
  if (!subscription) throw new Error('business missing');
  return subscription.origin;
};

const START = new Date('2026-08-01T00:00:00Z');
const RENEWS = new Date('2026-09-01T00:00:00Z');

const providerCycle = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.applyCycle(tx, businessId, {
      plan: 'chat',
      cycleStartedAt: START,
      renewsAt: RENEWS,
      anchorDay: 1,
    }),
  );

describe('the state writer records who created the cycle', () => {
  it('a settled provider cycle is provider-origin', async () => {
    const id = await seedBusiness();
    await providerCycle(id);
    expect(await originOf(id)).toBe('provider');
  });

  it('an operator plan change replaces a provider origin, even for 30 days', async () => {
    const id = await seedBusiness();
    await providerCycle(id);
    await billingRepo.setPlan(appDb, {
      businessId: id,
      plan: 'complete',
      expiresAt: new Date('2026-09-15T00:00:00Z'),
      actor: 'operator:test',
    });
    expect(await originOf(id)).toBe('operator');
  });

  it('re-posting the identical operator cycle keeps the origin it had', async () => {
    const id = await seedBusiness();
    await billingRepo.setPlan(appDb, {
      businessId: id,
      plan: 'chat',
      expiresAt: RENEWS,
      actor: 'operator:test',
    });
    await billingRepo.setPlan(appDb, {
      businessId: id,
      plan: 'chat',
      expiresAt: RENEWS,
      actor: 'operator:test',
    });
    expect(await originOf(id)).toBe('operator');
    await providerCycle(id);
    await billingRepo.setPlan(appDb, {
      businessId: id,
      plan: 'chat',
      expiresAt: RENEWS,
      actor: 'operator:test',
    });
    expect(await originOf(id)).toBe('provider');
  });

  it('an unpaid plan has no origin', async () => {
    const id = await seedBusiness();
    await providerCycle(id);
    await billingRepo.setPlan(appDb, {
      businessId: id,
      plan: 'expired',
      expiresAt: null,
      actor: 'operator:test',
    });
    expect(await originOf(id)).toBeNull();
  });
});

describe('the 0167 backfill uses persisted evidence only', () => {
  const backfill = () => {
    const file = readFileSync(
      new URL('../migrations/0167_subscription_origin.sql', import.meta.url),
      'utf8',
    );
    return ownerDb.execute(sql.raw(file.slice(file.indexOf('UPDATE businesses b'))));
  };
  const addCharge = (businessId: string, paidAt: string) =>
    ownerDb.execute(sql`
      INSERT INTO subscription_charges
        (business_id, kind, plan, amount_k, status, reference, paid_at)
      VALUES (${businessId}::uuid, 'first_purchase', 'chat', 100, 'paid',
              ${'ref-' + businessId}, ${paidAt}::timestamptz)`);
  const clear = () => ownerDb.execute(sql`UPDATE businesses SET subscription_origin = NULL`);

  it('provider when a settled charge for the current plan is the latest evidence', async () => {
    const id = await seedBusiness();
    await providerCycle(id);
    await addCharge(id, '2099-01-01T00:00:00Z');
    await clear();
    await backfill();
    expect(await originOf(id)).toBe('provider');
  });

  it('operator when an operator move is the latest evidence', async () => {
    const id = await seedBusiness();
    await addCharge(id, '2020-01-01T00:00:00Z');
    await billingRepo.setPlan(appDb, {
      businessId: id,
      plan: 'chat',
      expiresAt: RENEWS,
      actor: 'operator:test',
    });
    await clear();
    await backfill();
    expect(await originOf(id)).toBe('operator');
  });

  it('stays unknown with no evidence, and for an unpaid plan', async () => {
    const noEvidence = await seedBusiness();
    await ownerDb.execute(
      sql`UPDATE businesses SET plan = 'chat', plan_expires_at = ${RENEWS.toISOString()}::timestamptz, cycle_started_at = ${START.toISOString()}::timestamptz WHERE id = ${noEvidence}::uuid`,
    );
    const trial = await seedBusiness();
    await clear();
    await backfill();
    expect(await originOf(noEvidence)).toBeNull();
    expect(await originOf(trial)).toBeNull();
  });
});
