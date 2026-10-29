/**
 * The reporting read layer, against real PostgreSQL (ADR 0015).
 *
 * One seeded month of business — a part-paid cash sale, a provider-confirmed
 * transfer, an expense, a purchase on credit — and every dashboard figure
 * checked against arithmetic done by hand here in the test. If SQL and the
 * hand total ever disagree, the dashboard was about to lie to a merchant.
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lagosDay, paymentReference, usagePeriod } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import {
  customersRepo,
  identity,
  issueRepo,
  journalDraftsRepo,
  journalRepo,
  openingRepo,
  paymentsHub,
  refundsRepo,
  reportsRepo,
  settleRepo,
  spendRepo,
} from './index.js';
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
      method: 'cash',
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
    const byAccount = Object.fromEntries(rows.map((r) => [r.systemRole ?? r.code, r]));

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

/**
 * The schedule under the profit and loss statement's operating expenses line.
 *
 * Every assertion here is really one assertion in three shapes: the schedule
 * must equal the ledger. It is built from ledger movement rather than from
 * the expenses register precisely so that it cannot drift, and these are the
 * three ways a register-driven query would have drifted.
 */
describe('where the operating expenses went', () => {
  const period = () => usagePeriod(new Date());
  const schedule = (businessId: string) =>
    withBusiness(db, businessId, (tx) => reportsRepo.expenseScheduleFor(tx, businessId, period()));

  it('groups by category and ties to the EXPENSES account exactly', async () => {
    const businessId = await seedBusiness();
    await seedTradingMonth(businessId);
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'shop rent for August',
        category: null,
        amountK: 8_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-rent',
      }),
    );

    const result = await schedule(businessId);
    expect(result.lines).toEqual([
      { category: 'rent', amountK: 8_000_000 },
      { category: 'power', amountK: 1_200_000 },
    ]);
    expect(result.totalK).toBe(9_200_000);

    /* The tie. The statement prints one figure from the sums query and this
     * schedule underneath it, and a merchant reading both must not find two
     * different numbers. */
    const sums = await withBusiness(db, businessId, (tx) =>
      reportsRepo.accountSumsFor(tx, businessId, period()),
    );
    const expensesAccount = sums.find((r) => r.systemRole === 'OPERATING_EXPENSES');
    expect(result.totalK).toBe(
      (expensesAccount?.periodDebitK ?? 0) - (expensesAccount?.periodCreditK ?? 0),
    );
  });

  /* The stock purchase in the seeded month debits INVENTORY. A query over
   * the expenses TABLE would have to remember to exclude it; this one cannot
   * see it at all. */
  it('leaves stock out, because stock is not an operating expense', async () => {
    const businessId = await seedBusiness();
    await seedTradingMonth(businessId);
    const result = await schedule(businessId);
    expect(result.lines.map((l) => l.category)).not.toContain('stock');
    expect(result.totalK).toBe(1_200_000);
  });

  /**
   * A withdrawn expense nets to nothing, and it does so through the reversal
   * rather than through the row's status. That distinction is the whole
   * reason this reads the ledger: a status flag says the entry is wrong NOW,
   * while the ledger says which month stopped carrying the cost.
   */
  it('cancels a withdrawn expense against its own category', async () => {
    const businessId = await seedBusiness();
    const recorded = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'dispatch rider to Yaba',
        category: null,
        amountK: 300_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-9',
      }),
    );
    expect((await schedule(businessId)).lines).toEqual([
      { category: 'transport', amountK: 300_000 },
    ]);

    await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'never happened', 'user:1'),
    );

    const after = await schedule(businessId);
    /* Not "transport: 0" and not "fees: -3,000". The reversal takes the
     * category of what it reverses, the two cancel, and a line worth nothing
     * is not a line. */
    expect(after.lines).toEqual([]);
    expect(after.totalK).toBe(0);
  });

  it('has nothing to say about a month with no expenses', async () => {
    const businessId = await seedBusiness();
    const result = await withBusiness(db, businessId, (tx) =>
      reportsRepo.expenseScheduleFor(tx, businessId, '2020-01'),
    );
    expect(result).toEqual({ lines: [], totalK: 0 });
  });
});

/**
 * The schedule under the profit and loss statement's income line.
 *
 * Its own describe rather than a case in the expense one, because the join it
 * makes is genuinely harder: revenue is reduced by credit notes, which are
 * their own postings, and cancelled by voids, which are mirrors. Each has to
 * find its way back to the channel of the sale it belongs to.
 */
describe('where the sales came from', () => {
  const period = () => usagePeriod(new Date());
  const schedule = (businessId: string) =>
    withBusiness(db, businessId, (tx) => reportsRepo.revenueScheduleFor(tx, businessId, period()));

  const sell = (
    businessId: string,
    saleSource: string | null,
    totalK: number,
    ref: string,
    paidK = 0,
  ) =>
    withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'wig', quantity: 1, unitPriceK: totalK }],
        subtotalK: totalK,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK,
        paidK,
        balanceDueK: totalK - paidK,
        method: 'cash',
        sourceType: 'chat',
        sourceId: ref,
        saleSource,
        actor: 'test',
      }),
    );

  it('groups by channel and ties to the SALES_REVENUE account exactly', async () => {
    const businessId = await seedBusiness();
    await sell(businessId, 'instagram', 3_000_000, 'd1');
    await sell(businessId, 'physical_store', 2_000_000, 'd2');
    await sell(businessId, 'instagram', 1_000_000, 'd3');

    const result = await schedule(businessId);
    expect(result.lines).toEqual([
      { source: 'instagram', amountK: 4_000_000 },
      { source: 'physical_store', amountK: 2_000_000 },
    ]);
    expect(result.totalK).toBe(6_000_000);

    const sums = await withBusiness(db, businessId, (tx) =>
      reportsRepo.accountSumsFor(tx, businessId, period()),
    );
    const revenue = sums.find((r) => r.systemRole === 'SALES_REVENUE');
    expect(result.totalK).toBe((revenue?.periodCreditK ?? 0) - (revenue?.periodDebitK ?? 0));
  });

  /**
   * The common case, and not a failure. Rekoda never asks which channel a
   * sale came through, so most sales have none; the line says so and sorts
   * last whatever its size, because it is the absence of an answer rather
   * than a channel competing with the others.
   */
  it('keeps unattributed sales last, however big they are', async () => {
    const businessId = await seedBusiness();
    await sell(businessId, null, 9_000_000, 'd1');
    await sell(businessId, 'tiktok', 1_000_000, 'd2');

    expect((await schedule(businessId)).lines).toEqual([
      { source: 'tiktok', amountK: 1_000_000 },
      { source: null, amountK: 9_000_000 },
    ]);
  });

  /* A credit note is its own posting against SALES_REVENUE, not an edit. It
   * has to come off the channel of the invoice it credits, and the only route
   * there is the invoice's own ledger link. */
  it('takes a credit note off the channel it was sold on', async () => {
    const businessId = await seedBusiness();
    /* Paid in full, because a credit note against an invoice nobody has paid
     * is refused — and §14.1 needs a customer to owe the credit to. */
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_RPT1',
      [],
    );
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
        customerToken: 'CUSTOMER_RPT1',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 5_000_000 }],
        subtotalK: 5_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 5_000_000,
        paidK: 5_000_000,
        balanceDueK: 0,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd1',
        saleSource: 'instagram',
        actor: 'test',
      }),
    );
    const credited = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueCreditNote(tx, {
        businessId,
        invoiceNumber: sale.invoiceNumber,
        amountK: 2_000_000,
        reason: 'returned one',
        actor: 'user:1',
      }),
    );
    expect(credited.outcome).toBe('credited');

    expect((await schedule(businessId)).lines).toEqual([
      { source: 'instagram', amountK: 3_000_000 },
    ]);
  });

  /* And a void writes a mirror, which finds its channel through reverses_id.
   * Before invoices carried a ledger link this was impossible: the reversal
   * would have shown as unattributed revenue of minus five thousand. */
  it('cancels a voided sale against its own channel', async () => {
    const businessId = await seedBusiness();
    const sale = await sell(businessId, 'instagram', 5_000_000, 'd1');
    await sell(businessId, 'phone', 1_000_000, 'd2');
    await withBusiness(db, businessId, (tx) =>
      issueRepo.voidInvoice(tx, businessId, sale.invoiceNumber, 'never happened', 'user:1'),
    );

    const after = await schedule(businessId);
    expect(after.lines).toEqual([{ source: 'phone', amountK: 1_000_000 }]);
    expect(after.totalK).toBe(1_000_000);
  });

  it('has nothing to say about a month with no sales', async () => {
    const businessId = await seedBusiness();
    const result = await withBusiness(db, businessId, (tx) =>
      reportsRepo.revenueScheduleFor(tx, businessId, '2020-01'),
    );
    expect(result).toEqual({ lines: [], totalK: 0 });
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
    /* One receipt per confirmed payment (spec §15): the ₦40,000 taken with
     * the sale has its own since G-48, beside the ₦50,000 booked later. */
    expect(list.count).toBe(2);
    for (const row of list.rows) {
      expect(row.receiptNumber).toMatch(/^RCT-/);
      expect(row.invoiceNumber).toBe(invoiceNumber);
    }
    expect(list.rows.map((r) => r.amountK).sort((a, b) => a - b)).toEqual([4_000_000, 5_000_000]);
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

/**
 * The last day of a month, which every statement was silently dropping.
 *
 * The period window added a month to a timestamp that had already been pulled
 * back an hour for Lagos. 1 July Lagos is 30 June 23:00 UTC, PostgreSQL keeps
 * the day-of-month when it adds a month, so the window ended on 30 July and
 * the 31st fell outside it. Every month following a shorter one lost days:
 * one for July and May, three for March.
 *
 * It was invisible in every existing test because they all seed activity in
 * the middle of a month. These sit an entry on the last day on purpose, which
 * is exactly where a merchant's month-end takings sit.
 */
describe('the last day of the month', () => {
  const lagosNoonOn = (day: string): Date => new Date(`${day}T12:00:00+01:00`);

  async function spendOn(businessId: string, day: string, amountK: number, ref: string) {
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'diesel',
        category: null,
        amountK,
        method: 'cash',
        sourceType: 'chat',
        sourceId: ref,
        recordedAt: lagosNoonOn(day),
      }),
    );
  }

  /* March after February is the worst case: three days outside the window. */
  it.each([
    ['2026-03', '2026-03-31', 'march'],
    ['2026-03', '2026-03-29', 'march-29'],
    ['2026-07', '2026-07-31', 'july'],
    ['2026-05', '2026-05-31', 'may'],
    ['2026-08', '2026-08-31', 'august'],
  ])('counts %s activity dated %s', async (period, day, ref) => {
    const businessId = await seedBusiness();
    await spendOn(businessId, day, 1_500_000, ref);

    const sums = await withBusiness(db, businessId, (tx) =>
      reportsRepo.accountSumsFor(tx, businessId, period),
    );
    const expenses = sums.find((r) => r.systemRole === 'OPERATING_EXPENSES');
    expect(expenses?.periodDebitK).toBe(1_500_000);
    /* And cumulatively, which is what the balance sheet reads. A sheet "as at
     * end of March" that omits the 31st is money missing from a file somebody
     * hands to a bank. */
    expect(expenses?.cumulativeDebitK).toBe(1_500_000);
  });

  /* The other edge: the window must still END. An entry on the first of the
   * next month belongs to that month, not this one. */
  it('leaves the first of the next month out', async () => {
    const businessId = await seedBusiness();
    await spendOn(businessId, '2026-04-01', 1_500_000, 'april');

    const march = await withBusiness(db, businessId, (tx) =>
      reportsRepo.accountSumsFor(tx, businessId, '2026-03'),
    );
    expect(march.find((r) => r.systemRole === 'OPERATING_EXPENSES')?.periodDebitK ?? 0).toBe(0);
  });

  /* The two schedules carry the same bounds and had the same hole. */
  it('counts a month-end cost in the expense schedule too', async () => {
    const businessId = await seedBusiness();
    await spendOn(businessId, '2026-03-31', 1_500_000, 'schedule');

    const schedule = await withBusiness(db, businessId, (tx) =>
      reportsRepo.expenseScheduleFor(tx, businessId, '2026-03'),
    );
    expect(schedule.totalK).toBe(1_500_000);
  });
});

/**
 * N2 / OWN-44: the window figures a spoken question and a comparison read.
 * Recorded sales, credit notes, cash collected and spending stay distinct, and
 * a void or a refund is never silently absorbed into any of them.
 */
describe('the window summary (N2)', () => {
  const NOW = () => ({
    from: new Date(Date.now() - 3_600_000),
    to: new Date(Date.now() + 3_600_000),
  });
  const summary = (businessId: string) =>
    withBusiness(db, businessId, (tx) => {
      const { from, to } = NOW();
      return reportsRepo.summaryFor(tx, businessId, from, to);
    });

  it('leaves a withdrawn expense out of what was spent', async () => {
    const businessId = await seedBusiness();
    const recorded = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'dispatch rider to Yaba',
        category: null,
        amountK: 300_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-w1',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'fuel',
        category: 'utilities',
        amountK: 100_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-w2',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'never happened', 'user:1'),
    );

    const after = await summary(businessId);
    expect(after.moneyOutK).toBe(100_000);
    expect(after.expenses).toBe(1);
  });

  it('leaves a voided sale out of recorded sales, and reports a credit note beside them', async () => {
    const businessId = await seedBusiness();
    const sale = async (n: number, amountK: number) =>
      withBusiness(db, businessId, (tx) =>
        issueRepo.issueSale(tx, {
          businessId,
          customerId: null,
          customerToken: `CUSTOMER_N2${n}`,
          items: [{ name: 'wig', quantity: 1, unitPriceK: amountK }],
          subtotalK: amountK,
          discountK: 0,
          deliveryFeeK: 0,
          vatK: 0,
          totalK: amountK,
          paidK: 0,
          balanceDueK: amountK,
          method: 'cash',
          sourceType: 'chat',
          sourceId: `n2-${n}`,
          actor: 'test',
        }),
      );
    const kept = await sale(1, 5_000_000);
    const voided = await sale(2, 1_000_000);
    await withBusiness(db, businessId, (tx) =>
      issueRepo.voidInvoice(tx, businessId, voided.invoiceNumber, 'never happened', 'user:1'),
    );
    expect(kept.invoiceNumber).toBeTruthy();

    const after = await summary(businessId);
    expect(after.salesK).toBe(5_000_000);
    expect(after.invoices).toBe(1);
    expect(after.creditedK).toBe(0);
  });

  it('counts only the cash that moved: stock bought on credit leaves recorded spending but not the till', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara fabric',
        amountK: 5_000_000,
        paidK: 2_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'n2-credit-stock',
      }),
    );

    const after = await summary(businessId);
    /* The whole purchase is recorded spending; only the paid part left the
     * till. Cash movement must come from the cash accounts, not from it. */
    expect(after.moneyOutK).toBe(5_000_000);
    expect(after.cashOutK).toBe(2_000_000);
    expect(after.cashInK).toBe(0);
  });

  it('counts a payment as money in only if it really arrived, and reports refunds beside it', async () => {
    const businessId = await seedBusiness();
    const connection = await withBusiness(db, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId, providerType: 'paystack' }),
    );
    /* Money in is read from the ledger (G-118), so each payment below is made
     * the way the product makes it: a merchant-recorded cash sale, and three
     * provider payments booked on open invoices. A different amount each lets
     * the test tell them apart. */
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_N2P0',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 1_000_000 }],
        subtotalK: 1_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 1_000_000,
        paidK: 1_000_000,
        balanceDueK: 0,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'n2-pay-cash',
        actor: 'test',
      }),
    );
    const providerPayment = (amountK: number, sourceId: string) =>
      withBusiness(db, businessId, async (tx) => {
        const sale = await issueRepo.issueSale(tx, {
          businessId,
          customerId: null,
          customerToken: `CUSTOMER_${sourceId}`,
          items: [{ name: 'wig', quantity: 1, unitPriceK: amountK }],
          subtotalK: amountK,
          discountK: 0,
          deliveryFeeK: 0,
          vatK: 0,
          totalK: amountK,
          paidK: 0,
          balanceDueK: amountK,
          method: 'transfer',
          sourceType: 'chat',
          sourceId,
          actor: 'system',
        });
        const intent = await paymentsHub.createIntent(tx, {
          businessId,
          reference: paymentReference(new Date(), (n) => randomBytes(n)),
          expectedAmountK: amountK,
          providerType: 'paystack',
          invoiceId: sale.invoiceId,
        });
        const booked = await settleRepo.bookVerifiedPayment(tx, {
          businessId,
          intent: {
            id: intent.id,
            reference: intent.reference,
            invoiceId: intent.invoiceId,
            customerId: intent.customerId,
          },
          confirmedAmountK: amountK,
          currency: 'NGN',
          providerType: 'paystack',
          providerRef: `pst-${randomBytes(4).toString('hex')}`,
          providerStatus: 'success',
          providerFeeK: 0,
          feePolicy: 'merchant_bearing',
          method: 'transfer',
          actor: 'test',
          eventId: `event-${randomBytes(4).toString('hex')}`,
          paymentConnectionId: connection.id,
        });
        return booked.paymentId;
      });
    await providerPayment(2_000_000, 'n2-pay-kept');
    const refundedPayment = await providerPayment(4_000_000, 'n2-pay-refunded');
    const reversedPayment = await providerPayment(8_000_000, 'n2-pay-reversed');

    await withBusiness(db, businessId, (tx) =>
      refundsRepo.recordRefund(tx, {
        businessId,
        paymentId: refundedPayment,
        amountK: 1_500_000,
        method: 'bank',
        reason: 'returned',
        actor: 'user:1',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      refundsRepo.recordPaymentReversal(tx, {
        businessId,
        paymentId: reversedPayment,
        paymentConnectionId: connection.id,
        reason: 'duplicate charge undone by provider',
        actor: 'provider:paystack',
      }),
    );
    /* A pending and a failed attempt post nothing: no money moved. Rows only,
     * written as the owner because the app role cannot set a status. */
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      await owner`INSERT INTO payments (business_id, amount_k, method, source_type, status)
                  VALUES (${businessId}::uuid, 16000000, 'transfer', 'provider_webhook', 'pending'),
                         (${businessId}::uuid, 32000000, 'transfer', 'provider_webhook', 'failed')`;
    } finally {
      await owner.end();
    }

    const after = await summary(businessId);
    /* 1m cash + 2m kept + 4m refunded-in-part arrived; the 8m reversed one
     * arrived and was taken back; pending and failed never did. */
    expect(after.moneyInK).toBe(7_000_000);
    expect(after.refundedK).toBe(1_500_000);
  });

  it('reports a credit note beside sales instead of netting it away', async () => {
    const businessId = await seedBusiness();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_N2CN',
      [],
    );
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
        customerToken: 'CUSTOMER_N2CN',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 5_000_000 }],
        subtotalK: 5_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 5_000_000,
        paidK: 5_000_000,
        balanceDueK: 0,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'n2-cn',
        actor: 'test',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueCreditNote(tx, {
        businessId,
        invoiceNumber: sale.invoiceNumber,
        amountK: 2_000_000,
        reason: 'returned one',
        actor: 'user:1',
      }),
    );

    const after = await summary(businessId);
    /* Recorded sales stay what was issued; the credit is its own figure. */
    expect(after.salesK).toBe(5_000_000);
    expect(after.creditedK).toBe(2_000_000);
  });
});

/**
 * G-118: the window summary reads the ledger.
 *
 * `summaryFor` feeds the chat sales and spending answers and
 * `GET /v1/reports/compare`. Each figure here is checked against the ledger
 * summed directly, so a second source of truth cannot creep back in.
 */
describe('the window summary reconciles with the ledger (G-118)', () => {
  const wide = () => ({
    from: new Date(Date.now() - 2 * 86_400_000),
    to: new Date(Date.now() + 2 * 86_400_000),
  });
  const summary = (businessId: string) =>
    withBusiness(db, businessId, (tx) => {
      const { from, to } = wide();
      return reportsRepo.summaryFor(tx, businessId, from, to);
    });
  const ledgerNet = (businessId: string, codes: string[], sign: 'debit' | 'credit') =>
    withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ n: string }>(sql`
        SELECT COALESCE(SUM(${sign === 'debit' ? sql`e.debit_k - e.credit_k` : sql`e.credit_k - e.debit_k`}), 0)::text AS n
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.code IN (${sql.join(
          codes.map((c) => sql`${c}`),
          sql`, `,
        )})
      `);
      return Number([...rows][0]!.n);
    });

  it('does not count an opening-balance receivable as a sale', async () => {
    const businessId = await seedBusiness();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_G118O',
      [],
    );
    await withBusiness(db, businessId, (tx) =>
      openingRepo.recordOpeningBalances(tx, {
        businessId,
        asAt: lagosDay(new Date()),
        cashK: 0,
        bankK: 0,
        stockK: 0,
        receivables: [{ customerId: customer.id, amountK: 5_000_000, dueDate: null }],
        actor: 'test',
      }),
    );
    const after = await summary(businessId);
    expect(after.salesK).toBe(0);
    expect(after.invoices).toBe(0);
    expect(await ledgerNet(businessId, ['4000', '2100'], 'credit')).toBe(0);
  });

  it('does not count the cash and bank an opening balance declares as money in', async () => {
    const businessId = await seedBusiness();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_G118OC',
      [],
    );
    await withBusiness(db, businessId, (tx) =>
      openingRepo.recordOpeningBalances(tx, {
        businessId,
        asAt: lagosDay(new Date()),
        cashK: 20_000_000,
        bankK: 10_000_000,
        stockK: 0,
        receivables: [{ customerId: customer.id, amountK: 5_000_000, dueDate: null }],
        actor: 'test',
      }),
    );
    const after = await summary(businessId);
    expect(after.moneyInK).toBe(0);
    expect(after.salesK).toBe(0);
    expect(after.invoices).toBe(0);
  });

  it('still counts a sale whose invoice carries no ledger link (issued before the link existed)', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_G118NL',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 3_000_000 }],
        subtotalK: 3_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 3_000_000,
        paidK: 3_000_000,
        balanceDueK: 0,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'g118-nolink',
        actor: 'test',
      }),
    );
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      await owner`UPDATE invoices SET ledger_transaction_id = NULL WHERE business_id = ${businessId}::uuid`;
    } finally {
      await owner.end();
    }
    const after = await summary(businessId);
    expect(after.salesK).toBe(3_000_000);
    expect(after.invoices).toBe(1);
    expect(after.moneyInK).toBe(3_000_000);
  });

  it('reports a provider payment gross when the provider kept a fee, and the fee as spending', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_G118FEE',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 10_000_000 }],
        subtotalK: 10_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 10_000_000,
        paidK: 0,
        balanceDueK: 10_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'g118-fee',
        actor: 'system',
      });
      const intent = await paymentsHub.createIntent(tx, {
        businessId,
        reference: paymentReference(new Date(), (n) => randomBytes(n)),
        expectedAmountK: 10_000_000,
        providerType: 'paystack',
        invoiceId: sale.invoiceId,
      });
      /* No payment connection, so no clearing account: the fee comes off the
       * bank debit and is posted to expenses. */
      await settleRepo.bookVerifiedPayment(tx, {
        businessId,
        intent: {
          id: intent.id,
          reference: intent.reference,
          invoiceId: intent.invoiceId,
          customerId: intent.customerId,
        },
        confirmedAmountK: 10_000_000,
        currency: 'NGN',
        providerType: 'paystack',
        providerRef: `pst-${randomBytes(4).toString('hex')}`,
        providerStatus: 'success',
        providerFeeK: 150_000,
        feePolicy: 'merchant_bearing',
        method: 'transfer',
        actor: 'test',
        eventId: `event-${randomBytes(4).toString('hex')}`,
      });
    });
    const after = await summary(businessId);
    expect(after.moneyInK).toBe(10_000_000);
    expect(after.moneyOutK).toBe(150_000);
  });

  it('does not let a VAT remittance reduce sales, or a receivable write-off count as money in', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_G118V',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 10_000_000 }],
        subtotalK: 10_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 750_000,
        totalK: 10_750_000,
        paidK: 0,
        balanceDueK: 10_750_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'g118-vat',
        actor: 'test',
      }),
    );
    /* Paying VAT over, and writing a bad debt off, are journals: neither is a
     * sale undone, and neither is a customer paying. */
    await withBusiness(db, businessId, (tx) =>
      journalRepo.recordJournal(tx, {
        businessId,
        memo: 'VAT remitted',
        amountK: 750_000,
        intoAccount: 'VAT_PAYABLE',
        outOfAccount: 'BANK',
        actor: 'user:1',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      journalRepo.recordJournal(tx, {
        businessId,
        memo: 'bad debt written off',
        amountK: 5_000_000,
        intoAccount: 'EXPENSES',
        outOfAccount: 'ACCOUNTS_RECEIVABLE',
        actor: 'user:1',
      }),
    );
    const after = await summary(businessId);
    expect(after.salesK).toBe(10_750_000);
    expect(after.moneyInK).toBe(0);
  });

  it('counts revenue posted by hand in sales but not as an invoice', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      journalRepo.recordJournal(tx, {
        businessId,
        memo: 'cash sale made outside Rekoda',
        amountK: 2_000_000,
        intoAccount: 'CASH',
        outOfAccount: 'SALES_REVENUE',
        actor: 'user:1',
      }),
    );
    const after = await summary(businessId);
    expect(after.salesK).toBe(2_000_000);
    expect(after.invoices).toBe(0);
  });

  it('nets a voided sale out of the invoice count even when the invoice carries no ledger link', async () => {
    const businessId = await seedBusiness();
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_G118NV',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 3_000_000 }],
        subtotalK: 3_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 3_000_000,
        paidK: 0,
        balanceDueK: 3_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'g118-nolink-void',
        actor: 'test',
      }),
    );
    /* An invoice from before the link existed: no link, so its void writes a
     * reversal that names nothing. */
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      await owner`UPDATE invoices SET ledger_transaction_id = NULL WHERE business_id = ${businessId}::uuid`;
    } finally {
      await owner.end();
    }
    await withBusiness(db, businessId, (tx) =>
      issueRepo.voidInvoice(tx, businessId, sale.invoiceNumber, 'never delivered', 'user:1'),
    );
    const after = await summary(businessId);
    expect(after.salesK).toBe(0);
    expect(after.invoices).toBe(0);
  });

  it('counts a posted journal draft that credits revenue in sales but not as an invoice', async () => {
    const businessId = await seedBusiness();
    const accountIdFor = (code: string) =>
      withBusiness(db, businessId, async (tx) => {
        const rows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = ${code}`,
        );
        return [...rows][0]!.id;
      });
    const cash = await accountIdFor('1000');
    const revenue = await accountIdFor('4000');
    const { id } = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.createJournalDraft(tx, {
        businessId,
        memo: 'cash sale, hand entered',
        createdBy: 'user:ada',
        lines: [
          { accountId: cash, debitK: 100_000, creditK: 0 },
          { accountId: revenue, debitK: 0, creditK: 100_000 },
        ],
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.postJournalDraft(tx, { businessId, draftId: id, actor: 'user:ada' }),
    );
    const after = await summary(businessId);
    expect(after.salesK).toBe(100_000);
    expect(after.invoices).toBe(0);
  });

  it('counts a customer advance (cash against unearned revenue) as money in', async () => {
    const businessId = await seedBusiness();
    const accountIdFor = (code: string) =>
      withBusiness(db, businessId, async (tx) => {
        const rows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = ${code}`,
        );
        return [...rows][0]!.id;
      });
    const cash = await accountIdFor('1000');
    const unearned = await accountIdFor('2200');
    const { id } = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.createJournalDraft(tx, {
        businessId,
        memo: 'advance on an order',
        createdBy: 'user:ada',
        lines: [
          { accountId: cash, debitK: 5_000_000, creditK: 0 },
          { accountId: unearned, debitK: 0, creditK: 5_000_000 },
        ],
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.postJournalDraft(tx, { businessId, draftId: id, actor: 'user:ada' }),
    );
    const after = await summary(businessId);
    expect(after.moneyInK).toBe(5_000_000);
    expect(after.salesK).toBe(0);
  });

  it('does not count a write-off in a hand-posted journal as money collected', async () => {
    const businessId = await seedBusiness();
    const accountIdFor = (code: string) =>
      withBusiness(db, businessId, async (tx) => {
        const rows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = ${code}`,
        );
        return [...rows][0]!.id;
      });
    const cash = await accountIdFor('1000');
    const expenses = await accountIdFor('6000');
    const receivable = await accountIdFor('1100');
    const { id } = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.createJournalDraft(tx, {
        businessId,
        memo: 'part payment, rest written off',
        createdBy: 'user:ada',
        lines: [
          { accountId: cash, debitK: 4_000_000, creditK: 0 },
          { accountId: expenses, debitK: 1_000_000, creditK: 0 },
          { accountId: receivable, debitK: 0, creditK: 5_000_000 },
        ],
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.postJournalDraft(tx, { businessId, draftId: id, actor: 'user:ada' }),
    );
    expect((await summary(businessId)).moneyInK).toBe(4_000_000);
  });

  it('counts a collection into a cash account the tenant moved to another code', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE accounts SET code = '1099' WHERE business_id = ${businessId}::uuid AND code = '1000'`,
      ),
    );
    const accountIdFor = (code: string) =>
      withBusiness(db, businessId, async (tx) => {
        const rows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = ${code}`,
        );
        return [...rows][0]!.id;
      });
    const cash = await accountIdFor('1099');
    const receivable = await accountIdFor('1100');
    const { id } = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.createJournalDraft(tx, {
        businessId,
        memo: 'customer paid into moved till',
        createdBy: 'user:ada',
        lines: [
          { accountId: cash, debitK: 2_000_000, creditK: 0 },
          { accountId: receivable, debitK: 0, creditK: 2_000_000 },
        ],
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.postJournalDraft(tx, { businessId, draftId: id, actor: 'user:ada' }),
    );
    expect((await summary(businessId)).moneyInK).toBe(2_000_000);
  });

  it('still counts a sale by chart role after the tenant moved revenue and receivables to other codes', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_ROLE',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 1_000_000 }],
        subtotalK: 1_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 1_000_000,
        paidK: 0,
        balanceDueK: 1_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'g118-role',
        actor: 'test',
      }),
    );
    await withBusiness(db, businessId, async (tx) => {
      await tx.execute(
        sql`UPDATE accounts SET code = '4999' WHERE business_id = ${businessId}::uuid AND system_role = 'SALES_REVENUE'`,
      );
      await tx.execute(
        sql`UPDATE accounts SET code = '1199' WHERE business_id = ${businessId}::uuid AND system_role = 'ACCOUNTS_RECEIVABLE'`,
      );
    });
    const after = await summary(businessId);
    expect(after.salesK).toBe(1_000_000);
    expect(after.invoices).toBe(1);
  });

  it('recognises an advance by the chart role when the tenant moved unearned revenue to another code', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE accounts SET code = '2299' WHERE business_id = ${businessId}::uuid AND system_role = 'CONTRACT_LIABILITY'`,
      ),
    );
    const accountIdFor = (code: string) =>
      withBusiness(db, businessId, async (tx) => {
        const rows = await tx.execute<{ id: string }>(
          sql`SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = ${code}`,
        );
        return [...rows][0]!.id;
      });
    const cash = await accountIdFor('1000');
    const unearned = await accountIdFor('2299');
    const { id } = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.createJournalDraft(tx, {
        businessId,
        memo: 'advance on an order',
        createdBy: 'user:ada',
        lines: [
          { accountId: cash, debitK: 3_000_000, creditK: 0 },
          { accountId: unearned, debitK: 0, creditK: 3_000_000 },
        ],
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.postJournalDraft(tx, { businessId, draftId: id, actor: 'user:ada' }),
    );
    expect((await summary(businessId)).moneyInK).toBe(3_000_000);
  });

  it("does not let a void of an earlier sale reduce this window's invoice count, and keeps a later void out of the expense count", async () => {
    const businessId = await seedBusiness();
    const sell = (sourceId: string) =>
      withBusiness(db, businessId, (tx) =>
        issueRepo.issueSale(tx, {
          businessId,
          customerId: null,
          customerToken: `CUSTOMER_${sourceId}`,
          items: [{ name: 'wig', quantity: 1, unitPriceK: 1_000_000 }],
          subtotalK: 1_000_000,
          discountK: 0,
          deliveryFeeK: 0,
          vatK: 0,
          totalK: 1_000_000,
          paidK: 0,
          balanceDueK: 1_000_000,
          method: 'transfer',
          sourceType: 'chat',
          sourceId,
          actor: 'test',
        }),
      );
    const early = await sell('g118-early');
    await sell('g118-now');
    await withBusiness(db, businessId, (tx) =>
      issueRepo.voidInvoice(tx, businessId, early.invoiceNumber, 'never delivered', 'user:1'),
    );
    const spent = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'fuel',
        category: 'utilities',
        amountK: 400_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'g118-late-void',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, spent.expenseId, 'never happened', 'user:1'),
    );
    /* Move the early sale back five days and the expense's void forward five,
     * as the owner with the append-only guards suspended: a fixture only. */
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      await owner.unsafe(`
        SET session_replication_role = replica;
        UPDATE ledger_entries SET created_at = now() - interval '5 days'
         WHERE business_id = '${businessId}'
           AND transaction_id IN (SELECT id FROM ledger_transactions
                                   WHERE business_id = '${businessId}' AND source_id = 'g118-early'
                                     AND reverses_id IS NULL);
        UPDATE ledger_entries SET created_at = now() + interval '5 days'
         WHERE business_id = '${businessId}'
           AND transaction_id IN (SELECT id FROM ledger_transactions
                                   WHERE business_id = '${businessId}' AND source_id = 'g118-late-void'
                                     AND reverses_id IS NOT NULL);
        UPDATE ledger_transactions SET created_at = now() - interval '5 days'
         WHERE business_id = '${businessId}' AND source_id = 'g118-early' AND reverses_id IS NULL;
        UPDATE ledger_transactions SET created_at = now() + interval '5 days'
         WHERE business_id = '${businessId}' AND source_id = 'g118-late-void' AND reverses_id IS NOT NULL;
        SET session_replication_role = origin;`);
    } finally {
      await owner.end();
    }
    const after = await summary(businessId);
    /* This window holds one new sale and the void of a sale made five days ago:
     * the void takes sales down by the earlier sale's amount, but it is not
     * one of this window's invoices, so the count stays at one. */
    expect(after.invoices).toBe(1);
    expect(after.salesK).toBe(0);
    /* The expense was made inside the window and voided after it: its money is
     * counted, so its entry is too. */
    expect(after.moneyOutK).toBe(400_000);
    expect(after.expenses).toBe(1);
  });

  it('counts spending the ledger holds even where no register row exists, and ties to the ledger', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'fuel',
        category: 'utilities',
        amountK: 300_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'g118-e1',
      }),
    );
    /* A charge posted straight to the expenses account, as a provider fee is:
     * a journal, so no row in the expense register. */
    await withBusiness(db, businessId, (tx) =>
      journalRepo.recordJournal(tx, {
        businessId,
        memo: 'provider fee',
        amountK: 50_000,
        intoAccount: 'EXPENSES',
        outOfAccount: 'CASH',
        actor: 'user:1',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'bales',
        amountK: 2_000_000,
        paidK: 0,
        method: null,
        sourceType: 'chat',
        sourceId: 'g118-p1',
      }),
    );
    const after = await summary(businessId);
    expect(after.moneyOutK).toBe(
      (await ledgerNet(businessId, ['6000'], 'debit')) +
        (await ledgerNet(businessId, ['1200'], 'debit')),
    );
    expect(after.moneyOutK).toBe(300_000 + 50_000 + 2_000_000);
    /* Only the register's two entries are counted as entries. */
    expect(after.expenses).toBe(2);
  });

  it('keeps sales, the unpaid part and cash received apart, and every figure ties to the ledger', async () => {
    const businessId = await seedBusiness();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_G118S',
      [],
    );
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
        customerToken: 'CUSTOMER_G118S',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 10_000_000 }],
        subtotalK: 10_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 750_000,
        totalK: 10_750_000,
        paidK: 4_000_000,
        balanceDueK: 6_750_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'g118-s1',
        actor: 'test',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueCreditNote(tx, {
        businessId,
        invoiceNumber: sale.invoiceNumber,
        amountK: 1_000_000,
        reason: 'returned',
        actor: 'user:1',
      }),
    );
    const after = await summary(businessId);
    /* What was sold is the whole invoice; only the paid part is cash. */
    expect(after.salesK).toBe(10_750_000);
    expect(after.invoices).toBe(1);
    expect(after.moneyInK).toBe(4_000_000);
    expect(after.creditedK).toBe(1_000_000);
    expect(after.cashInK).toBe(4_000_000);
    /* The ledger, summed directly, says the same. */
    expect(after.salesK - after.creditedK).toBe(
      await ledgerNet(businessId, ['4000', '2100'], 'credit'),
    );
    expect(after.cashInK - after.cashOutK).toBe(
      await ledgerNet(businessId, ['1000', '1010', '1020', '1015'], 'debit'),
    );
    /* What is still owed is a receivable, in neither sales nor cash. */
    expect(await ledgerNet(businessId, ['1100'], 'debit')).toBe(6_750_000);
  });
});
