/**
 * A payment for an OLD subscription decision never overwrites a NEWER one
 * (G-104, G-112).
 *
 * Two facts are kept apart. PAYMENT TRUTH: the provider took the money, so the
 * charge is recorded `paid` and stays in the billing history whatever happens
 * next. ENTITLEMENT: what that payment was meant to buy (a renewal, an
 * upgrade, a first purchase) applies only if nothing newer was decided about
 * the subscription after the charge was opened. A charge that lost that race
 * is marked superseded for an operator to reconcile; no refund policy is
 * invented here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  billingRepo,
  createDb,
  identity,
  sql,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { applySettledCharge } from './billing.service.js';

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const config = { planCatalogueReads: false };
const renewsAt = new Date(Date.now() + 20 * 86_400_000);

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481700${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Stale Charge Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const operator = (businessId: string, plan: string, expiresAt: Date | null = renewsAt) =>
  billingRepo.setPlan(appDb, { businessId, plan, expiresAt, actor: 'operator:test-g104' });

const open = (
  businessId: string,
  kind: 'first_purchase' | 'renewal' | 'upgrade' | 'add_on',
  reference: string,
  plan: string | null,
) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind,
      ...(plan ? { plan } : {}),
      ...(kind === 'add_on' ? { packId: 'messages_100' } : {}),
      amountK: 990_000,
      reference,
    }),
  );

const settle = (businessId: string, reference: string) =>
  withBusiness(appDb, businessId, (tx) =>
    applySettledCharge(tx, {
      businessId,
      reference,
      providerReference: `ps_${reference}`,
      when: new Date(),
      config,
    }),
  );

const subscription = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId));

const chargeRow = (businessId: string, reference: string) =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{ status: string; superseded_at: string | null }>(sql`
      SELECT status, superseded_at FROM subscription_charges WHERE reference = ${reference}
    `);
    return [...rows][0];
  });

describe('a stale paid charge keeps the payment and refuses the plan change', () => {
  it('a pending Complete renewal does not overwrite an operator move to Chat', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-1', 'complete');

    await operator(businessId, 'chat');
    const outcome = await settle(businessId, 'RKD-SUB-STALE-1');

    expect(outcome).toBe('superseded');
    expect((await subscription(businessId))?.plan).toBe('chat');
    const charge = await chargeRow(businessId, 'RKD-SUB-STALE-1');
    expect(charge?.status).toBe('paid'); // the money really arrived
    expect(charge?.superseded_at).not.toBeNull(); // and is surfaced for reconciliation
  });

  it('a pending upgrade does not apply after the operator changed the subscription', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'chat');
    await open(businessId, 'upgrade', 'RKD-SUB-STALE-2', 'complete');

    await operator(businessId, 'integrate');
    const outcome = await settle(businessId, 'RKD-SUB-STALE-2');

    expect(outcome).toBe('superseded');
    expect((await subscription(businessId))?.plan).toBe('integrate');
  });

  it('a pending renewal does not undo a cancellation made after it was opened', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-3', 'complete');

    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
    );
    const outcome = await settle(businessId, 'RKD-SUB-STALE-3');

    expect(outcome).toBe('superseded');
    const sub = await subscription(businessId);
    expect(sub?.pendingPlan).toBe('expired'); // the cancellation still stands
    expect((await chargeRow(businessId, 'RKD-SUB-STALE-3'))?.status).toBe('paid');
  });

  it('undoing a cancellation is not a newer decision: the open renewal still renews', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
    );
    await open(businessId, 'renewal', 'RKD-SUB-STALE-4', 'complete');

    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, null),
    );

    expect(await settle(businessId, 'RKD-SUB-STALE-4')).toBe('applied');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('the second of two first purchases is superseded by the first', async () => {
    const businessId = await seedBusiness();
    await open(businessId, 'first_purchase', 'RKD-SUB-STALE-5A', 'chat');
    await open(businessId, 'first_purchase', 'RKD-SUB-STALE-5B', 'complete');

    expect(await settle(businessId, 'RKD-SUB-STALE-5B')).toBe('applied');
    expect(await settle(businessId, 'RKD-SUB-STALE-5A')).toBe('superseded');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('a replayed stale event changes nothing a second time', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-6', 'complete');
    await operator(businessId, 'chat');

    expect(await settle(businessId, 'RKD-SUB-STALE-6')).toBe('superseded');
    const first = await chargeRow(businessId, 'RKD-SUB-STALE-6');
    expect(await settle(businessId, 'RKD-SUB-STALE-6')).toBe('already_settled');

    expect(await chargeRow(businessId, 'RKD-SUB-STALE-6')).toEqual(first);
    expect((await subscription(businessId))?.plan).toBe('chat');
  });
});

describe('a charge that is still current settles normally', () => {
  it('a renewal opened after the last decision renews', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-CURRENT-1', 'complete');

    expect(await settle(businessId, 'RKD-SUB-CURRENT-1')).toBe('applied');
    const charge = await chargeRow(businessId, 'RKD-SUB-CURRENT-1');
    expect(charge?.status).toBe('paid');
    expect(charge?.superseded_at).toBeNull();
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('a replayed current event applies exactly once', async () => {
    const businessId = await seedBusiness();
    await open(businessId, 'first_purchase', 'RKD-SUB-CURRENT-2', 'chat');

    expect(await settle(businessId, 'RKD-SUB-CURRENT-2')).toBe('applied');
    expect(await settle(businessId, 'RKD-SUB-CURRENT-2')).toBe('already_settled');
  });

  it('a pack bought before an operator plan move still grants its units', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'chat');
    await open(businessId, 'add_on', 'RKD-PACK-STALE-1', null);
    await operator(businessId, 'integrate');

    expect(await settle(businessId, 'RKD-PACK-STALE-1')).toBe('applied');
  });
});
