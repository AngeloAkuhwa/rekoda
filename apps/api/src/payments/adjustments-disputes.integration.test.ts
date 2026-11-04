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
  jobsRepo,
  paymentsHub,
  settleRepo,
  sql,
  withBusiness,
} from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  AR,
  appDb,
  balanceByCode,
  balanceByRole,
  bookPayment,
  chargebacksOf,
  countRows,
  deps,
  disputeEvent,
  drainJobs,
  invoiceState,
  ledgerTotals,
  paymentStatus,
  provider,
  pump,
  reconciliationsOf,
  seedBusiness,
  settle,
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

/* ── disputes and chargebacks ───────────────────────────────────────────── */

describe('disputes (§21): open is a risk state, lost is a chargeback', () => {
  it('a dispute OPENING reverses nothing and files one exception, however many reminders follow', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyDispute('601', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const opened = await storeEvent(disputeEvent(intent.reference, 15_000_000, { id: 601 }));
    const reminded = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, { id: 601, event: 'charge.dispute.remind' }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, opened))?.error).toBe('dispute_opened');
    expect((await events.eventStatus(workerDb, reminded))?.error).toBe('dispute_reminder');
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['dispute_opened']);
  });

  it('a dispute the merchant LOST before settlement is a chargeback through clearing, and the customer owes again', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyDispute('602', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const eventId = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 602,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect(await chargebacksOf(businessId)).toMatchObject([
      {
        paymentId,
        providerChargebackId: '602',
        amountK: 15_000_000,
        timing: 'PRE_SETTLEMENT',
        status: 'RECOVERED',
        recoveredVia: 'CLEARING_REVERSAL',
      },
    ]);
    expect(await invoiceState(businessId, sale.invoiceId)).toMatchObject({
      status: 'issued',
      balanceDueK: 15_000_000,
    });
    expect(await paymentStatus(businessId, paymentId)).toBe('reversed');
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(0);
    expect(await balanceByCode(businessId, AR)).toBe(15_000_000);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
    expect((await events.eventStatus(workerDb, eventId))?.error).toBeNull();
  });

  it('a dispute LOST after settlement raises a payable to the provider — a liability, never a second receivable', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    await settle(businessId, connectionId, paymentId, 15_000_000);

    provider.willVerifyDispute('603', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'auto-accepted',
      outcome: 'lost',
    });
    await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 603,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'auto-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect(await chargebacksOf(businessId)).toMatchObject([
      { timing: 'POST_SETTLEMENT', status: 'OPEN', recoveredVia: null },
    ]);
    expect(await balanceByRole(businessId, 'PROVIDER_CHARGEBACK_PAYABLE', connectionId)).toBe(
      -15_000_000,
    );
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(15_000_000);
    expect(await countRows(businessId, 'settlements', "status = 'SETTLED'")).toBe(1);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a dispute the merchant WON moves nothing', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    provider.willVerifyDispute('604', {
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'declined',
      outcome: 'won',
    });
    const eventId = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 604,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'declined',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('dispute_won');
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
  });

  it('a duplicate LOST notification charges back once', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    provider.willVerifyDispute('605', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const body = disputeEvent(intent.reference, 15_000_000, {
      id: 605,
      event: 'charge.dispute.resolve',
      status: 'resolved',
      resolution: 'merchant-accepted',
    });
    await storeEvent(body);
    const again = await storeEvent(body, '605:charge.dispute.resolve:redelivery');
    await pump();
    await drainJobs();

    expect(await chargebacksOf(businessId)).toHaveLength(1);
    expect(
      await countRows(businessId, 'ledger_transactions', "posting_purpose = 'CHARGEBACK'"),
    ).toBe(1);
    expect((await events.eventStatus(workerDb, again))?.error).toBe('chargeback_already_recorded');
  });
});

/* ── the independent review of 11 Sep 2026 ───────────────────────────────── */

describe('a dispute is filed once per reason while open, not once per obligation', () => {
  it('an OVERPAID obligation (an open exception already on file) still gets its dispute-opened row', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId); // ₦150,000 owed
    await bookPayment(businessId, intent.reference, 20_000_000); // ₦200,000 paid
    const before = (await reconciliationsOf(businessId)).filter((r) => r.status === 'EXCEPTION');
    expect(before.map((r) => r.reason)).toEqual(['overpaid']);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');

    provider.willVerifyDispute('611', {
      amountK: 20_000_000,
      transactionReference: intent.reference,
    });
    const opened = await storeEvent(disputeEvent(intent.reference, 20_000_000, { id: 611 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, opened))?.error).toBe('dispute_opened');
    const after = (await reconciliationsOf(businessId)).filter((r) => r.status === 'EXCEPTION');
    expect(after.map((r) => r.reason).sort()).toEqual(['dispute_opened', 'overpaid']);
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
  });

  it('an obligation whose earlier exception a human RESOLVED still gets its dispute-opened row, and a reminder adds none', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    await withBusiness(appDb, businessId, async (tx) => {
      await settleRepo.recordException(tx, {
        businessId,
        reason: 'late_confirmation',
        expectationKind: 'invoice',
        expectationId: sale.invoiceId,
        amountK: 15_000_000,
      });
      const [row] = (await settleRepo.reconciliationsFor(tx)).filter(
        (r) => r.reason === 'late_confirmation',
      );
      expect(await settleRepo.resolveException(tx, businessId, row!.id, 'ops')).toBe(true);
    });

    provider.willVerifyDispute('612', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const opened = await storeEvent(disputeEvent(intent.reference, 15_000_000, { id: 612 }));
    const reminded = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, { id: 612, event: 'charge.dispute.remind' }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, opened))?.error).toBe('dispute_opened');
    expect((await events.eventStatus(workerDb, reminded))?.error).toBe('dispute_reminder');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason).sort()).toEqual(['dispute_opened', 'late_confirmation']);
    // Exactly one dispute-opened row, and it is the open one.
    const disputes = exceptions.filter((r) => r.reason === 'dispute_opened');
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.resolvedAt).toBeNull();
  });
});

/* ── the eleventh independent review of 11 Sep 2026 ──────────────────────── */

describe('the published dispute object (null fields) reaches the books', () => {
  it('charge.dispute.create with transaction_reference, refund_amount and currency null is stored and files dispute_opened', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyDispute('2867', { amountK: null, transactionReference: intent.reference });
    const opened = await storeEvent({
      event: 'charge.dispute.create',
      data: {
        id: 2867,
        refund_amount: null,
        currency: null,
        status: 'awaiting-merchant-feedback',
        resolution: null,
        domain: 'live',
        transaction: {
          id: 5991760,
          status: 'success',
          reference: intent.reference,
          amount: 15_000_000,
          currency: 'NGN',
        },
        transaction_reference: null,
        category: 'general',
        resolvedAt: null,
        evidence: null,
        note: null,
      },
    });
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, opened))?.error).toBe('dispute_opened');
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['dispute_opened']);
  });
});

/* ── the twelfth independent review of 11 Sep 2026 ───────────────────────── */

describe("a dispute read that fails is retried, then a human's, never a dead job", () => {
  it('a provider unreadable on every attempt of a LOST dispute: dispute_read_unavailable, nothing posts', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 940,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      provider.failNextDisputeReadWith(new Error('dispute read failed with HTTP 503'));
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      expect(await runner.runOnce()).toBe(true);
    }

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe('dispute_read_unavailable');
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions).toMatchObject([{ reason: 'dispute_read_unavailable', amountK: 15_000_000 }]);
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((j) => j.state === 'dead' || j.state === 'pending')).toHaveLength(0);
  });

  it('a dispute the provider cannot find yet is retried and charges back once when it appears', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 941,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    expect(await runner.runOnce()).toBe(true); // 404: fails, retried
    expect((await events.eventStatus(workerDb, resolved))?.processed).toBe(false);
    expect(await chargebacksOf(businessId)).toHaveLength(0);

    provider.willVerifyDispute('941', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
    );
    await drainJobs();
    expect((await events.eventStatus(workerDb, resolved))?.error).toBeNull();
    expect(await chargebacksOf(businessId)).toHaveLength(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('reversed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
  });
});
