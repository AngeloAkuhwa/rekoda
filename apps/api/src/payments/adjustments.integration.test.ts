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
import {
  events,
  issueRepo,
  paymentsHub,
  projectionsRepo,
  settleRepo,
  sql,
  withBusiness,
} from '@rekoda/db';
import {
  AR,
  BANK_PAYSTACK,
  appDb,
  balanceByCode,
  balanceByRole,
  bookPayment,
  chargeSuccess,
  countRows,
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

/**
 * An unpaid invoice with a live intent, the normal way in.
 *
 * Kept identical in every adjustments*.integration.test.ts suite. It calls issueSale(), a
 * repository financial writer that scripts/check-boundaries.mjs allows only in the command
 * layer and in test files, so it cannot move to adjustments.fixtures.ts. Change them together.
 */
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

/* ── the successful path, unchanged (G-06 invariant 15) ─────────────────── */

describe('the successful payment path is untouched', () => {
  it('payment → verification → booking → allocation → receipt → ledger, exactly as before', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { eventId, paymentId } = await bookPayment(businessId, intent.reference);

    const invoice = await invoiceState(businessId, sale.invoiceId);
    expect(invoice?.status).toBe('paid');
    expect(invoice?.balanceDueK).toBe(0);
    expect(await countRows(businessId, 'receipts')).toBe(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 15_000_000 }]);
    // Sale posting (2 lines) + the payment posting (2 lines): clearing
    // holds the money, the receivable is answered.
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
    expect(totals.lines).toBe(4);
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      15_000_000,
    );
    expect(await balanceByCode(businessId, AR)).toBe(0);
    expect(await events.eventStatus(workerDb, eventId)).toMatchObject({
      processed: true,
      error: null,
      businessId,
    });
    // A second confirming event is still the replay it always was.
    const second = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();
    expect((await events.eventStatus(workerDb, second))?.error).toBe('already_booked');
    expect(await countRows(businessId, 'payments')).toBe(1);
    expect((await ledgerTotals(businessId)).lines).toBe(4);
  });
});

/* ── refunds ─────────────────────────────────────────────────────────────── */

describe('a provider refund of a booked payment (G-06)', () => {
  it('refund.processed BEFORE settlement: refund row, clearing credited, invoice reopened, one balanced posting', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyRefund('501', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 501 }));
    expect(await pump()).toBe(1);
    await drainJobs();

    const refunds = await refundsOf(businessId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      paymentId,
      amountK: 15_000_000,
      method: 'provider',
      providerRefundId: '501',
    });

    const invoice = await invoiceState(businessId, sale.invoiceId);
    expect(invoice?.status).toBe('issued');
    expect(invoice?.balanceDueK).toBe(15_000_000);
    expect(await standing(businessId, paymentId)).toEqual([]);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');

    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
    expect(totals.lines).toBe(linesBefore + 2);
    expect(await balanceByCode(businessId, AR)).toBe(15_000_000);
    // The money never left the provider, so clearing gives it back — the
    // bank, which never received it, is untouched.
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(0);
    expect(await balanceByCode(businessId, BANK_PAYSTACK)).toBe(0);

    expect(await events.eventStatus(workerDb, eventId)).toMatchObject({
      processed: true,
      error: null,
    });
    // The receipt and the original booking are history, untouched.
    expect(await countRows(businessId, 'receipts')).toBe(1);
    expect(await countRows(businessId, 'payments')).toBe(1);
  });

  it('refund.processed AFTER settlement: the bank gives it back, settlement evidence stands', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    await settle(businessId, connectionId, paymentId, 15_000_000);
    const settlementItemsBefore = await countRows(businessId, 'settlement_items');
    const clearingBefore = await balanceByRole(
      businessId,
      'PAYMENT_PROVIDER_CLEARING',
      connectionId,
    );

    provider.willVerifyRefund('502', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 502 }));
    await pump();
    await drainJobs();

    const [refund] = await refundsOf(businessId);
    expect(refund).toMatchObject({ method: 'bank', amountK: 15_000_000 });
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
    // Clearing is exactly where the settlement left it; the bank is what moved
    // (the settle() helper records the payout without posting it, so the bank
    // starts at zero and the refund's credit is the only movement).
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      clearingBefore,
    );
    expect(await balanceByCode(businessId, BANK_PAYSTACK)).toBe(-15_000_000);
    expect(await countRows(businessId, 'settlement_items')).toBe(settlementItemsBefore);
    expect(await countRows(businessId, 'settlements', "status = 'SETTLED'")).toBe(1);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a PARTIAL refund unwinds only the refunded amount and re-allocates the rest', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('503', {
      amountK: 4_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 4_000_000, { id: 503 }));
    await pump();
    await drainJobs();

    const invoice = await invoiceState(businessId, sale.invoiceId);
    expect(invoice?.status).toBe('partially_paid');
    expect(invoice?.balanceDueK).toBe(4_000_000);
    // The original allocation is reversed in full and the customer's
    // remaining ₦110,000 answers the invoice through a fresh row (§14.2).
    const rows = await standing(businessId, paymentId);
    expect(rows.map((r) => r.amountK)).toEqual([11_000_000]);
    expect(await countRows(businessId, 'payment_allocations', 'reversal_of_id IS NOT NULL')).toBe(
      1,
    );
    expect(await countRows(businessId, 'payment_allocations', 'amount_k < 0')).toBe(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('partially_refunded');
    expect(await balanceByCode(businessId, AR)).toBe(4_000_000);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a payment allocated across TWO invoices unwinds newest first, never negative, never over-unpaid', async () => {
    const { businessId } = await seedBusiness();
    const a = await seedObligation(businessId, 15_000_000);
    const b = await seedObligation(businessId, 6_000_000);
    const { paymentId } = await bookPayment(businessId, a.intent.reference);

    /* A human re-matches the ₦150,000: ₦90,000 stays on A, ₦60,000 answers B
     * (the §14.2 path — full reversal, fresh allocations). */
    await withBusiness(appDb, businessId, async (tx) => {
      const [original] = await settleRepo.standingAllocationsFor(tx, businessId, paymentId);
      const reversed = await settleRepo.reverseAllocation(tx, {
        businessId,
        allocationId: original!.id,
        reason: 'rematch',
        sourceType: 'test',
        sourceId: 'rematch-1',
      });
      expect(reversed.outcome).toBe('reversed');
      await settleRepo.allocatePayment(tx, {
        businessId,
        paymentId,
        invoiceId: a.sale.invoiceId,
        amountK: 9_000_000,
        reason: 'rematch',
        sourceType: 'test',
        sourceId: 'rematch-1',
      });
      await settleRepo.allocatePayment(tx, {
        businessId,
        paymentId,
        invoiceId: b.sale.invoiceId,
        amountK: 6_000_000,
        reason: 'rematch',
        sourceType: 'test',
        sourceId: 'rematch-1',
      });
      await projectionsRepo.rebuildInvoiceProjection(tx, businessId, a.sale.invoiceId);
      await projectionsRepo.rebuildInvoiceProjection(tx, businessId, b.sale.invoiceId);
    });
    expect((await invoiceState(businessId, a.sale.invoiceId))?.balanceDueK).toBe(6_000_000);
    expect((await invoiceState(businessId, b.sale.invoiceId))?.balanceDueK).toBe(0);

    /* The provider refunds ₦100,000: B (newest, ₦60,000) is unwound whole,
     * then ₦40,000 of A — A keeps ₦50,000. */
    provider.willVerifyRefund('504', {
      amountK: 10_000_000,
      transactionReference: a.intent.reference,
    });
    await storeEvent(refundEvent(a.intent.reference, 10_000_000, { id: 504 }));
    await pump();
    await drainJobs();

    expect(await invoiceState(businessId, b.sale.invoiceId)).toMatchObject({
      status: 'issued',
      balanceDueK: 6_000_000,
    });
    expect(await invoiceState(businessId, a.sale.invoiceId)).toMatchObject({
      status: 'partially_paid',
      balanceDueK: 10_000_000,
    });
    const rows = await standing(businessId, paymentId);
    expect(rows.map((r) => ({ invoiceId: r.invoiceId, amountK: r.amountK }))).toEqual([
      { invoiceId: a.sale.invoiceId, amountK: 5_000_000 },
    ]);
    // Every reversal negates its original exactly; nothing else is negative.
    const negatives = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ bad: number }>(sql`
        SELECT count(*)::int AS bad FROM payment_allocations r
        WHERE r.business_id = ${businessId}::uuid AND r.amount_k < 0
          AND (r.reversal_of_id IS NULL OR r.amount_k <> -(SELECT o.amount_k FROM payment_allocations o WHERE o.id = r.reversal_of_id))
      `),
    );
    expect(Number([...negatives][0]!.bad)).toBe(0);
    // The customer's outstanding, from authoritative rows: A ₦100,000 + B ₦60,000.
    expect(await balanceByCode(businessId, AR)).toBe(16_000_000);
  });

  it('a DUPLICATE refund notification records nothing twice', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    provider.willVerifyRefund('505', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });

    const first = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 505 }));
    // Layer 1: the same delivery again is one row (ingress fingerprint).
    const again = await events.recordEvent(appDb, {
      provider: 'paystack',
      eventType: 'refund.processed',
      externalId: '505:refund.processed',
      payload: {},
      businessId: null,
    });
    expect(again.isNew).toBe(false);
    // Layer 2: a re-notification that somehow carries a fresh fingerprint
    // still meets the refund's provider id and changes nothing.
    const redelivered = await storeEvent(
      refundEvent(intent.reference, 15_000_000, { id: 505 }),
      '505:refund.processed:redelivery',
    );
    await pump();
    await drainJobs();

    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await countRows(businessId, 'ledger_transactions', "source_type = 'refund'")).toBe(1);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(15_000_000);
    expect(await countRows(businessId, 'payment_allocations')).toBe(2); // original + one reversal
    expect((await events.eventStatus(workerDb, first))?.error).toBeNull();
    expect((await events.eventStatus(workerDb, redelivered))?.error).toBe(
      'refund_already_recorded',
    );
  });

  it('refund.pending and refund.failed move no money', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);

    const pending = await storeEvent(
      refundEvent(intent.reference, 15_000_000, {
        id: 506,
        event: 'refund.pending',
        status: 'pending',
      }),
    );
    const failed = await storeEvent(
      refundEvent(intent.reference, 15_000_000, {
        id: 507,
        event: 'refund.failed',
        status: 'failed',
      }),
    );
    await pump();
    await drainJobs();

    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect((await events.eventStatus(workerDb, pending))?.error).toBe('refund_pending');
    expect((await events.eventStatus(workerDb, failed))?.error).toBe('refund_failed');
  });

  it('an UNMATCHED refund is filed for a human, never absorbed', async () => {
    const { businessId } = await seedBusiness();
    // A Rekoda-shaped reference nobody minted.
    const stray = paymentReference(new Date(), (n) => randomBytes(n));
    const unknown = await storeEvent(refundEvent(stray, 5_000_000, { id: 508 }));
    // An intent that exists but was never paid.
    const { intent } = await seedObligation(businessId);
    const unbooked = await storeEvent(refundEvent(intent.reference, 5_000_000, { id: 509 }));
    // A refund the provider cannot find when asked.
    const { intent: paid } = await seedObligation(businessId);
    await bookPayment(businessId, paid.reference);
    const unverifiable = await storeEvent(refundEvent(paid.reference, 5_000_000, { id: 510 }));

    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, unknown))?.error).toBe('unknown_reference');
    expect((await events.eventStatus(workerDb, unbooked))?.error).toBe(
      'refund_without_booked_payment',
    );
    /* The provider cannot find the refund yet: the attempt fails and is
     * retried (the redelivery would be dropped at ingress), and on the last
     * attempt the disagreement becomes an exception, never a dead job. */
    expect((await events.eventStatus(workerDb, unverifiable))?.processed).toBe(false);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      await drainJobs();
    }
    expect((await events.eventStatus(workerDb, unverifiable))?.error).toBe(
      'refund_verify_not_found',
    );
    expect(await refundsOf(businessId)).toHaveLength(0);
    const reasons = (await reconciliationsOf(businessId))
      .filter((r) => r.status === 'EXCEPTION')
      .map((r) => r.reason)
      .sort();
    expect(reasons).toEqual(['refund_verify_not_found', 'refund_without_booked_payment']);
  });

  it('a provider truth that does not describe this payment is a question, not a posting', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('511', {
      amountK: 15_000_000,
      transactionReference: 'RKD-PAY-OTHER',
    });
    const wrongRef = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 511 }));
    provider.willVerifyRefund('512', {
      amountK: 20_000_000,
      transactionReference: intent.reference,
    });
    const tooMuch = await storeEvent(refundEvent(intent.reference, 20_000_000, { id: 512 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, wrongRef))?.error).toBe('refund_reference_mismatch');
    expect((await events.eventStatus(workerDb, tooMuch))?.error).toBe('refund_amount_mismatch');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
  });

  it('a refund that reaches into an OVERPAYMENT credit is refused to a human: the payment was overpaid, so the whole adjustment is OD-8', async () => {
    const { businessId } = await seedBusiness();
    // ₦100,000 owed, ₦150,000 paid: ₦50,000 sits in customer credit.
    const { sale, intent } = await seedObligation(businessId, 10_000_000, 15_000_000);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');

    provider.willVerifyRefund('513', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 513 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('refund_overpaid_payment');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 10_000_000 }]);
    expect(
      (await reconciliationsOf(businessId)).some((r) => r.reason === 'refund_overpaid_payment'),
    ).toBe(true);
  });

  it('an event attributed to the WRONG tenant touches nothing', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const { intent } = await seedObligation(a.businessId);
    await bookPayment(a.businessId, intent.reference);
    provider.willVerifyRefund('514', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });

    // Attribution lands on B (a stray id, a bug, an operator's slip): the
    // tenant-scoped read in B's job finds no such intent and stops.
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 514 }));
    expect(await events.attributeEvent(workerDb, eventId, b.businessId)).toBe(true);
    await pump(); // the stranded lane enqueues it under B
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('intent_missing_for_tenant');
    expect(await refundsOf(a.businessId)).toHaveLength(0);
    expect(await refundsOf(b.businessId)).toHaveLength(0);
    expect(await countRows(b.businessId, 'ledger_entries')).toBe(0);
  });
});

describe('a second partial refund', () => {
  it('unwinds the retained row, empties the payment and stamps it refunded, with every reversal negating its original', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('680', {
      amountK: 4_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 4_000_000, { id: 680 }));
    await pump();
    await drainJobs();
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 11_000_000 }]);
    expect(await paymentStatus(businessId, paymentId)).toBe('partially_refunded');

    provider.willVerifyRefund('681', {
      amountK: 11_000_000,
      transactionReference: intent.reference,
    });
    const second = await storeEvent(refundEvent(intent.reference, 11_000_000, { id: 681 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, second))?.error).toBeNull();
    expect(await refundsOf(businessId)).toHaveLength(2);
    expect(await standing(businessId, paymentId)).toEqual([]);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');
    expect(await invoiceState(businessId, sale.invoiceId)).toMatchObject({
      status: 'issued',
      balanceDueK: 15_000_000,
    });
    expect(await balanceByCode(businessId, AR)).toBe(15_000_000);
    // original, its reversal, retained ₦110,000, its reversal: four rows, two negative.
    expect(await countRows(businessId, 'payment_allocations')).toBe(4);
    expect(await countRows(businessId, 'payment_allocations', 'amount_k < 0')).toBe(2);
    const negatives = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ bad: number }>(sql`
        SELECT count(*)::int AS bad FROM payment_allocations r
        WHERE r.business_id = ${businessId}::uuid AND r.amount_k < 0
          AND (r.reversal_of_id IS NULL OR r.amount_k <> -(SELECT o.amount_k FROM payment_allocations o WHERE o.id = r.reversal_of_id))
      `),
    );
    expect(Number([...negatives][0]!.bad)).toBe(0);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });
});
