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
import { paymentReference, subscriptionReference } from '@rekoda/core';
import {
  events,
  issueRepo,
  jobsRepo,
  paymentsHub,
  settleRepo,
  sql,
  subscriptionsRepo,
  withBusiness,
} from '@rekoda/db';
import {
  AR,
  appDb,
  auditRows,
  balanceByCode,
  balanceByRole,
  bookPayment,
  chargeSuccess,
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
  reversalsOf,
  seedBusiness,
  settle,
  standing,
  storeEvent,
  workerDb,
  useAdjustmentsHarness,
} from './adjustments.fixtures.js';
import { settlementDb } from '@rekoda/db/testing';

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

/* ── reversals ───────────────────────────────────────────────────────────── */

/* SYNTHETIC INGRESS. These cases store a fresh `charge.success` with a NEW
 * object id so the re-verify runs and reports `reversed`. A real redelivery
 * of the original charge event carries the same id and is dropped at ingress
 * as a duplicate, and Paystack publishes no charge-reversal webhook for an
 * inbound charge: whether anything triggers this branch in production is
 * OD-10(a), confirmed only by the G-05 drill. These cases prove the branch's
 * accounting, not its reachability. */
describe('a provider-side reversal of a booked payment (§14.3 PaymentReversal)', () => {
  it('BEFORE settlement: reversed whole, back through clearing, invoice reopened', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    // The provider now reports the charge reversed; the redelivered
    // (or fresh) charge event is what carries the news.
    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      succeeded: false,
      providerStatus: 'reversed',
      providerTransactionId: 'pst-rev-1',
    });
    const eventId = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect(await reversalsOf(businessId)).toMatchObject([
      { paymentId, amountK: 15_000_000, providerReversalId: 'pst-rev-1' },
    ]);
    expect(await invoiceState(businessId, sale.invoiceId)).toMatchObject({
      status: 'issued',
      balanceDueK: 15_000_000,
    });
    expect(await standing(businessId, paymentId)).toEqual([]);
    expect(await paymentStatus(businessId, paymentId)).toBe('reversed');
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(0);
    expect(await balanceByCode(businessId, AR)).toBe(15_000_000);
    expect(await countRows(businessId, 'ledger_transactions', "posting_purpose = 'REVERSAL'")).toBe(
      1,
    );
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
    expect((await events.eventStatus(workerDb, eventId))?.error).toBeNull();
    // The intent stays succeeded: the payment happened, then was undone.
    const after = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.intentByReference(tx, businessId, intent.reference),
    );
    expect(after?.status).toBe('succeeded');
  });

  it('AFTER settlement: not a reversal any more — filed for a human, settlement evidence untouched', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    await settle(businessId, connectionId, paymentId, 15_000_000);

    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      succeeded: false,
      providerStatus: 'reversed',
    });
    const eventId = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('reversal_after_settlement');
    expect(await reversalsOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect(await countRows(businessId, 'settlements', "status = 'SETTLED'")).toBe(1);
    expect(
      (await reconciliationsOf(businessId)).some((r) => r.reason === 'reversal_after_settlement'),
    ).toBe(true);
  });

  it('a DUPLICATE reversal notification reverses once', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      succeeded: false,
      providerStatus: 'reversed',
    });
    await storeEvent(chargeSuccess(intent.reference));
    const again = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect(await reversalsOf(businessId)).toHaveLength(1);
    expect(await countRows(businessId, 'ledger_transactions', "posting_purpose = 'REVERSAL'")).toBe(
      1,
    );
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(15_000_000);
    expect((await events.eventStatus(workerDb, again))?.error).toBe('reversal_already_recorded');
  });
});

/* ── the two payment domains cannot cross (G-06 invariant 10) ───────────── */

describe("Rekoda's own revenue and a merchant's customer money never meet", () => {
  it('a refund of a SUBSCRIPTION charge is flagged for an operator and never enters the merchant ledger', async () => {
    const { businessId } = await seedBusiness();
    const reference = subscriptionReference(new Date(), (n) => randomBytes(n));
    await withBusiness(settlementDb(), businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'renewal',
        amountK: 990_000,
        reference,
        plan: 'chat',
      }),
    );
    const ledgerBefore = await countRows(businessId, 'ledger_entries');
    provider.willVerifyRefund('701', { amountK: 990_000, transactionReference: reference });
    const eventId = await storeEvent(refundEvent(reference, 990_000, { id: 701 }));
    expect(await pump()).toBe(1);
    await drainJobs();

    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.map((j) => j.kind)).toEqual(['billing.process']);
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('billing_refund_event');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect(await countRows(businessId, 'ledger_entries')).toBe(ledgerBefore);
    const charge = await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.chargeByReference(tx, businessId, reference),
    );
    expect(charge?.status).toBe('pending');
  });

  it("a refund of a CUSTOMER payment never enters Rekoda's billing", async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    provider.willVerifyRefund('702', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 702 }));
    await pump();
    await drainJobs();

    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.map((j) => j.kind)).not.toContain('billing.process');
    expect(await countRows(businessId, 'subscription_charges')).toBe(0);
    expect(await refundsOf(businessId)).toHaveLength(1);
  });
});

/* ── auditability (G-06 invariant 14) ───────────────────────────────────── */

describe('every provider event that moved money back can be explained afterwards', () => {
  it('keeps the event, links the refund to it, and never rewrites the original booking', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { eventId: bookingEvent, paymentId } = await bookPayment(businessId, intent.reference);
    provider.willVerifyRefund('801', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      refundedAtIso: '2026-09-11T10:00:00.000Z',
    });
    const refundEventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 801 }));
    await pump();
    await drainJobs();

    /* The provider event row: provider, type, id, ingestion, processing. */
    const row = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{
        provider: string;
        event_type: string;
        external_id: string;
        created_at: Date;
        processed_at: Date | null;
        error: string | null;
      }>(sql`
        SELECT provider, event_type, external_id, created_at, processed_at, error
        FROM external_events WHERE id = ${refundEventId}::uuid
      `),
    );
    expect([...row][0]).toMatchObject({
      provider: 'paystack',
      event_type: 'refund.processed',
      external_id: '801:refund.processed',
      error: null,
    });
    expect([...row][0]?.processed_at).not.toBeNull();

    /* The refund names the provider's id; the audit row links payment,
     * event and refund with the amount and what moved. */
    const [refund] = await refundsOf(businessId);
    expect(refund?.providerRefundId).toBe('801');
    const audit = await auditRows(businessId, 'refunded');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entity_id).toBe(paymentId);
    expect(audit[0]?.new_value).toMatchObject({
      eventId: refundEventId,
      refundId: refund?.id,
      providerRefundId: '801',
      amountK: 15_000_000,
      lifecycle: 'refunded',
    });

    /* The original booking's own trail is intact. */
    expect(await auditRows(businessId, 'confirmed')).toHaveLength(1);
    expect((await events.eventStatus(workerDb, bookingEvent))?.error).toBeNull();
    const original = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ amount_k: number; initial_confirmation_source: string; verified: number }>(sql`
        SELECT amount_k::int AS amount_k, initial_confirmation_source, verified FROM payments WHERE id = ${paymentId}::uuid
      `),
    );
    expect([...original][0]).toMatchObject({
      amount_k: 15_000_000,
      initial_confirmation_source: 'PROVIDER_VERIFIED',
      verified: 1,
    });
    expect(
      await countRows(
        businessId,
        'ledger_transactions',
        "posting_purpose = 'PAYMENT_CONFIRMATION'",
      ),
    ).toBe(1);
  });
});

describe('a chargeback with nowhere to post leaves no chargeback row', () => {
  it('a LOST post-settlement dispute with no PROVIDER_CHARGEBACK_PAYABLE account is flagged, and nothing is written', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    await settle(businessId, connectionId, paymentId, 15_000_000);
    const linesBefore = (await ledgerTotals(businessId)).lines;
    const standingBefore = await standing(businessId, paymentId);

    /* The account the posting needs is unavailable (deactivated with no
     * replacement: a provisioning gap, not a merchant act). `accountByRole`
     * answers only active accounts; the role itself is immutable (0061). */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`
        UPDATE accounts SET active = false, deactivated_at = now()
         WHERE business_id = ${businessId}::uuid AND system_role = 'PROVIDER_CHARGEBACK_PAYABLE'
      `),
    );

    provider.willVerifyDispute('613', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 613,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe(
      'chargeback_no_clearing_account',
    );
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await standing(businessId, paymentId)).toEqual(standingBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['chargeback_no_clearing_account']);
  });
});

/* ── the model fan-out reviews of 11 Sep 2026 ───────────────────────────── */

describe('a reversal with nowhere to post leaves no reversal row', () => {
  it('a pre-settlement reversal with no PAYMENT_PROVIDER_CLEARING account is flagged, nothing is written, and it posts once the account is back', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;
    const standingBefore = await standing(businessId, paymentId);

    /* The clearing account is unavailable (deactivated with no replacement:
     * a provisioning gap, not a merchant act). The role itself is immutable
     * (0061); `accountByRole` answers only active accounts. */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`
        UPDATE accounts SET active = false, deactivated_at = now()
         WHERE business_id = ${businessId}::uuid
           AND system_role = 'PAYMENT_PROVIDER_CLEARING'
           AND scope_payment_connection_id = ${connectionId}::uuid
      `),
    );

    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      succeeded: false,
      providerStatus: 'reversed',
      providerTransactionId: 'pst-rev-9',
    });
    const first = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, first))?.error).toBe('reversal_no_clearing_account');
    expect(await reversalsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await standing(businessId, paymentId)).toEqual(standingBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect(
      (await reconciliationsOf(businessId)).some(
        (r) => r.reason === 'reversal_no_clearing_account',
      ),
    ).toBe(true);

    /* The account is restored and the provider's news is delivered again:
     * the reversal posts, once. Nothing about the first delivery stood in
     * the way. */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`
        UPDATE accounts SET active = true, deactivated_at = NULL
         WHERE business_id = ${businessId}::uuid
           AND system_role = 'PAYMENT_PROVIDER_CLEARING'
           AND scope_payment_connection_id = ${connectionId}::uuid
      `),
    );
    const second = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, second))?.error).toBeNull();
    expect(await reversalsOf(businessId)).toMatchObject([
      { paymentId, amountK: 15_000_000, providerReversalId: 'pst-rev-9' },
    ]);
    expect(await countRows(businessId, 'ledger_transactions', "posting_purpose = 'REVERSAL'")).toBe(
      1,
    );
    expect(await paymentStatus(businessId, paymentId)).toBe('reversed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a reversal of an OVERPAID payment is refused whole (OD-8)', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId, 10_000_000, 15_000_000);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      succeeded: false,
      providerStatus: 'reversed',
      providerTransactionId: 'pst-rev-10',
    });
    const eventId = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('reversal_overpaid_payment');
    expect(await reversalsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 10_000_000 }]);
  });
});

describe("the amount a chargeback posts is the provider's, never the envelope's", () => {
  it("a LOST dispute whose read carries no amount: chargeback_without_amount is a human's, nothing posts", async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyDispute('660', {
      amountK: null,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 660,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe('chargeback_without_amount');
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    // The envelope's figure describes the exception, so the human sees it.
    expect(exceptions).toMatchObject([
      { reason: 'chargeback_without_amount', amountK: 15_000_000 },
    ]);
  });
});

describe('the Starter-cap figure is GROSS processed volume (ADR 0019)', () => {
  it('a partial and then a full refund leave collected-to-date unchanged', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const collected = () =>
      withBusiness(appDb, businessId, (tx) => settleRepo.collectedToDate(tx, businessId));
    expect(await collected()).toBe(15_000_000);

    provider.willVerifyRefund('670', {
      amountK: 4_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 4_000_000, { id: 670 }));
    await pump();
    await drainJobs();
    expect(await paymentStatus(businessId, paymentId)).toBe('partially_refunded');
    expect(await collected()).toBe(15_000_000);

    provider.willVerifyRefund('671', {
      amountK: 11_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 11_000_000, { id: 671 }));
    await pump();
    await drainJobs();
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');
    expect(await collected()).toBe(15_000_000);
    const rows = await withBusiness(appDb, businessId, (tx) => settleRepo.collectedByBusiness(tx));
    expect(rows.find((r) => r.businessId === businessId)?.collectedK).toBe(15_000_000);
  });
});
