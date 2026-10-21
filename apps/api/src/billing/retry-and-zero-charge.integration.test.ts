/**
 * Plan-change retries and zero-kobo upgrades (G-105).
 *
 * Three ways a merchant was left with a charge they could not use:
 *  - an upgrade priced at ₦0 (under a day left) opened an unpayable charge;
 *  - a first purchase of a different plan the same Lagos day was handed the
 *    FIRST plan's charge, labelled as the new plan;
 *  - a failed first purchase or renewal held its cycle forever, so every retry
 *    was refused.
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
import { applySettledCharge, BillingService } from './billing.service.js';

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
  await closeApp?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const config = { planCatalogueReads: false, paystackPlatformConfirmed: true };
const billing = () => new BillingService(config as never, appDb);

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481710${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Retry Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const DAY = 86_400_000;

/** A paid plan whose current cycle ends `msLeft` from now. */
async function onPlan(businessId: string, plan: string, msLeft: number): Promise<void> {
  await billingRepo.setPlan(appDb, {
    businessId,
    plan,
    expiresAt: new Date(Date.now() + msLeft),
    actor: 'operator:test-g105',
  });
}

const subscription = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId));

const chargesOf = (businessId: string) =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{
      reference: string;
      plan: string | null;
      kind: string;
      status: string;
      amount_k: string;
      superseded_at: string | null;
    }>(sql`
      SELECT reference, plan, kind, status, amount_k::text AS amount_k, superseded_at
      FROM subscription_charges ORDER BY created_at
    `);
    return [...rows];
  });

describe('an upgrade that costs nothing', () => {
  it('under a day left switches at once and opens no charge', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', 10 * 3_600_000);
    const before = await subscription(businessId);

    const answer = await billing().changePlan(businessId, 'complete');

    expect(answer).toMatchObject({ state: 'applied', plan: 'complete' });
    const after = await subscription(businessId);
    expect(after?.plan).toBe('complete');
    expect(after?.planExpiresAt?.getTime()).toBe(before?.planExpiresAt?.getTime());
    // Nothing for the merchant to pay, so no unpayable ₦0 payment link.
    expect((await chargesOf(businessId)).filter((c) => c.status === 'pending')).toEqual([]);
  });

  it('a cycle that has already ended is refused, not switched for free', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', -2 * DAY);
    await ownerDb.execute(sql`UPDATE businesses SET payment_failed_at = now() - interval '1 day'`);

    const answer = await billing().changePlan(businessId, 'complete');

    expect(answer).toEqual({ state: 'unavailable', reason: 'cycle_ended' });
    expect((await subscription(businessId))?.plan).toBe('chat');
    expect(await chargesOf(businessId)).toEqual([]);
  });
});

describe('a first purchase is retryable and plan-specific', () => {
  it('a different plan the same day gets its own charge, not the first plan’s', async () => {
    const businessId = await seedBusiness();

    const first = await billing().changePlan(businessId, 'chat');
    const second = await billing().changePlan(businessId, 'complete');

    if (first.state !== 'payment_required' || second.state !== 'payment_required') {
      throw new Error('both should be payable');
    }
    expect(second.reference).not.toBe(first.reference);
    expect(second.plan).toBe('complete');
    expect(second.amountK).toBeGreaterThan(first.amountK);

    const rows = await chargesOf(businessId);
    expect(rows.find((c) => c.reference === second.reference)?.plan).toBe('complete');
    // The abandoned link cannot be handed out again.
    expect(rows.find((c) => c.reference === first.reference)?.superseded_at).not.toBeNull();
  });

  it('paying the second plan’s charge buys the second plan', async () => {
    const businessId = await seedBusiness();
    await billing().changePlan(businessId, 'chat');
    const second = await billing().changePlan(businessId, 'complete');
    if (second.state !== 'payment_required') throw new Error('payable');

    await withBusiness(appDb, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: second.reference,
        providerReference: 'ps_second',
        when: new Date(),
        config,
      }),
    );

    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('a failed first purchase can be retried', async () => {
    const businessId = await seedBusiness();
    const first = await billing().changePlan(businessId, 'chat');
    if (first.state !== 'payment_required') throw new Error('payable');
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.settleCharge(tx, {
        reference: first.reference,
        status: 'failed',
        failureReason: 'declined',
        when: new Date(),
      }),
    );

    const retry = await billing().changePlan(businessId, 'chat');

    expect(retry.state).toBe('payment_required');
    if (retry.state === 'payment_required') expect(retry.reference).not.toBe(first.reference);
  });
});

describe('a failed renewal does not hold its cycle', () => {
  it('a second renewal charge for the same period can be opened after the first failed', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', -1 * DAY);
    const periodStart = (await subscription(businessId))?.planExpiresAt ?? new Date();
    const open = (reference: string) =>
      withBusiness(appDb, businessId, (tx) =>
        subscriptionsRepo.openCharge(tx, {
          businessId,
          kind: 'renewal',
          plan: 'chat',
          amountK: 990_000,
          reference,
          periodStart,
        }),
      );

    expect(await open('RKD-SUB-RENEW-A')).not.toBeNull();
    // While the first is still pending the cycle is held (no double charge).
    expect(await open('RKD-SUB-RENEW-DUP')).toBeNull();

    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.settleCharge(tx, {
        reference: 'RKD-SUB-RENEW-A',
        status: 'failed',
        failureReason: 'declined',
        when: new Date(),
      }),
    );

    expect(await open('RKD-SUB-RENEW-B')).not.toBeNull();
  });
});
