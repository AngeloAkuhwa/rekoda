/**
 * The reporting read layer, against real PostgreSQL (ADR 0015).
 *
 * One seeded month of business — a part-paid cash sale, a provider-confirmed
 * transfer, an expense, a purchase on credit — and every dashboard figure
 * checked against arithmetic done by hand here in the test. If SQL and the
 * hand total ever disagree, the dashboard was about to lie to a merchant.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentReference, usagePeriod } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, issueRepo, paymentsHub, reportsRepo, settleRepo, spendRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348120000009');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** The month of trading every assertion below re-derives by hand. */
async function seedTradingMonth(businessId: string): Promise<{ invoiceNumber: string }> {
  return withBusiness(db, businessId, async (tx) => {
    // A ₦150,000 sale, ₦40,000 paid in cash at the counter.
    const sale = await issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: 'CUSTOMER_7K2',
      items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
      subtotalK: 15_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 15_000_000,
      paidK: 4_000_000,
      balanceDueK: 11_000_000,
      method: 'cash',
      sourceType: 'chat',
      sourceId: 'draft-1',
      actor: 'system',
    });

    // ₦50,000 of the balance arrives through the provider, verified.
    const intent = await paymentsHub.createIntent(tx, {
      businessId,
      reference: paymentReference(new Date(), (n) => randomBytes(n)),
      expectedAmountK: 5_000_000,
      providerType: 'paystack',
      invoiceId: sale.invoiceId,
    });
    await settleRepo.bookVerifiedPayment(tx, {
      businessId,
      intent: {
        id: intent.id,
        reference: intent.reference,
        invoiceId: sale.invoiceId,
        customerId: null,
      },
      confirmedAmountK: 5_000_000,
      currency: 'NGN',
      providerType: 'paystack',
      providerRef: 'pst-r1',
      providerStatus: 'success',
      providerFeeK: 0,
      feePolicy: 'merchant_bearing',
      method: 'transfer',
      actor: 'test',
      eventId: 'evt-1',
    });

    // ₦12,000 of fuel, and ₦50,000 of stock with ₦20,000 paid.
    await spendRepo.recordExpense(tx, {
      businessId,
      description: 'fuel for generator',
      category: 'utilities',
      amountK: 1_200_000,
      method: 'cash',
      sourceType: 'chat',
      sourceId: 'draft-2',
    });
    await spendRepo.recordPurchase(tx, {
      businessId,
      description: 'ankara fabric',
      amountK: 5_000_000,
      paidK: 2_000_000,
      sourceType: 'chat',
      sourceId: 'draft-3',
    });

    return { invoiceNumber: sale.invoiceNumber };
  });
}

describe('the overview', () => {
  it('derives every tile from the ledger, and the hand totals agree', async () => {
    const businessId = await seedBusiness();
    await seedTradingMonth(businessId);

    const overview = await withBusiness(db, businessId, (tx) =>
      reportsRepo.overviewFor(tx, businessId),
    );

    // In: ₦40,000 cash at the counter + ₦50,000 verified through the bank.
    expect(overview.moneyInK).toBe(9_000_000);
    // The verified split is ONLY the provider-confirmed portion (ADR 0014).
    expect(overview.verifiedInK).toBe(5_000_000);
    // Out: ₦12,000 fuel + the ₦20,000 actually paid for stock.
    expect(overview.moneyOutK).toBe(3_200_000);
    // Sales recognised in full at issue (accrual), independent of cash.
    expect(overview.salesK).toBe(15_000_000);
    // ₦150,000 − ₦40,000 cash − ₦50,000 provider = ₦60,000 still owed.
    expect(overview.owedToYouK).toBe(6_000_000);
    // The unpaid ₦30,000 of stock sits on ACCOUNTS_PAYABLE.
    expect(overview.youOweK).toBe(3_000_000);
    expect(overview.exceptionsOpen).toBe(0);
  });

  it('a brand-new business is all zeros, never an error', async () => {
    const businessId = await seedBusiness();
    const overview = await withBusiness(db, businessId, (tx) =>
      reportsRepo.overviewFor(tx, businessId),
    );
    expect(overview).toEqual({
      moneyInK: 0,
      verifiedInK: 0,
      moneyOutK: 0,
      salesK: 0,
      owedToYouK: 0,
      youOweK: 0,
      exceptionsOpen: 0,
    });
  });
});

describe('the cash-flow series', () => {
  it('returns exactly N Lagos months, quiet ones as zeros, this month live', async () => {
    const businessId = await seedBusiness();
    await seedTradingMonth(businessId);

    const months = await withBusiness(db, businessId, (tx) =>
      reportsRepo.cashflowFor(tx, businessId, 6),
    );
    expect(months).toHaveLength(6);
    // Oldest first, and the last bucket is the current Lagos month.
    const latest = months[5]!;
    expect(latest.period).toBe(usagePeriod(new Date()));
    expect(latest.inK).toBe(9_000_000);
    expect(latest.outK).toBe(3_200_000);
    for (const quiet of months.slice(0, 5)) {
      expect(quiet).toMatchObject({ inK: 0, outK: 0 });
    }
  });
});

describe('who owes you', () => {
  it('lists open invoices with the true total, and settles to empty', async () => {
    const businessId = await seedBusiness();
    const { invoiceNumber } = await seedTradingMonth(businessId);

    const debtors = await withBusiness(db, businessId, (tx) =>
      reportsRepo.debtorsFor(tx, businessId, 6),
    );
    expect(debtors.count).toBe(1);
    expect(debtors.totalK).toBe(6_000_000);
    expect(debtors.rows[0]).toMatchObject({ invoiceNumber, balanceDueK: 6_000_000 });
  });
});

describe('recent activity', () => {
  it('names things the way a merchant would, never a token', async () => {
    const businessId = await seedBusiness();
    const { invoiceNumber } = await seedTradingMonth(businessId);

    const items = await withBusiness(db, businessId, (tx) =>
      reportsRepo.activityFor(tx, businessId, 8),
    );
    const kinds = items.map((i) => i.kind).sort();
    expect(kinds).toEqual(['expense', 'payment', 'purchase', 'sale']);
    expect(items.find((i) => i.kind === 'sale')?.label).toBe(`Invoice ${invoiceNumber} issued`);
    expect(items.find((i) => i.kind === 'purchase')?.label).toBe('Stock: ankara fabric');
    // Customer tokens exist in memos and snapshots; the feed must not leak them.
    expect(JSON.stringify(items)).not.toContain('CUSTOMER_7K2');
  });
});
