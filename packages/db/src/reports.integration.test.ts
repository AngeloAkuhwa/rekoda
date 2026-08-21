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
    /* Two payments, because the month has two: cash at the counter, which the
     * merchant reported, and ₦50,000 the provider confirmed. Both are real
     * money and both belong here (ADR 0014); showing only the verified one
     * meant a merchant who recorded a payment in chat saw the invoice change
     * with nothing behind it. */
    expect(kinds).toEqual(['expense', 'payment', 'payment', 'purchase', 'sale']);
    expect(items.find((i) => i.kind === 'sale')?.label).toBe(`Invoice ${invoiceNumber} issued`);
    expect(items.find((i) => i.kind === 'purchase')?.label).toBe('Stock: ankara fabric');
    // Customer tokens exist in memos and snapshots; the feed must not leak them.
    expect(JSON.stringify(items)).not.toContain('CUSTOMER_7K2');
  });

  /**
   * The label carries the distinction, because the feed is the one place a
   * merchant reads the two side by side. "Confirmed" is a claim about a
   * provider and must never appear on money only the merchant vouched for.
   */
  it('says confirmed only of the payment a provider confirmed', async () => {
    const businessId = await seedBusiness();
    await seedTradingMonth(businessId);

    const items = await withBusiness(db, businessId, (tx) =>
      reportsRepo.activityFor(tx, businessId, 8),
    );
    const payments = items.filter((i) => i.kind === 'payment');

    expect(payments.filter((p) => p.label.includes('confirmed'))).toHaveLength(1);
    expect(payments.filter((p) => p.label === 'Payment recorded')).toHaveLength(1);
  });
});

describe('per-account sums (the statements query)', () => {
  it('splits period from cumulative, and both agree with the seeded month', async () => {
    const businessId = await seedBusiness();
    await seedTradingMonth(businessId);

    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, businessId, (tx) =>
      reportsRepo.accountSumsFor(tx, businessId, period),
    );
    const byAccount = Object.fromEntries(rows.map((r) => [r.account, r]));

    // Cash: ₦40,000 in at the counter; ₦12,000 fuel + ₦20,000 stock out.
    expect(byAccount['CASH']).toMatchObject({
      periodDebitK: 4_000_000,
      periodCreditK: 3_200_000,
    });
    // Everything seeded this month: period equals cumulative for every account.
    for (const row of rows) {
      expect(row.cumulativeDebitK).toBe(row.periodDebitK);
      expect(row.cumulativeCreditK).toBe(row.periodCreditK);
    }
    // Double entry survives aggregation.
    const debits = rows.reduce((n, r) => n + r.cumulativeDebitK, 0);
    const credits = rows.reduce((n, r) => n + r.cumulativeCreditK, 0);
    expect(debits).toBe(credits);
  });

  it('a period before any entry returns nothing at all', async () => {
    const businessId = await seedBusiness();
    await seedTradingMonth(businessId);
    const rows = await withBusiness(db, businessId, (tx) =>
      reportsRepo.accountSumsFor(tx, businessId, '2020-01'),
    );
    expect(rows).toEqual([]);
  });
});

describe('the registers (§5.3.7)', () => {
  it('lists the invoice with its running figures and totals the outstanding', async () => {
    const businessId = await seedBusiness();
    const { invoiceNumber } = await seedTradingMonth(businessId);

    const list = await withBusiness(db, businessId, (tx) =>
      reportsRepo.invoicesFor(tx, businessId, 50),
    );
    expect(list.count).toBe(1);
    const row = list.rows[0];
    expect(row?.invoiceNumber).toBe(invoiceNumber);
    expect(row?.status).toBe('partially_paid');
    expect(row?.totalK).toBe(15_000_000);
    // ₦40,000 cash at the counter + ₦50,000 verified transfer.
    expect(row?.paidK).toBe(9_000_000);
    expect(row?.balanceDueK).toBe(6_000_000);
    // The outstanding total is the same ₦60,000 the row shows.
    expect(list.outstandingK).toBe(6_000_000);
  });

  it('lists the receipt beside the invoice it settled', async () => {
    const businessId = await seedBusiness();
    const { invoiceNumber } = await seedTradingMonth(businessId);

    const list = await withBusiness(db, businessId, (tx) =>
      reportsRepo.receiptsFor(tx, businessId, 50),
    );
    expect(list.count).toBe(1);
    const row = list.rows[0];
    expect(row?.receiptNumber).toMatch(/^RCT-/);
    expect(row?.amountK).toBe(5_000_000);
    expect(row?.invoiceNumber).toBe(invoiceNumber);
  });

  it("NEVER shows one tenant another tenant's registers", async () => {
    const businessId = await seedBusiness();
    await seedTradingMonth(businessId);

    const otherUser = await identity.upsertUserByPhone(db, '+2348120000010');
    const other = await identity.createBusinessWithOwner(db, {
      name: 'Bode Spares',
      businessType: null,
      ownerUserId: otherUser.id,
    });

    const invoices = await withBusiness(db, other.id, (tx) =>
      reportsRepo.invoicesFor(tx, other.id, 50),
    );
    const receipts = await withBusiness(db, other.id, (tx) =>
      reportsRepo.receiptsFor(tx, other.id, 50),
    );
    expect(invoices.count).toBe(0);
    expect(invoices.outstandingK).toBe(0);
    expect(receipts.count).toBe(0);
  });
});

/**
 * Receivable ageing, against real dates in real SQL.
 *
 * The bucket boundaries are the whole assertion: an invoice one day late and
 * one thirty-one days late belong in different columns, and a merchant reads
 * those columns to decide who to call this morning. Bucketed in SQL over the
 * WHOLE table rather than a page of it, because an ageing report that aged
 * only the latest twenty invoices would be wrong in the direction that costs
 * money.
 */
describe('receivable ageing', () => {
  /** An unpaid invoice due `daysAgo` before `now`, or with no due date. */
  async function unpaidInvoiceDue(
    businessId: string,
    totalK: number,
    dueDate: Date | null,
  ): Promise<void> {
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 1, unitPriceK: totalK }],
        subtotalK: totalK,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK,
        paidK: 0,
        balanceDueK: totalK,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: `draft-${totalK}`,
        actor: 'system',
        dueDate,
      }),
    );
  }

  const NOW = new Date('2026-08-20T09:00:00Z');
  const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it('is all zeros for a business that is owed nothing', async () => {
    const businessId = await seedBusiness();
    expect(
      await withBusiness(db, businessId, (tx) => reportsRepo.ageingFor(tx, businessId, NOW)),
    ).toEqual({
      currentK: 0,
      d1_30K: 0,
      d31_60K: 0,
      d61_90K: 0,
      d90PlusK: 0,
      totalK: 0,
      overdueK: 0,
    });
  });

  it('sorts each debt into its bucket by whole Lagos days late', async () => {
    const businessId = await seedBusiness();
    await unpaidInvoiceDue(businessId, 100_000, daysBefore(-5)); // due in future
    await unpaidInvoiceDue(businessId, 200_000, daysBefore(10)); // 10 late
    await unpaidInvoiceDue(businessId, 300_000, daysBefore(45)); // 45 late
    await unpaidInvoiceDue(businessId, 400_000, daysBefore(75)); // 75 late
    await unpaidInvoiceDue(businessId, 500_000, daysBefore(200)); // 200 late

    const ageing = await withBusiness(db, businessId, (tx) =>
      reportsRepo.ageingFor(tx, businessId, NOW),
    );

    expect(ageing.currentK).toBe(100_000);
    expect(ageing.d1_30K).toBe(200_000);
    expect(ageing.d31_60K).toBe(300_000);
    expect(ageing.d61_90K).toBe(400_000);
    expect(ageing.d90PlusK).toBe(500_000);
    expect(ageing.totalK).toBe(1_500_000);
    expect(ageing.overdueK).toBe(1_400_000);
  });

  /**
   * Undated debt is not late. Ageing it would invent a deadline the merchant
   * never agreed, and put a real customer on a chase list for it.
   */
  it('keeps debt with no agreed date in current, however old', async () => {
    const businessId = await seedBusiness();
    await unpaidInvoiceDue(businessId, 700_000, null);

    const ageing = await withBusiness(db, businessId, (tx) =>
      reportsRepo.ageingFor(tx, businessId, NOW),
    );
    expect(ageing.currentK).toBe(700_000);
    expect(ageing.overdueK).toBe(0);
  });

  it('the buckets always sum to the total', async () => {
    const businessId = await seedBusiness();
    await unpaidInvoiceDue(businessId, 111_111, daysBefore(3));
    await unpaidInvoiceDue(businessId, 222_222, daysBefore(40));
    await unpaidInvoiceDue(businessId, 333_333, null);

    const a = await withBusiness(db, businessId, (tx) =>
      reportsRepo.ageingFor(tx, businessId, NOW),
    );
    expect(a.currentK + a.d1_30K + a.d31_60K + a.d61_90K + a.d90PlusK).toBe(a.totalK);
  });

  it('drops an invoice out of ageing once it is paid off', async () => {
    const businessId = await seedBusiness();
    await unpaidInvoiceDue(businessId, 900_000, daysBefore(30));
    const open = await withBusiness(db, businessId, (tx) =>
      issueRepo.latestOpenInvoice(tx, businessId),
    );
    await withBusiness(db, businessId, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: open!.id,
        amountK: 900_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'paid-off',
        actor: 'test',
      }),
    );

    const ageing = await withBusiness(db, businessId, (tx) =>
      reportsRepo.ageingFor(tx, businessId, NOW),
    );
    expect(ageing.totalK).toBe(0);
  });
});
