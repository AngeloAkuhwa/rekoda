/**
 * The settlement sweep (docs/payments-v1.md §26–28), against real PostgreSQL
 * with both production credentials — because the sweep's whole claim is a
 * two-role dance: resolve references cross-tenant as the worker, stamp rows
 * under each tenant's pin as the app. A test on one connection would prove
 * neither.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentReference } from '@rekoda/core';
import {
  createDb,
  identity,
  issueRepo,
  paymentsHub,
  settleRepo,
  settlementsRepo,
  sql,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { StubPaymentProvider } from './provider.stub.js';
import { sweepSettlements } from './settlement-sweep.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
const provider = new StubPaymentProvider();

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  provider.reset();
});

const deps = () => ({ workerDb, appDb, provider });

/** A business with one booked, VERIFIED payment awaiting settlement. */
async function seedVerifiedPayment(phone: string) {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const businessId = business.id;
  const reference = paymentReference(new Date(), (n) => randomBytes(n));

  await withBusiness(appDb, businessId, async (tx) => {
    /* The provider connection the payout lands against (§20 ingestion
     * names it). Real merchants have one before they have payments. */
    await paymentsHub.upsertConnection(tx, { businessId, providerType: 'paystack' });
    const sale = await issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: 'CUSTOMER_7K2',
      items: [{ name: 'wig', quantity: 1, unitPriceK: 15_000_000 }],
      subtotalK: 15_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 15_000_000,
      paidK: 0,
      balanceDueK: 15_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: 'draft-1',
      actor: 'system',
    });
    const intent = await paymentsHub.createIntent(tx, {
      businessId,
      reference,
      expectedAmountK: 15_000_000,
      providerType: 'paystack',
      invoiceId: sale.invoiceId,
    });
    await settleRepo.bookVerifiedPayment(tx, {
      businessId,
      intent: {
        id: intent.id,
        reference: intent.reference,
        invoiceId: intent.invoiceId,
        customerId: intent.customerId,
      },
      confirmedAmountK: 15_000_000,
      currency: 'NGN',
      providerType: 'paystack',
      providerRef: `pst-${randomBytes(4).toString('hex')}`,
      providerStatus: 'success',
      providerFeeK: 0,
      feePolicy: 'merchant_bearing',
      method: 'transfer',
      actor: 'test',
      eventId: `event-${randomBytes(4).toString('hex')}`,
    });
  });
  return { businessId, reference };
}

async function settlementState(businessId: string) {
  const { rows } = await withBusiness(appDb, businessId, (tx) => settleRepo.paymentsFor(tx));
  return rows[0];
}

describe('the settlement sweep (§26–28)', () => {
  it('stamps a settled batch onto the right payment, with the settlement date', async () => {
    const { businessId, reference } = await seedVerifiedPayment('+2348160000001');
    provider.willSettle({
      references: [reference, 'FOREIGN-REF-1', 'RKD-PAY-20260819-ZZZZZZ'],
      settledAtIso: '2026-08-19T04:00:00.000Z',
    });

    const stamped = await sweepSettlements(deps());
    // One OURS: the foreign reference and the Rekoda-shaped orphan touch nothing.
    expect(stamped).toBe(1);

    const row = await settlementState(businessId);
    expect(row?.settlementStatus).toBe('settled');
    expect(row?.settledAt?.toISOString()).toBe('2026-08-19T04:00:00.000Z');
  });

  it('walks a payment pending → processing → settled as the provider does', async () => {
    const { businessId, reference } = await seedVerifiedPayment('+2348160000002');

    provider.willSettle({ status: 'processing', settledAtIso: null, references: [reference] });
    expect(await sweepSettlements(deps())).toBe(1);
    expect((await settlementState(businessId))?.settlementStatus).toBe('processing');
    expect((await settlementState(businessId))?.settledAt).toBeNull();

    provider.reset();
    provider.willSettle({ settledAtIso: '2026-08-20T04:00:00.000Z', references: [reference] });
    expect(await sweepSettlements(deps())).toBe(1);
    const row = await settlementState(businessId);
    expect(row?.settlementStatus).toBe('settled');
    expect(row?.settledAt).not.toBeNull();
  });

  it('re-polling an applied batch is a no-op — the sweep can run forever', async () => {
    const { reference } = await seedVerifiedPayment('+2348160000003');
    provider.willSettle({ references: [reference] });

    expect(await sweepSettlements(deps())).toBe(1);
    expect(await sweepSettlements(deps())).toBe(0);
  });

  it('stamps each business its own payments when one batch spans two tenants', async () => {
    const a = await seedVerifiedPayment('+2348160000004');
    const b = await seedVerifiedPayment('+2348160000005');
    provider.willSettle({ references: [a.reference, b.reference] });

    expect(await sweepSettlements(deps())).toBe(2);
    expect((await settlementState(a.businessId))?.settlementStatus).toBe('settled');
    expect((await settlementState(b.businessId))?.settlementStatus).toBe('settled');
  });

  it('lets a provider outage surface as an error — never an invented empty day', async () => {
    provider.failNextSettlementsWith(new Error('ECONNRESET'));
    await expect(sweepSettlements(deps())).rejects.toThrow('ECONNRESET');
  });
});

describe('§20 ingestion: the payout itself, behind the stamps (PR-064)', () => {
  async function settlementRows(businessId: string) {
    return withBusiness(appDb, businessId, (tx) => settlementsRepo.settlementsFor(tx, businessId));
  }

  async function exceptionCount(businessId: string): Promise<number> {
    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM reconciliations
        WHERE business_id = ${businessId}::uuid AND status = 'EXCEPTION'
          AND expectation_kind = 'settlement'
      `),
    );
    return [...rows][0]!.n;
  }

  it('records the payout with its covered payment and the component its totals prove', async () => {
    const { businessId, reference } = await seedVerifiedPayment('+2348160000010');
    provider.willSettle({
      references: [reference],
      grossK: 15_000_000,
      netK: 14_776_250,
    });

    await sweepSettlements(deps());

    const rows = await settlementRows(businessId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'SETTLED', grossK: 15_000_000, netK: 14_776_250 });
    const detail = await withBusiness(appDb, businessId, (tx) =>
      settlementsRepo.settlementById(tx, businessId, rows[0]!.id),
    );
    expect(detail!.items).toHaveLength(1);
    expect(detail!.items[0]!.amountK).toBe(15_000_000);
    /* The provider stated totals, not an itemisation: the gap is the one
     * component the totals PROVE, and the note says so. */
    expect(detail!.components).toEqual([
      {
        kind: 'PROCESSING_FEE',
        direction: 'DEDUCTION',
        amountK: 223_750,
        note: 'gross − net as reported by the provider',
      },
    ]);

    /* Re-polling is a refresh, not a second payout or doubled detail. */
    await sweepSettlements(deps());
    expect(await settlementRows(businessId)).toHaveLength(1);
    const again = await withBusiness(appDb, businessId, (tx) =>
      settlementsRepo.settlementById(tx, businessId, rows[0]!.id),
    );
    expect(again!.items).toHaveLength(1);
    expect(again!.components).toHaveLength(1);
  });

  it('a re-report with DIFFERENT numbers becomes ONE exception, not an overwrite or a flood', async () => {
    const { businessId, reference } = await seedVerifiedPayment('+2348160000011');
    provider.willSettle({
      settlementId: 'stl-conflict',
      references: [reference],
      grossK: 15_000_000,
      netK: 15_000_000,
    });
    await sweepSettlements(deps());

    provider.reset();
    provider.willSettle({
      settlementId: 'stl-conflict',
      references: [reference],
      grossK: 14_000_000,
      netK: 14_000_000,
    });
    await sweepSettlements(deps());
    await sweepSettlements(deps());

    const rows = await settlementRows(businessId);
    expect(rows[0]).toMatchObject({ grossK: 15_000_000 });
    expect(await exceptionCount(businessId)).toBe(1);
  });

  it('a provider that states no totals gets stamps and no invented settlement', async () => {
    const { businessId, reference } = await seedVerifiedPayment('+2348160000012');
    provider.willSettle({ references: [reference] });

    await sweepSettlements(deps());

    expect((await settlementState(businessId))?.settlementStatus).toBe('settled');
    expect(await settlementRows(businessId)).toHaveLength(0);
  });

  it('a batch that spans tenants, or carries foreign traffic, stamps but records no payout', async () => {
    const a = await seedVerifiedPayment('+2348160000013');
    const b = await seedVerifiedPayment('+2348160000014');
    provider.willSettle({
      references: [a.reference, b.reference],
      grossK: 30_000_000,
      netK: 30_000_000,
    });
    const c = await seedVerifiedPayment('+2348160000015');
    provider.willSettle({
      settlementId: 'stl-foreign',
      references: [c.reference, 'FOREIGN-REF-9'],
      grossK: 20_000_000,
      netK: 20_000_000,
    });

    await sweepSettlements(deps());

    /* The batch gross belongs to nobody in particular; decomposing it
     * would be estimation, which §20 forbids for authoritative data. */
    expect(await settlementRows(a.businessId)).toHaveLength(0);
    expect(await settlementRows(b.businessId)).toHaveLength(0);
    expect(await settlementRows(c.businessId)).toHaveLength(0);
    expect((await settlementState(a.businessId))?.settlementStatus).toBe('settled');
    expect((await settlementState(c.businessId))?.settlementStatus).toBe('settled');
  });
});
