/**
 * OD-51.6 (migration 0215): the API and settlement price a charge from one authoritative source.
 *
 * Where prices come from used to be each process's own environment flag. A settlement process on
 * a different setting re-priced an honest charge with the other table and set the payment aside
 * (`price_not_verified`); the same happened to every payment pending when the flag was changed.
 * A charge now records the source it was priced from, settlement re-prices it from that source,
 * the database refuses a charge priced from a source that is not in force, and a process whose
 * setting differs refuses to start.
 *
 * The catalogue is repriced in each test, so the two sources genuinely disagree about the price.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { usagePeriod } from '@rekoda/core';
import { createDb, planCatalogueRepo, sql, usageRepo, withBusiness } from '@rekoda/db';
import {
  applyFixtureCycle,
  resetPlanCatalogue,
  setPricingSource,
  settlementDb,
} from '@rekoda/db/testing';
import { applySettledCharge, BillingService } from './billing.service.js';
import {
  appDb,
  config,
  plans,
  seedBusiness,
  urls,
  useCheckoutRecoveryHarness,
} from './checkout-recovery.fixtures.js';

useCheckoutRecoveryHarness();

afterEach(async () => {
  await resetPlanCatalogue(urls);
});

const PACK = 'documents_50';
const UNIT = 'DOCUMENT_GENERATION';
const UNITS = 50;
const CONSTANT_PRICE_K = 200_000;
const CATALOGUE_PRICE_K = 260_000;
const DAY = 86_400_000;

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

/** The catalogue sells the pack dearer than the compiled constant from now on. */
async function catalogueDisagreesWithConstants(): Promise<void> {
  const owner = createDb(urls.owner, { max: 1 });
  try {
    await planCatalogueRepo.publishUsagePack(owner.db, {
      packId: PACK,
      label: '50 extra document generations',
      unit: UNIT,
      quantity: UNITS,
      priceMinor: CATALOGUE_PRICE_K,
      currency: 'NGN',
      effectiveFrom: new Date(Date.now() - 1_000),
    });
  } finally {
    await owner.close();
  }
}

const bonusOf = async (businessId: string): Promise<number> => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return rows.find((row) => row.unit === UNIT)?.bonus ?? 0;
};

const recordOf = async (businessId: string, reference: string) => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{
      status: string;
      amount_k: string;
      pricing_source: string | null;
      unapplied_reason: string | null;
      credited: boolean;
    }>(sql`
      SELECT status, amount_k::text, pricing_source, unapplied_reason,
             units_credited_at IS NOT NULL AS credited
      FROM subscription_charges WHERE reference = ${reference}`),
  );
  return [...rows][0]!;
};

/** Settle as a settlement process whose own setting is `catalogueReads`. */
const settleAs = (
  catalogueReads: boolean,
  businessId: string,
  charge: { reference: string; amountK: number },
) =>
  withBusiness(settlementDb(), businessId, (tx) =>
    applySettledCharge(tx, {
      businessId,
      reference: charge.reference,
      providerReference: `ps_${randomBytes(6).toString('hex')}`,
      paidAmountK: charge.amountK,
      when: new Date(),
      config: { ...config, planCatalogueReads: catalogueReads },
    }),
  );

async function buy(businessId: string, service = plans()) {
  const answer = await service.buyPack(businessId, PACK);
  if (answer.state !== 'payment_required') throw new Error(`payable, got ${answer.state}`);
  return { reference: answer.reference, amountK: answer.amountK };
}

describe('one authoritative pricing source for the API and settlement (OD-51.6)', () => {
  it('a charge records the source it was priced from', async () => {
    await catalogueDisagreesWithConstants();
    const businessId = await onChat();
    const charge = await buy(businessId);
    expect(charge.amountK).toBe(CATALOGUE_PRICE_K);
    expect(await recordOf(businessId, charge.reference)).toMatchObject({
      pricing_source: 'catalogue',
      amount_k: String(CATALOGUE_PRICE_K),
    });
  });

  it('a settlement process on another setting still applies an honest payment at the price it was sold at', async () => {
    await catalogueDisagreesWithConstants();
    const businessId = await onChat();
    const charge = await buy(businessId);

    /* The settling process believes prices come from the compiled constants (200,000 kobo). The
     * charge was honestly sold from the catalogue at 260,000: it verifies against the catalogue. */
    expect(await settleAs(false, businessId, charge)).toBe('applied');

    expect(await bonusOf(businessId)).toBe(UNITS);
    expect(await recordOf(businessId, charge.reference)).toMatchObject({
      status: 'paid',
      credited: true,
      unapplied_reason: null,
    });
  });

  it('a payment pending when the source is switched is still verified against the source it was sold from', async () => {
    await catalogueDisagreesWithConstants();
    const businessId = await onChat();
    const charge = await buy(businessId);

    /* The owner switches the estate to the compiled constants while the payment is pending. */
    await setPricingSource(urls, 'constants');

    expect(await settleAs(false, businessId, charge)).toBe('applied');
    expect(await bonusOf(businessId)).toBe(UNITS);
    /* And a purchase made after the switch is sold, recorded and verified at the constant price. */
    const constants = new BillingService({ ...config, planCatalogueReads: false }, appDb);
    const second = await buy(businessId, constants);
    expect(second.amountK).toBe(CONSTANT_PRICE_K);
    expect((await recordOf(businessId, second.reference)).pricing_source).toBe('constants');
    expect(await settleAs(true, businessId, second)).toBe('applied');
    expect(await bonusOf(businessId)).toBe(2 * UNITS);
  });

  it('a charge opened before the source was recorded is priced from the source in force', async () => {
    await catalogueDisagreesWithConstants();
    const businessId = await onChat();
    const charge = await buy(businessId);
    const owner = createDb(urls.owner, { max: 1 });
    try {
      await owner.db.execute(
        sql`UPDATE subscription_charges SET pricing_source = NULL WHERE reference = ${charge.reference}`,
      );
    } finally {
      await owner.close();
    }
    /* Every process is held to the source in force at boot, so its own setting is that source. */
    expect(await settleAs(true, businessId, charge)).toBe('applied');
    expect(await bonusOf(businessId)).toBe(UNITS);
  });

  it('a process that drifted from the source in force cannot open a charge', async () => {
    await catalogueDisagreesWithConstants();
    const businessId = await onChat();
    const drifted = new BillingService({ ...config, planCatalogueReads: false }, appDb);

    await expect(drifted.buyPack(businessId, PACK)).rejects.toMatchObject({
      cause: {
        code: '42501',
        message: expect.stringMatching(/pricing source in force \(catalogue\)/),
      },
    });
    await expect(drifted.changePlan(businessId, 'complete')).rejects.toMatchObject({
      cause: { code: '42501' },
    });

    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM subscription_charges WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...rows][0]!.n).toBe(0);
  });

  it('a mismatch still fails closed: a charge not at the price of its own source is set aside, never credited', async () => {
    await catalogueDisagreesWithConstants();
    const businessId = await onChat();
    const charge = await buy(businessId);
    const owner = createDb(urls.owner, { max: 1 });
    try {
      /* Tampered to the cheaper table's price while still naming the catalogue. */
      await owner.db.execute(
        sql`UPDATE subscription_charges SET amount_k = ${CONSTANT_PRICE_K} WHERE reference = ${charge.reference}`,
      );
    } finally {
      await owner.close();
    }
    for (const reads of [true, false]) {
      expect(
        await settleAs(reads, businessId, {
          reference: charge.reference,
          amountK: CONSTANT_PRICE_K,
        }),
      ).toBe(reads ? 'superseded' : 'already_settled');
    }
    expect(await bonusOf(businessId)).toBe(0);
    expect(await recordOf(businessId, charge.reference)).toMatchObject({
      status: 'paid',
      credited: false,
      unapplied_reason: 'price_not_verified',
    });
  });
});
