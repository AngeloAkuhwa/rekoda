/**
 * OD-51.7 (migration 0214): one intended pack purchase is credited once, however many payment
 * links it ended up with.
 *
 * A pending pack charge that is no longer at today's price is retired and a new charge opened in
 * its place, but the old Paystack link can still be paid. Both charges are honest at the instant
 * each was priced, so both used to pass the price check and both credited the pack. They are now
 * the SAME logical purchase (`purchase_id`, carried from the retired charge to its replacement),
 * and only the first verified settlement of a purchase grants its units. A second verified payment
 * is recorded as paid and set aside for an operator (`duplicate_purchase`); it is never dropped
 * and never grants. A new, intended purchase of the same pack is a new identity and credits.
 *
 * Read off the meter (`usage_counters.bonus`), through the real job path: stored event, pump,
 * `billing.process`, the provider's verify.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { usagePeriod } from '@rekoda/core';
import {
  createDb,
  issueRepo,
  planCatalogueRepo,
  settleRepo,
  sql,
  subscriptionsRepo,
  usageRepo,
  withBusiness,
} from '@rekoda/db';
import { applyFixtureCycle, resetPlanCatalogue, settlementDb } from '@rekoda/db/testing';
import { applySettledCharge } from './billing.service.js';
import {
  appDb,
  chargeOf,
  config,
  drainJobs,
  eventError,
  plans,
  provider,
  pump,
  seedBusiness,
  storeEvent,
  urls,
  useCheckoutRecoveryHarness,
  workerDb,
} from './checkout-recovery.fixtures.js';

useCheckoutRecoveryHarness();

/* Each test reprices the pack; the catalogue is reference data no other suite expects to move. */
afterEach(async () => {
  await resetPlanCatalogue(urls);
});

const PACK = 'documents_50';
const UNIT = 'DOCUMENT_GENERATION';
const UNITS = 50;
const DAY = 86_400_000;

/** A provider-bought Chat month: packs are offered on a paid plan only. */
async function onChat(): Promise<string> {
  const businessId = await seedBusiness();
  const renewsAt = new Date(Date.now() + 20 * DAY);
  await withBusiness(appDb, businessId, (tx) =>
    applyFixtureCycle(tx, businessId, {
      plan: 'chat',
      cycleStartedAt: new Date(renewsAt.getTime() - 30 * DAY),
      renewsAt,
      anchorDay: new Date(renewsAt.getTime() + 3_600_000).getUTCDate(),
    }),
  );
  return businessId;
}

const bonusOf = async (businessId: string): Promise<number> => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return rows.find((row) => row.unit === UNIT)?.bonus ?? 0;
};

async function buy(businessId: string): Promise<{ reference: string; amountK: number }> {
  const answer = await plans().buyPack(businessId, PACK);
  if (answer.state !== 'payment_required') throw new Error(`payable, got ${answer.state}`);
  return { reference: answer.reference, amountK: answer.amountK };
}

/** The catalogue reprices the pack from now on; charges already opened keep the price they had. */
async function reprice(priceMinor: number): Promise<void> {
  const owner = createDb(urls.owner, { max: 1 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 15));
    await planCatalogueRepo.publishUsagePack(owner.db, {
      packId: PACK,
      label: '50 extra document generations',
      unit: UNIT,
      quantity: UNITS,
      priceMinor,
      currency: 'NGN',
      effectiveFrom: new Date(),
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
  } finally {
    await owner.close();
  }
}

/** One intended purchase with two payable links: the first retired by a reprice, then its replacement. */
async function twoLinksOnePurchase(businessId: string) {
  const first = await buy(businessId);
  await reprice(first.amountK + 10_000);
  const second = await buy(businessId);
  expect(second.reference).not.toBe(first.reference);
  expect(second.amountK).toBe(first.amountK + 10_000);
  return { first, second };
}

async function pay(charge: { reference: string; amountK: number }): Promise<string> {
  provider.willVerify(charge.reference, { amountK: charge.amountK });
  const eventId = await storeEvent(charge.reference, charge.amountK);
  expect(await pump()).toBe(1);
  await drainJobs();
  return eventId;
}

const recordOf = async (businessId: string, reference: string) => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{
      status: string;
      purchase_id: string;
      credited: boolean;
      unapplied_reason: string | null;
      superseded: boolean;
      paid_amount_k: string | null;
    }>(sql`
      SELECT status, purchase_id, units_credited_at IS NOT NULL AS credited, unapplied_reason,
             superseded_at IS NOT NULL AS superseded, paid_amount_k::text
      FROM subscription_charges WHERE reference = ${reference}`),
  );
  return [...rows][0]!;
};

const operatorQueue = async () =>
  (await subscriptionsRepo.unappliedCharges(workerDb)).map((row) => ({
    reference: row.reference,
    reason: row.reason,
  }));

describe('one intended pack purchase is credited once (OD-51.7)', () => {
  it('a replacement charge is the same purchase; a fresh purchase is a new one', async () => {
    const businessId = await onChat();
    const { first, second } = await twoLinksOnePurchase(businessId);
    const a = await recordOf(businessId, first.reference);
    const b = await recordOf(businessId, second.reference);
    expect(a.superseded).toBe(true);
    expect(b.superseded).toBe(false);
    expect(b.purchase_id).toBe(a.purchase_id);

    await pay(second);
    const third = await buy(businessId);
    expect((await recordOf(businessId, third.reference)).purchase_id).not.toBe(a.purchase_id);
  });

  it('both links paid, the old one first: one credit, the second payment recorded and set aside', async () => {
    const businessId = await onChat();
    const { first, second } = await twoLinksOnePurchase(businessId);

    await pay(first);
    expect(await bonusOf(businessId)).toBe(UNITS);
    const laterEvent = await pay(second);

    expect(await bonusOf(businessId)).toBe(UNITS);
    expect(await recordOf(businessId, first.reference)).toMatchObject({
      status: 'paid',
      credited: true,
      unapplied_reason: null,
    });
    /* The second payment happened and says so: paid, the amount Paystack verified, not credited,
     * and waiting in the operator queue to be reconciled or refunded. */
    expect(await recordOf(businessId, second.reference)).toMatchObject({
      status: 'paid',
      credited: false,
      unapplied_reason: 'duplicate_purchase',
      paid_amount_k: String(second.amountK),
    });
    expect(await operatorQueue()).toEqual([
      { reference: second.reference, reason: 'duplicate_purchase' },
    ]);
    expect(await eventError(businessId, laterEvent)).toBeNull();
  });

  it('both links paid, the new one first: one credit, the old link set aside', async () => {
    const businessId = await onChat();
    const { first, second } = await twoLinksOnePurchase(businessId);

    await pay(second);
    await pay(first);

    expect(await bonusOf(businessId)).toBe(UNITS);
    expect((await recordOf(businessId, second.reference)).credited).toBe(true);
    expect(await recordOf(businessId, first.reference)).toMatchObject({
      status: 'paid',
      credited: false,
      unapplied_reason: 'duplicate_purchase',
    });
    expect(await operatorQueue()).toEqual([
      { reference: first.reference, reason: 'duplicate_purchase' },
    ]);
  });

  it('two settlements of the two links racing grant once', async () => {
    const businessId = await onChat();
    const { first, second } = await twoLinksOnePurchase(businessId);
    const settle = (charge: { reference: string; amountK: number }, providerReference: string) =>
      withBusiness(settlementDb(), businessId, (tx) =>
        applySettledCharge(tx, {
          businessId,
          reference: charge.reference,
          providerReference,
          paidAmountK: charge.amountK,
          when: new Date(),
          config,
        }),
      );

    const answers = await Promise.all([settle(first, 'ps_race_a'), settle(second, 'ps_race_b')]);

    expect([...answers].sort()).toEqual(['applied', 'superseded']);
    expect(await bonusOf(businessId)).toBe(UNITS);
    const records = [
      await recordOf(businessId, first.reference),
      await recordOf(businessId, second.reference),
    ];
    expect(records.filter((r) => r.credited)).toHaveLength(1);
    expect(records.filter((r) => r.unapplied_reason === 'duplicate_purchase')).toHaveLength(1);
    expect(records.every((r) => r.status === 'paid')).toBe(true);
  });

  it('replayed webhooks for either link never grant again', async () => {
    const businessId = await onChat();
    const { first, second } = await twoLinksOnePurchase(businessId);
    await pay(first);
    await pay(second);

    for (const charge of [first, second, first, second]) await pay(charge);

    expect(await bonusOf(businessId)).toBe(UNITS);
    expect(await operatorQueue()).toHaveLength(1);
  });

  it('a new, intended purchase of the same pack is credited normally, before and after a duplicate', async () => {
    const businessId = await onChat();
    await pay(await buy(businessId));
    expect(await bonusOf(businessId)).toBe(UNITS);

    /* A second purchase, deliberately: its own identity, its own credit. */
    const { first, second } = await twoLinksOnePurchase(businessId);
    await pay(first);
    expect(await bonusOf(businessId)).toBe(2 * UNITS);
    /* The replacement link of that completed purchase is no longer offered as payable... */
    expect((await recordOf(businessId, second.reference)).superseded).toBe(true);
    /* ...so buying again opens a third purchase rather than handing back a link that would be
     * set aside as a duplicate. */
    const third = await buy(businessId);
    expect(third.reference).not.toBe(second.reference);
    await pay(third);
    expect(await bonusOf(businessId)).toBe(3 * UNITS);
    expect(await operatorQueue()).toEqual([]);
  });

  it('a short or failed payment grants nothing and does not use up the purchase', async () => {
    const businessId = await onChat();
    const { first, second } = await twoLinksOnePurchase(businessId);

    /* A kobo short on the old link. */
    provider.willVerify(first.reference, { amountK: first.amountK - 1 });
    const short = await storeEvent(first.reference, first.amountK - 1);
    await pump();
    await drainJobs();
    expect(await eventError(businessId, short)).toBe('underpaid');
    expect(await bonusOf(businessId)).toBe(0);

    /* The provider says the replacement attempt failed. */
    provider.willVerify(second.reference, {
      succeeded: false,
      providerStatus: 'failed',
      amountK: second.amountK,
    });
    await storeEvent(second.reference, second.amountK);
    await pump();
    await drainJobs();
    expect(await bonusOf(businessId)).toBe(0);
    expect((await chargeOf(businessId, second.reference))?.status).toBe('failed');

    /* The old link, paid in full now, is still the first valid settlement of the purchase. */
    await pay(first);
    expect(await bonusOf(businessId)).toBe(UNITS);
    expect((await recordOf(businessId, first.reference)).credited).toBe(true);
  });

  it('a charge at a price Rekoda never offered is still set aside by the price check, duplicate or not', async () => {
    const businessId = await onChat();
    const { first, second } = await twoLinksOnePurchase(businessId);
    const owner = createDb(urls.owner, { max: 1 });
    try {
      await owner.db.execute(
        sql`UPDATE subscription_charges SET amount_k = 100 WHERE reference = ${second.reference}`,
      );
    } finally {
      await owner.close();
    }
    await pay({ reference: second.reference, amountK: 100 });
    expect(await bonusOf(businessId)).toBe(0);
    expect((await recordOf(businessId, second.reference)).unapplied_reason).toBe(
      'price_not_verified',
    );
    /* It never became the purchase's settlement, so the honest link still credits. */
    await pay(first);
    expect(await bonusOf(businessId)).toBe(UNITS);
  });

  it("neither payment touches the merchant's books", async () => {
    const businessId = await onChat();
    const { first, second } = await twoLinksOnePurchase(businessId);
    await pay(first);
    await pay(second);

    expect(await withBusiness(appDb, businessId, (tx) => settleRepo.paymentCount(tx))).toBe(0);
    expect(await withBusiness(appDb, businessId, (tx) => settleRepo.receiptCount(tx))).toBe(0);
    expect(
      await withBusiness(appDb, businessId, (tx) => issueRepo.ledgerEntriesFor(tx, businessId)),
    ).toHaveLength(0);
  });
});
