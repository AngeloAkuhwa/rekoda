/**
 * The golden business fixture, COMPLETE (spec §32; PR-085 — the F2
 * completion gate). One fictional business, run end to end through
 * everything F1, P2, B1 and F2 built, then proved to TIE across the
 * eleven outputs §32 names: general ledger, trial balance, profit and
 * loss, balance sheet, cash flow, accounts receivable, accounts payable,
 * inventory, customer statement, supplier statement, reconciliation.
 * This is the only test that can catch an error that is individually
 * plausible everywhere and collectively wrong.
 *
 * v1 (PR-050) certified F1; this version carries the deferrals it named:
 * provider settlement and fee, bank feed import and reconciliation,
 * refund, sale return, payment reversal, chargeback — plus F2's tax
 * point, §14.1 credit note, counted opening stock and the opening
 * receivable behind a real invoice.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lagosDay, paymentReference, postCostOfSale } from '@rekoda/core';
import { PeriodClosed } from './repos/close.js';
import {
  accountsRepo,
  assetsRepo,
  bankRepo,
  chargebacksRepo,
  closeRepo,
  createDb,
  customerCreditsRepo,
  customersRepo,
  fxRepo,
  identity,
  issueRepo,
  openingRepo,
  ordersRepo,
  paymentsHub,
  projectionsRepo,
  recognitionPolicyRepo,
  recognitionRepo,
  refundsRepo,
  returnsRepo,
  settleRepo,
  settlementsRepo,
  spendRepo,
  sql,
  stockRepo,
  suppliersRepo,
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

    /* 1 ── opening balances, as at the end of last month: money, the shelf
     * COUNTED (PR-083 — 15 wigs at ₦200 each, both books from one
     * statement), and a debt a customer already owed — a real invoice, not
     * a figure. */
    const chidi = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_G0',
      [],
    );
    await withBusiness(db, businessId, (tx) =>
      openingRepo.recordOpeningBalances(tx, {
        businessId,
        asAt: openingDay,
        cashK: 500_000,
        bankK: 1_000_000,
        stockK: 0,
        stock: [{ name: 'wig', quantity: 15, unitCostK: 20_000 }],
        receivables: [{ customerId: chidi.id, amountK: 50_000 }],
        actor: 'user:ada',
      }),
    );

    /* 2 ── inventory purchased on part-credit from a NAMED supplier: the
     * goods arrive counted, the bill is minted for what is owed, then a
     * partial supplier payment. */
    const supplier = await withBusiness(db, businessId, (tx) =>
      suppliersRepo.findOrCreateSupplier(tx, businessId, {
        nameCipher: 'enc:golden-supplier',
        matchKey: 'mk-golden-supplier',
      }),
    );
    const purchase = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'Brazilian wigs, 10 units',
        amountK: 200_000,
        paidK: 50_000,
        sourceType: 'dashboard',
        sourceId: 'golden-po-1',
        supplierId: supplier.supplierId,
      }),
    );
    await withBusiness(db, businessId, async (tx) => {
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 10,
        costK: 200_000,
        sourceType: 'dashboard',
        sourceId: 'golden-po-1',
      });
    });
    await withBusiness(db, businessId, (tx) =>
      spendRepo.paySupplier(tx, {
        businessId,
        expenseId: purchase.expenseId,
        amountK: 50_000,
        method: 'transfer',
        actor: 'user:ada',
      }),
    );

    /* 3 ── a cash sale, paid in full at the counter — and because the wig
     * is a counted, costed product, the goods move and their cost posts,
     * the same two acts the sale command performs. */
    const cashSale = await withBusiness(db, businessId, async (tx) => {
      const issued = await issueRepo.issueSale(tx, {
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
      });
      const moved = await stockRepo.recordSaleMovements(
        tx,
        businessId,
        [{ name: 'wig', quantity: 1 }],
        issued.invoiceId,
      );
      expect(moved.costK).toBe(20_000);
      await issueRepo.writePosting(
        tx,
        businessId,
        postCostOfSale({ memo: `Cost of goods on ${issued.invoiceNumber}`, costK: moved.costK }),
        'invoice',
        issued.invoiceNumber,
      );
      return issued;
    });

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
     * functional to the kobo.
     *
     * USD 15.00 is `transaction_amount_minor: 1500`, because a transaction
     * amount is in the TRANSACTION currency's minor unit. At 1512.30 that is
     * ₦22,684.50, and the functional columns are KOBO like every other `_k`
     * in this schema, so the figure is 2,268,450.
     *
     * It read 22,685 until now: the naira amount written into a kobo column,
     * out by a factor of a hundred. PostgreSQL accepted it because migration
     * 0070 deliberately postponed the cross-currency numeric tolerance until
     * the first writer that could post one, so the only thing checking this
     * arithmetic was a person reading it. FX-03 ships that trigger, and this
     * fixture has to be right before it does. */
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
           2_268_450, 0, 'USD', 1500, ${rate.id}::uuid),
          (${businessId}::uuid, ${txId}::uuid,
           (SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = '4000'),
           0, 2_268_450, 'USD', 1500, ${rate.id}::uuid)
      `);
    });

    /* 9 ── a sale that carries VAT (§13): the separated calculator's
     * figures on the document, the liability on 2100, and the TAX POINT
     * recorded once as its own event. */
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'gele styling', quantity: 1, unitPriceK: 40_000 }],
        subtotalK: 40_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 3_000,
        totalK: 43_000,
        paidK: 43_000,
        balanceDueK: 0,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'golden-vat-sale',
        saleSource: null,
        dueDate: null,
        actor: 'system',
      }),
    );

    /* 10 ── a §14.1 credit note on the part-paid credit sale, granted as a
     * CustomerCredit and then EXPLICITLY applied to the same invoice's
     * remaining balance. The balance moves only at the application. */
    const note = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueCreditNote(tx, {
        businessId,
        invoiceNumber: creditSale.invoiceNumber,
        amountK: 20_000,
        reason: 'two damaged pieces',
        actor: 'user:ada',
      }),
    );
    if (note.outcome !== 'credited') throw new Error(`credit refused: ${note.outcome}`);
    await withBusiness(db, businessId, (tx) =>
      issueRepo.applyCreditToInvoice(tx, {
        businessId,
        customerCreditId: note.customerCreditId,
        invoiceNumber: creditSale.invoiceNumber,
        amountK: 20_000,
        actor: 'user:ada',
      }),
    );

    /* 11 ── a sale RETURN, RESALABLE: the wig comes back at its ORIGINAL
     * issue cost, COGS reverses, and the shelf counts it again (§14.3). */
    const returned = await withBusiness(db, businessId, async (tx) => {
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      return returnsRepo.recordGoodsReturn(tx, {
        businessId,
        productId: wig.id,
        invoiceId: cashSale.invoiceId,
        quantity: 1,
        disposition: 'RESALABLE',
        sourceType: 'dashboard',
        sourceId: 'golden-return',
        actor: 'user:ada',
      });
    });
    expect(returned).toMatchObject({ outcome: 'returned', originalIssueCostK: 20_000 });

    /* 12 ── the provider path, end to end (P2): a connection with its own
     * clearing and chargeback accounts; a provider-verified payment into
     * clearing; the SETTLEMENT that moves clearing to the payout bank net
     * of the provider's fee; a refund; a post-settlement chargeback; and a
     * pre-settlement payment REVERSAL — five different facts, five
     * different postings, none pretending to be another. */
    const connection = await withBusiness(db, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId, providerType: 'paystack' }),
    );
    await withBusiness(db, businessId, (tx) =>
      accountsRepo.provisionConnectionAccounts(tx, {
        businessId,
        paymentConnectionId: connection.id,
        providerLabel: 'Paystack',
      }),
    );

    const providerSale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: bola.id,
        customerToken: bola.token,
        items: [{ name: 'lace set', quantity: 1, unitPriceK: 80_000 }],
        subtotalK: 80_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 80_000,
        paidK: 0,
        balanceDueK: 80_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'golden-provider-sale',
        saleSource: null,
        dueDate: null,
        actor: 'system',
      }),
    );
    const settledPayment = await withBusiness(db, businessId, async (tx) => {
      const intent = await paymentsHub.createIntent(tx, {
        businessId,
        reference: paymentReference(new Date(), (n) => randomBytes(n)),
        expectedAmountK: 80_000,
        providerType: 'paystack',
        invoiceId: providerSale.invoiceId,
      });
      return settleRepo.bookVerifiedPayment(tx, {
        businessId,
        intent: {
          id: intent.id,
          reference: intent.reference,
          invoiceId: intent.invoiceId,
          customerId: bola.id,
        },
        confirmedAmountK: 80_000,
        currency: 'NGN',
        providerType: 'paystack',
        providerRef: 'pst-golden-1',
        providerStatus: 'success',
        providerFeeK: 0,
        feePolicy: 'merchant_bearing',
        method: 'transfer',
        actor: 'system',
        eventId: 'golden-webhook-1',
        paymentConnectionId: connection.id,
      });
    });

    const settlement = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, {
        businessId,
        paymentConnectionId: connection.id,
        providerSettlementId: 'STL_GOLDEN_1',
        status: 'SETTLED',
        grossK: 80_000,
        netK: 78_800,
        settledAt: new Date(),
        items: [{ paymentId: settledPayment.paymentId, amountK: 80_000 }],
        components: [{ kind: 'PROCESSING_FEE', direction: 'DEDUCTION', amountK: 1_200 }],
      }),
    );
    if (settlement.outcome !== 'recorded') throw new Error('settlement refused');
    const posted = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.postSettlement(tx, businessId, settlement.id),
    );
    expect(posted).toMatchObject({ posted: true });

    /* Money back OUT of the payout pocket for goods partly not wanted. */
    const refund = await withBusiness(db, businessId, (tx) =>
      refundsRepo.recordRefund(tx, {
        businessId,
        paymentId: settledPayment.paymentId,
        amountK: 5_000,
        method: 'bank',
        reason: 'one damaged clip',
        actor: 'user:ada',
      }),
    );
    expect(refund.outcome).toBe('recorded');

    /* The provider took a dispute AFTER paying out: a payable, not a
     * clearing adjustment (§21.2). */
    const chargeback = await withBusiness(db, businessId, (tx) =>
      chargebacksRepo.recordChargeback(tx, {
        businessId,
        paymentConnectionId: connection.id,
        paymentId: settledPayment.paymentId,
        providerChargebackId: 'CBK_GOLDEN_1',
        amountK: 10_000,
        reason: 'customer dispute',
      }),
    );
    expect(chargeback.outcome).toBe('recorded');

    /* And one payment that never made it to settlement: verified, then
     * reversed by the provider — clearing hands the money back. */
    const reversedSale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: bola.id,
        customerToken: bola.token,
        items: [{ name: 'shoes', quantity: 1, unitPriceK: 15_000 }],
        subtotalK: 15_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000,
        paidK: 0,
        balanceDueK: 15_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'golden-reversed-sale',
        saleSource: null,
        dueDate: null,
        actor: 'system',
      }),
    );
    await withBusiness(db, businessId, async (tx) => {
      const intent = await paymentsHub.createIntent(tx, {
        businessId,
        reference: paymentReference(new Date(), (n) => randomBytes(n)),
        expectedAmountK: 15_000,
        providerType: 'paystack',
        invoiceId: reversedSale.invoiceId,
      });
      const booked = await settleRepo.bookVerifiedPayment(tx, {
        businessId,
        intent: {
          id: intent.id,
          reference: intent.reference,
          invoiceId: intent.invoiceId,
          customerId: bola.id,
        },
        confirmedAmountK: 15_000,
        currency: 'NGN',
        providerType: 'paystack',
        providerRef: 'pst-golden-2',
        providerStatus: 'success',
        providerFeeK: 0,
        feePolicy: 'merchant_bearing',
        method: 'transfer',
        actor: 'system',
        eventId: 'golden-webhook-2',
        paymentConnectionId: connection.id,
      });
      const reversal = await refundsRepo.recordPaymentReversal(tx, {
        businessId,
        paymentId: booked.paymentId,
        paymentConnectionId: connection.id,
        reason: 'provider reversed the transfer',
        actor: 'system',
        providerReversalId: 'RVSL_GOLDEN_1',
      });
      expect(reversal).toMatchObject({ outcome: 'recorded', amountK: 15_000 });
    });

    /* 13 ── the bank statement arrives (B1): two lines, imported through
     * the connection-scoped door, reconciled until every line is explained
     * — one by the rule, or each by a person with a reason. */
    await withBusiness(db, businessId, (tx) =>
      bankRepo.linkFeed(tx, {
        businessId,
        provider: 'mono',
        accountRef: 'acct_golden',
        bankName: 'GTBank',
        accountLast4: '4821',
        actor: 'user:ada',
      }),
    );
    const feed = await withBusiness(db, businessId, (tx) =>
      bankRepo.feedConnectionFor(tx, businessId),
    );
    const today = lagosDay(new Date());
    await withBusiness(db, businessId, (tx) =>
      bankRepo.importStatementLines(tx, {
        businessId,
        lines: [
          {
            postedOn: today,
            amountK: 100_000,
            narration: 'TRANSFER IN',
            bankRef: null,
            externalTransactionId: 'mono_golden_1',
            row: 1,
          },
          {
            postedOn: today,
            amountK: -50_000,
            narration: 'TRANSFER OUT',
            bankRef: null,
            externalTransactionId: 'mono_golden_2',
            row: 2,
          },
        ],
        actor: 'system:bank-feed',
        connectionId: feed!.id,
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      bankRepo.reconcile(tx, { businessId, commit: true }),
    );
    /* Whatever the rule could not decide, a person decides with a reason. */
    await withBusiness(db, businessId, async (tx) => {
      const everyLine = await bankRepo.bankLinesFor(tx, businessId);
      const explained = await tx.execute<{ line_id: string }>(
        sql`SELECT line_id FROM bank_line_matches WHERE business_id = ${businessId}::uuid`,
      );
      const spokenFor = new Set([...explained].map((r) => r.line_id));
      const waiting = everyLine.filter((line) => !spokenFor.has(line.id));
      for (const line of waiting) {
        const candidates = await bankRepo.openMovements(tx, businessId, {
          amounts: [line.amountK],
        });
        const movement = candidates.find((m) => m.amountK === line.amountK);
        if (!movement) throw new Error(`no movement for line ${line.amountK}`);
        const paired = await bankRepo.matchByHand(tx, {
          businessId,
          lineId: line.id,
          transactionId: movement.transactionId,
          actor: 'user:ada',
          reason: 'Matched against the register by hand',
        });
        expect(paired).toEqual({ outcome: 'matched' });
      }
    });

    /* 14 ── the accounting close: last month's figures may not move. */
    const closed = await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, { businessId, through: lastMonth, actor: 'user:ada' }),
    );
    expect(closed.outcome).toBe('closed');

    /* ══ THE ELEVEN TIES (§32) ═════════════════════════════════════════ */
    const { net } = await typedSums(businessId);
    const roleBalance = async (role: string) => {
      const rows = await withBusiness(db, businessId, (tx) =>
        tx.execute<{ k: string }>(sql`
          SELECT (COALESCE(SUM(e.debit_k), 0) - COALESCE(SUM(e.credit_k), 0))::bigint AS k
          FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
          WHERE e.business_id = ${businessId}::uuid AND a.system_role = ${role}
        `),
      );
      return Number([...rows][0]!.k);
    };

    /* 1 · GENERAL LEDGER: every kobo of debit met by a kobo of credit. */
    const totals = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ d: string; c: string }>(sql`
        SELECT COALESCE(SUM(debit_k), 0)::bigint AS d, COALESCE(SUM(credit_k), 0)::bigint AS c
        FROM ledger_entries WHERE business_id = ${businessId}::uuid
      `),
    );
    const gl = [...totals][0]!;
    expect(Number(gl.d)).toBeGreaterThan(0);
    expect(Number(gl.d)).toBe(Number(gl.c));

    /* 2 · TRIAL BALANCE: per-account nets sum to exactly zero. */
    const tb = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ code: string; net: string }>(sql`
        SELECT a.code, (COALESCE(SUM(e.debit_k), 0) - COALESCE(SUM(e.credit_k), 0))::bigint AS net
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid
        GROUP BY a.code
      `),
    );
    const tbRows = [...tb];
    expect(tbRows.length).toBeGreaterThan(10);
    expect(tbRows.reduce((n, r) => n + Number(r.net), 0)).toBe(0);

    /* 3 · PROFIT AND LOSS: what the month earned, minus what it cost.
     * Revenue: cash sale 150,000 + credit sale 250,000 + recognised order
     * 100,000 + FX 2,268,450 + VAT-sale net 40,000 + provider sale 80,000 +
     * reversed sale 15,000, LESS the credit note's 20,000. Expenses: rent
     * 40,000 + depreciation 10,000 + the provider's fee 1,200; COGS nets
     * to zero because the one costed sale came back RESALABLE.
     *
     * The FX line was 22,685 here and in step 8, which was the naira figure
     * in a kobo column: USD 15.00 at 1512.30 is ₦22,684.50, and this schema
     * counts kobo. Correcting the posting moves this total by the same
     * 2,245,765, and the balance-sheet identity below still holds because
     * the posting is a balanced pair. */
    const revenueK = net('income', 'credit');
    const expensesK = net('expense', 'debit');
    expect(revenueK).toBe(2_883_450);
    expect(expensesK).toBe(51_200);
    const profitK = revenueK - expensesK;

    /* 4 · BALANCE SHEET: assets equal liabilities plus equity plus the
     * profit the P&L just reported — the same rows, agreeing. */
    const assetsK = net('asset', 'debit');
    const liabilitiesK = net('liability', 'credit');
    const equityK = net('equity', 'credit');
    expect(assetsK).toBe(liabilitiesK + equityK + profitK);

    /* 5 · CASH FLOW: what moved through the money accounts THIS month is
     * exactly closing money less opening money — period arithmetic over
     * the same rows the statements read, no third figure invented. */
    const money = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ opening: string; closing: string }>(sql`
        SELECT
          COALESCE(SUM(CASE WHEN e.created_at <= (${openingDay} || 'T23:59:59+01:00')::timestamptz
                            THEN e.debit_k - e.credit_k END), 0)::bigint AS opening,
          COALESCE(SUM(e.debit_k - e.credit_k), 0)::bigint AS closing
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.code IN ('1000', '1010', '1020')
      `),
    );
    const flows = [...money][0]!;
    expect(Number(flows.opening)).toBe(1_500_000);
    /* cash 523,000 + bank 3,378,450 + paystack 73,800. The bank account is
     * where the corrected FX debit lands, so it carries the same 2,245,765
     * the P&L above does. */
    expect(Number(flows.closing)).toBe(3_975_250);
    const inMonthMovementK = Number(flows.closing) - Number(flows.opening);
    expect(inMonthMovementK).toBe(2_475_250);

    /* 6 · ACCOUNTS RECEIVABLE: the ledger's AR balance IS the sum of open
     * invoice balances PLUS the three receivables the payment hub raised
     * beside the documents — the refund (money returned for goods kept),
     * the chargeback (the provider took the money back), the reversal
     * (the transfer bounced). Each term named; nothing plugs. */
    const arLedgerK = await roleBalance('ACCOUNTS_RECEIVABLE');
    const arInvoices = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(balance_due_k), 0)::bigint AS k
        FROM invoices
        WHERE business_id = ${businessId}::uuid AND status IN ('issued', 'partially_paid')
      `),
    );
    const openInvoicesK = Number([...arInvoices][0]!.k);
    /* Chidi's opening 50,000 + Bola's credited sale at 130,000. */
    expect(openInvoicesK).toBe(180_000);
    const refundK = 5_000;
    const chargebackK = 10_000;
    const reversalK = 15_000;
    expect(arLedgerK).toBe(openInvoicesK + refundK + chargebackK + reversalK);
    expect(arLedgerK).toBe(210_000);

    /* 7 · ACCOUNTS PAYABLE: the ledger's AP balance IS the sum of open
     * bill balances — the payable side's own document (PR-077). */
    const apLedgerK = -(await roleBalance('ACCOUNTS_PAYABLE'));
    const apBills = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(balance_due_k), 0)::bigint AS k
        FROM bills WHERE business_id = ${businessId}::uuid AND status <> 'voided'
      `),
    );
    expect(apLedgerK).toBe(100_000);
    expect(apLedgerK).toBe(Number([...apBills][0]!.k));

    /* 8 · INVENTORY: the ledger's asset balance IS the shelf, counted and
     * costed — 25 wigs at ₦200, every movement carrying its cost. */
    const inventoryLedgerK = await roleBalance('INVENTORY_ASSET');
    const shelf = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(sub.on_hand * sub.unit_cost_k), 0)::bigint AS k
        FROM (
          SELECT p.unit_cost_k,
                 (SELECT COALESCE(SUM(m.delta), 0) FROM inventory_movements m
                  WHERE m.product_id = p.id) AS on_hand
          FROM products p WHERE p.business_id = ${businessId}::uuid
        ) sub
      `),
    );
    expect(inventoryLedgerK).toBe(500_000);
    expect(inventoryLedgerK).toBe(Number([...shelf][0]!.k));

    /* 9 · CUSTOMER STATEMENT (Bola): what she owes is her open invoice
     * balances; what the business owes HER back is her credit subledger
     * balance. Both from rows, both exact. */
    const bolaOwes = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(balance_due_k), 0)::bigint AS k
        FROM invoices
        WHERE business_id = ${businessId}::uuid AND customer_id = ${bola.id}::uuid
          AND status IN ('issued', 'partially_paid')
      `),
    );
    expect(Number([...bolaOwes][0]!.k)).toBe(130_000);
    const bolaCredit = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT (SELECT COALESCE(SUM(amount_minor), 0) FROM customer_credits
                WHERE business_id = ${businessId}::uuid AND customer_id = ${bola.id}::uuid)
             - (SELECT COALESCE(SUM(cca.amount_minor), 0) FROM customer_credit_applications cca
                JOIN customer_credits cc ON cc.id = cca.customer_credit_id
                WHERE cca.business_id = ${businessId}::uuid AND cc.customer_id = ${bola.id}::uuid)
             AS k
      `),
    );
    /* The 10,000 overpayment stands; the 20,000 note credit was applied. */
    expect(Number([...bolaCredit][0]!.k)).toBe(10_000);

    /* 10 · SUPPLIER STATEMENT: what is owed to the named supplier is
     * their open bill balances — and it is the whole of AP. */
    const supplierOwed = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(balance_due_k), 0)::bigint AS k
        FROM bills
        WHERE business_id = ${businessId}::uuid AND supplier_id = ${supplier.supplierId}::uuid
          AND status <> 'voided'
      `),
    );
    expect(Number([...supplierOwed][0]!.k)).toBe(100_000);
    expect(Number([...supplierOwed][0]!.k)).toBe(apLedgerK);

    /* 11 · RECONCILIATION: every imported statement line is explained —
     * by the rule or by a person with a reason — and nothing was decided
     * silently. */
    const rec2 = await withBusiness(db, businessId, (tx) =>
      bankRepo.reconcile(tx, { businessId, commit: false }),
    );
    expect(rec2).toMatchObject({ unmatchedLines: 0 });
    const matches = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT COUNT(*) AS n FROM bank_line_matches WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect(Number([...matches][0]!.n)).toBe(2);

    /* AND the §13 tax point stands beside the books, not inside them: one
     * event, basis 40,000, tax 3,000 — exactly the VAT the ledger owes. */
    const tax = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ basis: string; tax: string }>(sql`
        SELECT COALESCE(SUM(basis_minor), 0)::bigint AS basis,
               COALESCE(SUM(tax_minor), 0)::bigint AS tax
        FROM tax_events WHERE business_id = ${businessId}::uuid
      `),
    );
    expect([...tax][0]).toEqual({ basis: '40000', tax: '3000' });
    expect(-(await roleBalance('VAT_PAYABLE'))).toBe(3_000);

    /* AND every document projection agrees with its subledgers (PR-084):
     * a month this eventful leaves nothing to repair. */
    const rebuilt = await withBusiness(db, businessId, (tx) =>
      projectionsRepo.rebuildDocumentProjections(tx, businessId),
    );
    expect(rebuilt.invoicesRepaired).toEqual([]);
    expect(rebuilt.billsRepaired).toEqual([]);

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
