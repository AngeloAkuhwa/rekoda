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
import { events, issueRepo, jobsRepo, paymentsHub, sql, withBusiness } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  appDb,
  bookPayment,
  chargebacksOf,
  deps,
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

describe('a refund.processed event whose provider read disagrees', () => {
  it('a read that still says PENDING fails the attempt, keeps the event live, and books once the read catches up', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('520', {
      succeeded: false,
      providerStatus: 'pending',
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const refundEventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 520 }));
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    await runner.runOnce(); // the read lags: the attempt fails and rolls back

    expect((await events.eventStatus(workerDb, refundEventId))?.processed).toBe(false);
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    const retry = jobs.find((j) => j.state === 'pending');
    expect(retry).toBeDefined();
    expect(retry?.attempts).toBe(1);
    // Nothing was retired: the exception queue is as empty as it was.
    expect(
      (await reconciliationsOf(businessId)).filter((r) => r.status === 'EXCEPTION'),
    ).toHaveLength(0);

    /* The provider's record catches up; the retry (brought forward past
     * its backoff) books the refund exactly once. */
    provider.willVerifyRefund('520', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
    );
    await drainJobs();

    expect((await events.eventStatus(workerDb, refundEventId))?.error).toBeNull();
    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a read that says FAILED contradicts the envelope: an exception for a human, no posting', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyRefund('521', {
      succeeded: false,
      providerStatus: 'failed',
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const refundEventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 521 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, refundEventId))?.error).toBe(
      'refund_failed_on_processed_event',
    );
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['refund_failed_on_processed_event']);
  });
});

describe('a refund read that never turns processed ends in the exception queue, not in a dead job', () => {
  it('on the last attempt the disagreement is filed and the event retired; no posting, no dead job', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyRefund('540', {
      succeeded: false,
      providerStatus: 'pending',
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const refundEventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 540 }));
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    const maxAttempts = 5; // the queue's default (migration 0004)
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      expect(await runner.runOnce()).toBe(true);
      if (attempt < maxAttempts) {
        expect((await events.eventStatus(workerDb, refundEventId))?.processed).toBe(false);
      }
    }

    expect((await events.eventStatus(workerDb, refundEventId))?.error).toBe(
      'refund_read_never_processed',
    );
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['refund_read_never_processed']);
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((j) => j.state === 'dead' || j.state === 'pending')).toHaveLength(0);
  });
});

describe('a provider read that names no charge is not evidence', () => {
  it('a refund read with no transaction reference is refund_reference_missing, nothing posts', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyRefund('690', { amountK: 15_000_000, transactionReference: null });
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 690 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('refund_reference_missing');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
  });

  it('a lost dispute read with no transaction reference is chargeback_reference_missing, nothing posts', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyDispute('691', {
      amountK: 15_000_000,
      transactionReference: null,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 691,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe(
      'chargeback_reference_missing',
    );
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
  });
});

describe("Paystack's refund.needs-attention is a human's, not a label", () => {
  it('files refund_needs_attention and posts nothing', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    const eventId = await storeEvent(
      refundEvent(intent.reference, 15_000_000, {
        id: 930,
        event: 'refund.needs-attention',
        status: 'needs-attention',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('refund_needs_attention');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions).toMatchObject([{ reason: 'refund_needs_attention', amountK: 15_000_000 }]);
  });
});
