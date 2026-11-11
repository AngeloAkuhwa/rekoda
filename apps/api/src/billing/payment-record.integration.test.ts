/**
 * The payment record page's data (billing Slice A): one payment in full, from the charge's own row.
 *
 * Asserted on the states a merchant must be able to tell apart: a started payment is not a paid
 * one, money received is not entitlement applied, a replaced charge is not awaiting payment, and a
 * part refund is not a full refund. Another business's reference reads as nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { billingPaymentRecord } from '@rekoda/contracts';
import { createDb, identity, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
import { settlementDb } from '@rekoda/db/testing';
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

const config = { planCatalogueReads: false };
const service = () => new BillingService(config as never, appDb, settlementDb());

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481600${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Payment Record Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const open = (businessId: string, reference: string, over: { pack?: boolean } = {}) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind: over.pack ? 'add_on' : 'first_purchase',
      ...(over.pack ? { packId: 'messages_100' } : { plan: 'chat' }),
      amountK: 990_000,
      reference,
      ...(over.pack
        ? {}
        : {
            periodStart: new Date('2026-11-01T00:00:00Z'),
            periodEnd: new Date('2026-12-01T00:00:00Z'),
          }),
    }),
  );

const set = (reference: string, assignments: ReturnType<typeof sql>) =>
  ownerDb.execute(
    sql`UPDATE subscription_charges SET ${assignments} WHERE reference = ${reference}`,
  );

describe('payment record', () => {
  it('a started payment is awaiting payment: no paid date, no applied claim', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-AAAAAA');

    const record = await service().paymentRecord(b, 'RKD-SUB-20261101-AAAAAA');

    expect(record).toMatchObject({
      state: 'awaiting_payment',
      status: 'pending',
      paidAt: null,
      paidAmountK: null,
      applied: false,
      amountK: 990_000,
      currency: 'NGN',
      plan: 'chat',
    });
  });

  it('a verified payment that took effect is paid and applied, with its paid date', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-BBBBBB');
    await withBusiness(settlementDb(), b, (tx) =>
      applySettledCharge(tx, {
        businessId: b,
        reference: 'RKD-SUB-20261101-BBBBBB',
        providerReference: 'ps_BBBBBB',
        when: new Date('2026-11-01T10:00:00Z'),
        config,
      }),
    );

    const record = await service().paymentRecord(b, 'RKD-SUB-20261101-BBBBBB');

    expect(record).toMatchObject({ state: 'paid_applied', status: 'paid', applied: true });
    expect(record!.paidAt).not.toBeNull();
    /* The cycle ACTUALLY bought: a first purchase starts when it settles (1 Nov 10:00 UTC), not at
     * the estimate made when the checkout was opened (1 Nov 00:00 UTC). */
    expect(record!.periodStart).toBe('2026-11-01T10:00:00.000Z');
    expect(new Date(record!.periodEnd!).getTime()).toBeGreaterThan(
      new Date('2026-11-27T00:00:00Z').getTime(),
    );
  });

  it('money received but refused as stale is paid_not_applied, never an applied plan', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-CCCCCC');
    await set(
      'RKD-SUB-20261101-CCCCCC',
      sql`status = 'paid', paid_at = now(), unapplied_at = now(), unapplied_reason = 'stale'`,
    );

    const open1 = await service().paymentRecord(b, 'RKD-SUB-20261101-CCCCCC');
    expect(open1).toMatchObject({ state: 'paid_not_applied', applied: false, reconciled: false });

    await set('RKD-SUB-20261101-CCCCCC', sql`unapplied_resolved_at = now()`);
    expect(await service().paymentRecord(b, 'RKD-SUB-20261101-CCCCCC')).toMatchObject({
      state: 'paid_not_applied',
      reconciled: true,
    });
  });

  it('a pending charge the merchant replaced is replaced, not awaiting payment', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-DDDDDD');
    await set('RKD-SUB-20261101-DDDDDD', sql`abandoned_at = now()`);

    expect(await service().paymentRecord(b, 'RKD-SUB-20261101-DDDDDD')).toMatchObject({
      state: 'replaced',
      status: 'pending',
      paidAt: null,
    });
  });

  it('a failed payment is failed, with no paid date', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-EEEEEE');
    await set('RKD-SUB-20261101-EEEEEE', sql`status = 'failed', failed_at = now()`);

    const record = await service().paymentRecord(b, 'RKD-SUB-20261101-EEEEEE');

    expect(record).toMatchObject({ state: 'failed', applied: false, paidAt: null });
    expect(record!.failedAt).not.toBeNull();
  });

  it('a part refund and a full refund are different states with their amounts', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-FFFFFF');
    await set(
      'RKD-SUB-20261101-FFFFFF',
      sql`status = 'paid', paid_at = now(), paid_amount_k = 990000, refunded_amount_k = 100000`,
    );
    expect(await service().paymentRecord(b, 'RKD-SUB-20261101-FFFFFF')).toMatchObject({
      state: 'part_refunded',
      refundedAmountK: 100_000,
      paidAmountK: 990_000,
    });

    await set(
      'RKD-SUB-20261101-FFFFFF',
      sql`status = 'refunded', refunded_amount_k = 990000, refunded_at = now()`,
    );
    const full = await service().paymentRecord(b, 'RKD-SUB-20261101-FFFFFF');
    expect(full).toMatchObject({ state: 'refunded', refundedAmountK: 990_000 });
    expect(full!.refundedAt).not.toBeNull();
  });

  it('a payment that was applied and later fully refunded is still recorded as applied', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-JJJJJJ');
    await withBusiness(settlementDb(), b, (tx) =>
      applySettledCharge(tx, {
        businessId: b,
        reference: 'RKD-SUB-20261101-JJJJJJ',
        providerReference: 'ps_JJJJJJ',
        when: new Date('2026-11-01T10:00:00Z'),
        config,
      }),
    );
    await set(
      'RKD-SUB-20261101-JJJJJJ',
      sql`status = 'refunded', refunded_amount_k = 990000, refunded_at = now()`,
    );

    expect(await service().paymentRecord(b, 'RKD-SUB-20261101-JJJJJJ')).toMatchObject({
      state: 'refunded',
      applied: true,
    });
  });

  it('money refused as stale and then part-refunded is a part refund that was not applied', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-KKKKKK');
    await set(
      'RKD-SUB-20261101-KKKKKK',
      sql`status = 'paid', paid_at = now(), unapplied_at = now(), refunded_amount_k = 100000`,
    );

    expect(await service().paymentRecord(b, 'RKD-SUB-20261101-KKKKKK')).toMatchObject({
      state: 'part_refunded',
      applied: false,
    });
  });

  it('a charge stamped superseded, with no abandonment, is replaced', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-LLLLLL');
    await set('RKD-SUB-20261101-LLLLLL', sql`superseded_at = now()`);

    expect(await service().paymentRecord(b, 'RKD-SUB-20261101-LLLLLL')).toMatchObject({
      state: 'replaced',
    });
  });

  it('an overpayment shows what the provider took beside what was asked', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-MMMMMM');
    await set(
      'RKD-SUB-20261101-MMMMMM',
      sql`status = 'paid', paid_at = now(), paid_amount_k = 1000000`,
    );

    expect(await service().paymentRecord(b, 'RKD-SUB-20261101-MMMMMM')).toMatchObject({
      amountK: 990_000,
      paidAmountK: 1_000_000,
    });
  });

  it('shows no period for a payment that bought none, whatever the charge was priced for', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-NNNNNN');
    await set('RKD-SUB-20261101-NNNNNN', sql`status = 'paid', paid_at = now()`);

    expect(await service().paymentRecord(b, 'RKD-SUB-20261101-NNNNNN')).toMatchObject({
      periodStart: null,
      periodEnd: null,
    });
  });

  it('an upgrade that cost nothing is recorded as applied with no payment taken', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-OOOOOO');
    await set(
      'RKD-SUB-20261101-OOOOOO',
      sql`status = 'paid', paid_at = now(), amount_k = 0, provider_reference = 'no_charge:RKD-SUB-20261101-OOOOOO'`,
    );

    expect(await service().paymentRecord(b, 'RKD-SUB-20261101-OOOOOO')).toMatchObject({
      noCharge: true,
      state: 'paid_applied',
    });
  });

  it('gives a merchant-safe family for why a payment was not applied, never the internal reason', async () => {
    const cases: [string, string, string][] = [
      ['RKD-SUB-20261101-PPPPP1', 'subscription_decided_after_charge', 'plan_changed'],
      ['RKD-SUB-20261101-PPPPP2', 'cycle_ended', 'period_ended'],
      ['RKD-SUB-20261101-PPPPP3', 'support_review', 'under_review'],
    ];
    for (const [reference, reason, family] of cases) {
      const b = await seedBusiness();
      await open(b, reference);
      await set(
        reference,
        sql`status = 'paid', paid_at = now(), unapplied_at = now(), unapplied_reason = ${reason}`,
      );
      const record = await service().paymentRecord(b, reference);
      expect(record, reference).toMatchObject({
        state: 'paid_not_applied',
        notAppliedReason: family,
      });
      expect(JSON.stringify(record)).not.toContain(reason);
    }
  });

  it('an upgrade records the day it took effect, not the start of the cycle it landed in', async () => {
    const b = await seedBusiness();
    const cycleStart = new Date('2026-11-01T00:00:00Z');
    const renewsAt = new Date('2026-12-01T00:00:00Z');
    await withBusiness(appDb, b, (tx) =>
      applyFixtureCycle(tx, b, {
        plan: 'chat',
        cycleStartedAt: cycleStart,
        renewsAt,
        anchorDay: 1,
      }),
    );
    await withBusiness(appDb, b, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId: b,
        kind: 'upgrade',
        plan: 'integrate',
        amountK: 100_000,
        reference: 'RKD-SUB-20261128-QQQQQQ',
        periodStart: cycleStart,
        periodEnd: renewsAt,
      }),
    );
    const paidOn = new Date('2026-11-28T09:00:00Z');
    await withBusiness(settlementDb(), b, (tx) =>
      applySettledCharge(tx, {
        businessId: b,
        reference: 'RKD-SUB-20261128-QQQQQQ',
        providerReference: 'ps_QQQQQQ',
        when: paidOn,
        config,
      }),
    );

    expect(await service().paymentRecord(b, 'RKD-SUB-20261128-QQQQQQ')).toMatchObject({
      state: 'paid_applied',
      periodStart: paidOn.toISOString(),
      periodEnd: renewsAt.toISOString(),
    });
  });

  it('a pack names what was bought', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-PACK-20261101-GGGGGG', { pack: true });

    expect(await service().paymentRecord(b, 'RKD-PACK-20261101-GGGGGG')).toMatchObject({
      kind: 'add_on',
      packId: 'messages_100',
      plan: null,
    });
  });

  it("another business's reference, and one that does not exist, both read as nothing", async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    await open(theirs, 'RKD-SUB-20261101-HHHHHH');

    expect(await service().paymentRecord(mine, 'RKD-SUB-20261101-HHHHHH')).toBeNull();
    expect(await service().paymentRecord(mine, 'RKD-SUB-20261101-ZZZZZZ')).toBeNull();
    expect(await service().paymentRecord(theirs, 'RKD-SUB-20261101-HHHHHH')).not.toBeNull();
  });

  it('answers the contract and exposes no checkout link, provider reference or internal reason', async () => {
    const b = await seedBusiness();
    await open(b, 'RKD-SUB-20261101-IIIIII');
    await set(
      'RKD-SUB-20261101-IIIIII',
      sql`checkout_url = 'https://checkout.example/secret', provider_reference = 'ps_internal', failure_reason = 'card_declined_internal', unapplied_reason = 'internal'`,
    );

    const record = await service().paymentRecord(b, 'RKD-SUB-20261101-IIIIII');

    expect(billingPaymentRecord.parse(record)).toEqual(record);
    const text = JSON.stringify(record);
    expect(text).not.toContain('checkout.example');
    expect(text).not.toContain('ps_internal');
    expect(text).not.toContain('card_declined_internal');
    expect(text).not.toContain('"internal"');
  });
});
