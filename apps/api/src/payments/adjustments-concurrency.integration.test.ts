/**
 * Refunds, reversals and chargebacks arriving from the provider (spec §6.1,
 * §14.2–§14.3, §21; launch gap G-06), against real PostgreSQL: stored
 * event → attribution pump → processing job → books.
 *
 * The defect these pin: a `refund.processed`, a provider-side reversal or a
 * dispute used to be routed by REFERENCE alone and then judged as if it were
 * a fresh confirmation of the original charge, so every one of them ended as
 * `already_booked` (or, for Paystack's real refund envelope, whose charge
 * rides in `transaction_reference`, as `no_payment_reference`) and the books
 * kept saying the customer had paid. The repos that record and post these
 * facts existed (0091, 0092) and were reachable from no event.
 *
 * Same harness as pipeline.integration.test.ts, plus a payment CONNECTION on
 * every merchant — production always has one (an intent cannot be minted
 * without it), and the clearing account it provisions is where a
 * pre-settlement refund or reversal is credited.
 */
// Provider refunds, reversals and chargebacks (G-06). Split by concern across adjustments*.integration.test.ts; the shared setup is in
// adjustments.fixtures.ts.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { paymentReference } from '@rekoda/core';
import { events, issueRepo, paymentsHub, sql, withBusiness } from '@rekoda/db';
import {
  chargebackPaymentWork,
  refundPaymentWork,
} from '../commands/payment-adjustment-commands.js';
import { sweepSettlements } from './settlement-sweep.js';
import {
  AR,
  BANK_PAYSTACK,
  appDb,
  balanceByCode,
  balanceByRole,
  bookPayment,
  chargebacksOf,
  countRows,
  disputeEvent,
  drainJobs,
  invoiceState,
  ledgerTotals,
  paymentStatus,
  provider,
  pump,
  reconciliationsOf,
  refundEvent,
  refundsOf,
  seedBusiness,
  settle,
  standing,
  storeEvent,
  workerDb,
  useAdjustmentsHarness,
} from './adjustments.fixtures.js';

/** An unpaid invoice with a live intent, the normal way in. */
async function seedObligation(businessId: string, totalK = 15_000_000, expectedK = totalK) {
  return withBusiness(appDb, businessId, async (tx) => {
    const sale = await issueRepo.issueSale(tx, {
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
      sourceId: `draft-${randomBytes(3).toString('hex')}`,
      actor: 'system',
    });
    const intent = await paymentsHub.createIntent(tx, {
      businessId,
      reference: paymentReference(new Date(), (n) => randomBytes(n)),
      expectedAmountK: expectedK,
      providerType: 'paystack',
      invoiceId: sale.invoiceId,
    });
    return { sale, intent };
  });
}

useAdjustmentsHarness();

/* ── the third independent review of 11 Sep 2026 ─────────────────────────── */

describe('an OVERPAID payment is adjusted whole or not at all (OD-8)', () => {
  it('a refund of ANY part of it is refused: the invoice stays paid, the credit stands, nothing posts', async () => {
    const { businessId } = await seedBusiness();
    // ₦100,000 owed, ₦150,000 paid: ₦50,000 sits in customer credit.
    const { sale, intent } = await seedObligation(businessId, 10_000_000, 15_000_000);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const linesBefore = (await ledgerTotals(businessId)).lines;

    /* The excess itself (the likeliest refund), then the invoice half:
     * each fits inside the standing allocation and each is refused. */
    provider.willVerifyRefund('530', {
      amountK: 5_000_000,
      transactionReference: intent.reference,
    });
    const excess = await storeEvent(refundEvent(intent.reference, 5_000_000, { id: 530 }));
    provider.willVerifyRefund('531', {
      amountK: 10_000_000,
      transactionReference: intent.reference,
    });
    const half = await storeEvent(refundEvent(intent.reference, 10_000_000, { id: 531 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, excess))?.error).toBe('refund_overpaid_payment');
    expect((await events.eventStatus(workerDb, half))?.error).toBe('refund_overpaid_payment');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await invoiceState(businessId, sale.invoiceId)).toMatchObject({
      status: 'paid',
      balanceDueK: 0,
    });
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 10_000_000 }]);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    const reasons = (await reconciliationsOf(businessId))
      .filter((r) => r.status === 'EXCEPTION')
      .map((r) => r.reason)
      .sort();
    expect(reasons).toEqual(['overpaid', 'refund_overpaid_payment', 'refund_overpaid_payment']);
  });

  it('a LOST dispute on it is refused: no chargeback row, no posting, the invoice stays paid', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId, 10_000_000, 15_000_000);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyDispute('620', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 620,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe(
      'chargeback_overpaid_payment',
    );
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 10_000_000 }]);
    expect(
      (await reconciliationsOf(businessId)).some((r) => r.reason === 'chargeback_overpaid_payment'),
    ).toBe(true);
  });
});

describe('one movement of money, two provider facts (OD-11)', () => {
  it("a PARTIAL dispute lost, then a refund for the same money: the refund is a human's, the receivable moves once", async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyDispute('630', {
      amountK: 6_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 6_000_000, {
        id: 630,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();
    expect((await events.eventStatus(workerDb, resolved))?.error).toBeNull();
    expect(await chargebacksOf(businessId)).toHaveLength(1);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(6_000_000);
    const linesAfterChargeback = (await ledgerTotals(businessId)).lines;

    /* Paystack's own refund for the accepted part arrives as a refund object. */
    provider.willVerifyRefund('631', {
      amountK: 6_000_000,
      transactionReference: intent.reference,
    });
    const refund = await storeEvent(refundEvent(intent.reference, 6_000_000, { id: 631 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, refund))?.error).toBe(
      'refund_payment_under_chargeback',
    );
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesAfterChargeback);
    expect(await balanceByCode(businessId, AR)).toBe(6_000_000);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(6_000_000);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 9_000_000 }]);
    expect(
      (await reconciliationsOf(businessId)).some(
        (r) => r.reason === 'refund_payment_under_chargeback',
      ),
    ).toBe(true);
  });

  it("a PARTIAL refund, then a dispute lost on the same payment: the chargeback is a human's", async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('632', {
      amountK: 4_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 4_000_000, { id: 632 }));
    await pump();
    await drainJobs();
    expect(await refundsOf(businessId)).toHaveLength(1);
    const linesAfterRefund = (await ledgerTotals(businessId)).lines;

    provider.willVerifyDispute('633', {
      amountK: 5_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 5_000_000, {
        id: 633,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe(
      'chargeback_payment_already_refunded',
    );
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesAfterRefund);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(4_000_000);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 11_000_000 }]);
  });

  it('a resolution word Rekoda does not know is its own exception, never hidden behind an open dispute', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);

    provider.willVerifyDispute('640', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(disputeEvent(intent.reference, 15_000_000, { id: 640 }));
    await pump();
    await drainJobs();

    provider.willVerifyDispute('640', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'pending-review',
      outcome: 'open',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 640,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'pending-review',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe(
      'dispute_resolution_unrecognised',
    );
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    const reasons = (await reconciliationsOf(businessId))
      .filter((r) => r.status === 'EXCEPTION')
      .map((r) => r.reason)
      .sort();
    expect(reasons).toEqual(['dispute_opened', 'dispute_resolution_unrecognised']);
  });
});

/* ── the seventh independent review of 11 Sep 2026 ───────────────────────── */

describe('two lanes, one payment: adjustments serialise on the payment row', () => {
  const refundInput = (businessId: string, paymentId: string, connectionId: string) => ({
    businessId,
    paymentId,
    paymentAmountK: 15_000_000,
    amountK: 6_000_000,
    providerRefundId: 'race-rf-1',
    paymentConnectionId: connectionId,
    reason: 'provider refund race-rf-1',
    actor: 'system',
    eventId: 'race-refund-event',
  });
  const chargebackInput = (businessId: string, paymentId: string, connectionId: string) => ({
    businessId,
    paymentId,
    paymentAmountK: 15_000_000,
    paymentConnectionId: connectionId,
    providerChargebackId: 'race-cb-1',
    amountK: 6_000_000,
    reason: 'dispute race-cb-1 merchant-accepted',
    actor: 'system',
    eventId: 'race-dispute-event',
  });

  /**
   * Lane A does its work and then HOLDS its transaction open; lane B starts
   * while A is uncommitted. Without the row lock B's guard reads see no
   * chargeback and a full standing allocation, and B's unwind then collides
   * with A's uncommitted reversal (a unique-index wait that ends in an
   * error, or, with a different interleaving, a second posting). With the
   * lock B waits on the payment row, then reads A's commit and refuses.
   */
  async function race<A, B>(
    businessId: string,
    laneA: (tx: Parameters<Parameters<typeof withBusiness>[2]>[0]) => Promise<A>,
    laneB: (tx: Parameters<Parameters<typeof withBusiness>[2]>[0]) => Promise<B>,
  ): Promise<{ a: A; b: B }> {
    let aDone!: () => void;
    const aHasWritten = new Promise<void>((resolve) => (aDone = resolve));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const a = withBusiness(appDb, businessId, async (tx) => {
      const result = await laneA(tx);
      aDone();
      await hold;
      return result;
    });
    await aHasWritten;
    const b = withBusiness(appDb, businessId, (tx) => laneB(tx));
    // B is now blocked on the payment row (or, without the lock, racing).
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    return { a: ra, b: rb };
  }

  it('a chargeback then a concurrent refund: the refund waits, sees the chargeback, and refuses', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    const { a, b } = await race(
      businessId,
      (tx) => chargebackPaymentWork(tx, chargebackInput(businessId, paymentId, connectionId)),
      (tx) => refundPaymentWork(tx, refundInput(businessId, paymentId, connectionId)),
    );
    expect(a.outcome).toBe('charged_back');
    expect(b.outcome).toBe('payment_under_chargeback');

    expect(await chargebacksOf(businessId)).toHaveLength(1);
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect(await balanceByCode(businessId, AR)).toBe(6_000_000);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(6_000_000);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 9_000_000 }]);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a refund then a concurrent chargeback: the chargeback waits, sees the refund, and refuses', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    const { a, b } = await race(
      businessId,
      (tx) => refundPaymentWork(tx, refundInput(businessId, paymentId, connectionId)),
      (tx) => chargebackPaymentWork(tx, chargebackInput(businessId, paymentId, connectionId)),
    );
    expect(a.outcome).toBe('refunded');
    expect(b.outcome).toBe('payment_already_refunded');

    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect(await balanceByCode(businessId, AR)).toBe(6_000_000);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(6_000_000);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 9_000_000 }]);
  });

  it('two concurrent partial refunds whose sum exceeds the payment: one posts, the other is refused, never an error', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    const { a, b } = await race(
      businessId,
      (tx) =>
        refundPaymentWork(tx, {
          ...refundInput(businessId, paymentId, connectionId),
          amountK: 10_000_000,
          providerRefundId: 'race-rf-2',
        }),
      (tx) =>
        refundPaymentWork(tx, {
          ...refundInput(businessId, paymentId, connectionId),
          amountK: 10_000_000,
          providerRefundId: 'race-rf-3',
        }),
    );
    expect(a.outcome).toBe('refunded');
    expect(b.outcome).toBe('exceeds_allocations');
    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 5_000_000 }]);
  });
});

/* ── the eighth independent review of 11 Sep 2026 ────────────────────────── */

describe('where a refund leaves from is decided inside the payment lock', () => {
  it('a payment settled before the refund is refunded from the BANK, whatever an earlier read believed', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const clearingBefore = await balanceByRole(
      businessId,
      'PAYMENT_PROVIDER_CLEARING',
      connectionId,
    );

    /* The settlement lands after the handler would have looked but before
     * the command runs: the command must see it. */
    await settle(businessId, connectionId, paymentId, 15_000_000);
    const result = await withBusiness(appDb, businessId, (tx) =>
      refundPaymentWork(tx, {
        businessId,
        paymentId,
        paymentAmountK: 15_000_000,
        amountK: 15_000_000,
        providerRefundId: 'settled-rf-1',
        paymentConnectionId: connectionId,
        reason: 'provider refund settled-rf-1',
        actor: 'system',
        eventId: 'settled-refund-event',
      }),
    );
    expect(result.outcome).toBe('refunded');
    const [refund] = await refundsOf(businessId);
    expect(refund).toMatchObject({ method: 'bank', amountK: 15_000_000 });
    /* The refund left from the bank, so clearing is exactly what it was
     * (the settlement helper records the payout; its own posting is the
     * settlement poster's job and is not part of this case). */
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      clearingBefore,
    );
    expect(await balanceByCode(businessId, BANK_PAYSTACK)).toBe(-15_000_000);
    expect(await balanceByCode(businessId, AR)).toBe(15_000_000);
  });
});

/* ── the ninth independent review of 11 Sep 2026 ─────────────────────────── */

describe('a payout that covers a payment adjusted BEFORE it is not posted from derived totals (OD-10)', () => {
  it('after a pre-settlement provider refund, a totals-only payout is an exception, never a fee posting', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('700', {
      amountK: 5_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 5_000_000, { id: 700 }));
    await pump();
    await drainJobs();
    expect(await paymentStatus(businessId, paymentId)).toBe('partially_refunded');
    const clearingAfterRefund = await balanceByRole(
      businessId,
      'PAYMENT_PROVIDER_CLEARING',
      connectionId,
    );
    expect(clearingAfterRefund).toBe(10_000_000);
    const linesAfterRefund = (await ledgerTotals(businessId)).lines;

    /* The provider reports the payout at the charge's full gross with the
     * refund netted out of the total: derived as one fee, the refund would
     * be booked as processing fees and clearing credited for it twice. */
    provider.willSettle({
      references: [intent.reference],
      grossK: 15_000_000,
      netK: 15_000_000 - 223_750 - 5_000_000,
    });
    await sweepSettlements({ workerDb, appDb, provider });

    expect(await countRows(businessId, 'settlements')).toBe(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesAfterRefund);
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      clearingAfterRefund,
    );
    expect(await balanceByCode(businessId, '6050')).toBe(0);
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION' && r.reason === 'settlement_components_unknown',
    );
    expect(exceptions).toHaveLength(1);

    // Re-polling the same batch adds nothing and posts nothing.
    await sweepSettlements({ workerDb, appDb, provider });
    expect(await countRows(businessId, 'settlements')).toBe(0);
    expect(
      (await reconciliationsOf(businessId)).filter(
        (r) => r.reason === 'settlement_components_unknown',
      ),
    ).toHaveLength(1);

    /* The payment is HELD, not settled: the money is still in clearing on
     * the books, so the next adjustment keeps going through clearing. */
    const stamp = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ settlement_status: string | null }>(
        sql`SELECT settlement_status FROM payments WHERE id = ${paymentId}::uuid`,
      ),
    );
    expect([...stamp][0]?.settlement_status).toBe('held');
    provider.willVerifyRefund('701', {
      amountK: 4_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 4_000_000, { id: 701 }));
    await pump();
    await drainJobs();
    const refunds = await refundsOf(businessId);
    expect(refunds.map((r) => [r.providerRefundId, r.method])).toEqual([
      ['700', 'provider'],
      ['701', 'provider'],
    ]);
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      6_000_000,
    );
    expect(await balanceByCode(businessId, BANK_PAYSTACK)).toBe(0);
  });
});
