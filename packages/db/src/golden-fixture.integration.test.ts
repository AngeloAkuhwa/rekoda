/**
 * The golden business fixture, v1 (spec §32; PR-050 — the F1 convergence
 * gate). One fictional business, run end to end through the kernel F1
 * built, then proved to TIE: general ledger, trial balance, profit and
 * loss, balance sheet, and accounts receivable, each computed from the
 * rows and required to agree with the others. This is the only test that
 * can catch an error that is individually plausible everywhere and
 * collectively wrong.
 *
 * v1 covers what F1's kernel supports; each later slice EXTENDS this file
 * (settlement, bank feed, reconciliation, returns, chargebacks land with
 * their slices; the complete eleven-output fixture is PR-085's gate). A
 * slice that cannot extend the fixture has not finished.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lagosDay } from '@rekoda/core';
import { PeriodClosed } from './repos/close.js';
import {
  assetsRepo,
  closeRepo,
  createDb,
  customerCreditsRepo,
  customersRepo,
  fxRepo,
  identity,
  issueRepo,
  openingRepo,
  ordersRepo,
  recognitionPolicyRepo,
  recognitionRepo,
  settleRepo,
  spendRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

/** Yesterday's Lagos month-end shape: the last day of last month. */
function lastMonthEnd(): { day: string; month: string } {
  const today = lagosDay(new Date());
  const [y, m] = today.split('-').map(Number) as [number, number];
  const firstOfThis = new Date(Date.UTC(y, m - 1, 1, 12));
  const endOfLast = new Date(firstOfThis.getTime() - 24 * 60 * 60 * 1000);
  const day = endOfLast.toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

/** Net sums per account type, straight off the rows and the chart. */
async function typedSums(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ type: string; debit_k: string; credit_k: string }>(sql`
      SELECT a.type, COALESCE(SUM(e.debit_k), 0)::bigint AS debit_k,
             COALESCE(SUM(e.credit_k), 0)::bigint AS credit_k
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      WHERE e.business_id = ${businessId}::uuid
      GROUP BY a.type
    `),
  );
  const sums: Record<string, { debitK: number; creditK: number }> = {};
  for (const row of rows)
    sums[row.type] = { debitK: Number(row.debit_k), creditK: Number(row.credit_k) };
  const net = (type: string, side: 'debit' | 'credit') => {
    const at = sums[type] ?? { debitK: 0, creditK: 0 };
    return side === 'debit' ? at.debitK - at.creditK : at.creditK - at.debitK;
  };
  return { sums, net };
}

describe('the golden business (§32)', () => {
  it('lives a month, closes its books, and everything ties', async () => {
    /* ── Ada Fashion begins ─────────────────────────────────────────── */
    const owner = await identity.upsertUserByPhone(db, '+2348189000001');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion (golden)',
      businessType: null,
      ownerUserId: owner.id,
    });
    const businessId = business.id;
    const { day: openingDay, month: lastMonth } = lastMonthEnd();

    /* Orders earn on fulfilment: the recognition policy, set up front. */
    await withBusiness(db, businessId, (tx) =>
      recognitionPolicyRepo.setReceivablePolicy(tx, {
        businessId,
        policy: 'ON_FULFILMENT',
        actor: 'user:ada',
      }),
    );

    /* 1 ── opening balances, as at the end of last month. */
    await withBusiness(db, businessId, (tx) =>
      openingRepo.recordOpeningBalances(tx, {
        businessId,
        asAt: openingDay,
        cashK: 500_000,
        bankK: 1_000_000,
        stockK: 300_000,
        actor: 'user:ada',
      }),
    );

    /* 2 ── inventory purchased on part-credit: the supplier bill, then a
     * partial supplier payment. */
    const purchase = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'Brazilian wigs, 10 units',
        amountK: 200_000,
        paidK: 50_000,
        sourceType: 'dashboard',
        sourceId: 'golden-po-1',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      spendRepo.paySupplier(tx, {
        businessId,
        expenseId: purchase.expenseId,
        amountK: 50_000,
        method: 'transfer',
        actor: 'user:ada',
      }),
    );

    /* 3 ── a cash sale, paid in full at the counter. */
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'wig', quantity: 1, unitPriceK: 150_000 }],
        subtotalK: 150_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 150_000,
        paidK: 150_000,
        balanceDueK: 0,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'golden-cash-sale',
        saleSource: null,
        dueDate: null,
        actor: 'system',
      }),
    );

    /* 4 ── a credit sale to a named customer, and a later part-payment. */
    const bola = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_G1',
      [],
    );
    const creditSale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: bola.id,
        customerToken: bola.token,
        items: [{ name: 'bridal set', quantity: 1, unitPriceK: 250_000 }],
        subtotalK: 250_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 250_000,
        paidK: 0,
        balanceDueK: 250_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'golden-credit-sale',
        saleSource: null,
        dueDate: null,
        actor: 'system',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: creditSale.invoiceId,
        amountK: 100_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'golden-credit-pay',
        actor: 'system',
      }),
    );

    /* 5 ── an order through the recognition engine: deposit, partial
     * fulfilment, final fulfilment, balance. Three units at 100,000. */
    const order = await withBusiness(db, businessId, (tx) =>
      ordersRepo.placeOrder(tx, {
        businessId,
        customerId: bola.id,
        lines: [
          {
            productId: null,
            name: 'aso ebi',
            quantity: 3,
            unitPriceK: 33_334,
            lineTotalK: 100_000,
          },
        ],
        totalK: 100_000,
        sourceType: 'chat',
        sourceId: 'golden-order',
      }),
    );
    const rec = (
      sourceId: string,
      event: Parameters<typeof recognitionRepo.applyRecognition>[1]['event'],
    ) =>
      withBusiness(db, businessId, (tx) =>
        recognitionRepo.applyRecognition(tx, {
          businessId,
          orderId: order.id,
          sourceType: 'golden',
          sourceId,
          event,
          actor: 'user:ada',
        }),
      );
    await rec('deposit', { kind: 'PAYMENT_COLLECTED', amountMinor: 30_000, moneyRole: 'BANK' });
    const partial = await rec('fulfil-1', { kind: 'FULFILMENT', earnedToDateMinor: 33_333 });
    expect(partial).toMatchObject({ outcome: 'posted', revenueDeltaMinor: 33_333 });
    const final = await rec('fulfil-2', { kind: 'FULFILMENT', earnedToDateMinor: 100_000 });
    expect(final).toMatchObject({ outcome: 'posted', revenueDeltaMinor: 66_667 });
    await rec('balance', { kind: 'PAYMENT_COLLECTED', amountMinor: 70_000, moneyRole: 'BANK' });
    expect(
      await withBusiness(db, businessId, (tx) =>
        recognitionRepo.orderLedgerState(tx, businessId, order.id),
      ),
    ).toEqual({
      contractLiabilityMinor: 0,
      receivableMinor: 0,
      revenueRecognisedToDateMinor: 100_000,
    });

    /* 6 ── a customer overpaid once; the business owes it back. */
    await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.grantCustomerCredit(tx, {
        businessId,
        customerId: bola.id,
        amountMinor: 10_000,
        sourceType: 'overpayment',
        sourceId: 'golden-overpay',
      }),
    );

    /* 7 ── an operating expense and a fixed asset that starts wearing. */
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'Shop rent',
        category: 'rent',
        amountK: 40_000,
        method: 'transfer',
        sourceType: 'dashboard',
        sourceId: 'golden-rent',
      }),
    );
    const asset = await withBusiness(db, businessId, (tx) =>
      assetsRepo.recordAsset(tx, {
        businessId,
        description: 'Sewing machine',
        costK: 120_000,
        paidK: 120_000,
        usefulLifeMonths: 12,
        method: 'cash',
        actor: 'user:ada',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      assetsRepo.chargeOneMonth(tx, {
        businessId,
        assetId: asset.assetId,
        expectMonthsCharged: 0,
        at: new Date(),
      }),
    );

    /* 8 ── one FX transaction: dollars arrived, booked at the day's rate,
     * functional to the kobo. */
    const rate = await withBusiness(db, businessId, (tx) =>
      fxRepo.recordExchangeRateSnapshot(tx, {
        baseCurrency: 'USD',
        quoteCurrency: 'NGN',
        rate: '1512.30',
        effectiveAt: new Date(),
        source: 'PROVIDER',
        providerName: 'golden-test',
      }),
    );
    await withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
        VALUES (${businessId}::uuid, 'USD sale via diaspora cousin', 'manual', 'golden-fx')
        RETURNING id
      `);
      const txId = [...rows][0]!.id;
      await tx.execute(sql`
        INSERT INTO ledger_entries
          (business_id, transaction_id, account_id, debit_k, credit_k,
           transaction_currency, transaction_amount_minor, exchange_rate_snapshot_id)
        VALUES
          (${businessId}::uuid, ${txId}::uuid,
           (SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = '1020'),
           22_685, 0, 'USD', 1500, ${rate.id}::uuid),
          (${businessId}::uuid, ${txId}::uuid,
           (SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = '4000'),
           0, 22_685, 'USD', 1500, ${rate.id}::uuid)
      `);
    });

    /* 9 ── the accounting close: last month's figures may not move. */
    const closed = await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, { businessId, through: lastMonth, actor: 'user:ada' }),
    );
    expect(closed.outcome).toBe('closed');

    /* ══ THE TIES ══════════════════════════════════════════════════════ */
    const { net } = await typedSums(businessId);

    /* General ledger: every kobo of debit met by a kobo of credit. */
    const totals = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ d: string; c: string }>(sql`
        SELECT COALESCE(SUM(debit_k), 0)::bigint AS d, COALESCE(SUM(credit_k), 0)::bigint AS c
        FROM ledger_entries WHERE business_id = ${businessId}::uuid
      `),
    );
    const gl = [...totals][0]!;
    expect(Number(gl.d)).toBeGreaterThan(0);
    expect(Number(gl.d)).toBe(Number(gl.c));

    /* Trial balance: per-account nets, summed with their normal sides,
     * come to exactly zero. */
    const tb = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ code: string; net: string }>(sql`
        SELECT a.code, (COALESCE(SUM(e.debit_k), 0) - COALESCE(SUM(e.credit_k), 0))::bigint AS net
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid
        GROUP BY a.code
      `),
    );
    const tbRows = [...tb];
    expect(tbRows.length).toBeGreaterThan(8);
    expect(tbRows.reduce((n, r) => n + Number(r.net), 0)).toBe(0);

    /* Profit and loss: what the month earned, minus what it cost. */
    const revenueK = net('income', 'credit');
    const expensesK = net('expense', 'debit');
    /* cash sale 150k + credit sale 250k + recognised order 100k + FX 22,685 */
    expect(revenueK).toBe(522_685);
    /* rent 40k + one month of the machine 10k */
    expect(expensesK).toBe(50_000);
    const profitK = revenueK - expensesK;

    /* Balance sheet: assets equal liabilities plus equity plus the profit
     * the P&L just reported — the same rows, agreeing about the business. */
    const assetsK = net('asset', 'debit');
    const liabilitiesK = net('liability', 'credit');
    const equityK = net('equity', 'credit');
    expect(assetsK).toBe(liabilitiesK + equityK + profitK);

    /* Accounts receivable: the ledger's AR balance IS the sum of open
     * invoice balances. Two systems of record, one answer. */
    const arLedger = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT (COALESCE(SUM(e.debit_k), 0) - COALESCE(SUM(e.credit_k), 0))::bigint AS k
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.system_role = 'ACCOUNTS_RECEIVABLE'
      `),
    );
    const arInvoices = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(balance_due_k), 0)::bigint AS k
        FROM invoices
        WHERE business_id = ${businessId}::uuid AND status IN ('issued', 'partially_paid')
      `),
    );
    expect(Number([...arLedger][0]!.k)).toBe(150_000);
    expect(Number([...arLedger][0]!.k)).toBe(Number([...arInvoices][0]!.k));

    /* And the close holds: a posting dated into the closed month refuses. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        spendRepo.recordExpense(tx, {
          businessId,
          description: 'backdated mischief',
          category: null,
          amountK: 5_000,
          method: 'cash',
          sourceType: 'dashboard',
          sourceId: 'golden-backdated',
          recordedAt: new Date(`${openingDay}T12:00:00Z`),
        }),
      ),
    ).rejects.toBeInstanceOf(PeriodClosed);
  });
});
