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
  const rows = await withBusiness(appDb, businessId, (tx) => settleRepo.paymentsFor(tx));
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
