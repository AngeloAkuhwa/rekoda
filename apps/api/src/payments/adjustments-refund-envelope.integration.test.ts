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
import { sweepSettlements } from './settlement-sweep.js';
import {
  appDb,
  balanceByRole,
  chargeSuccess,
  countRows,
  deps,
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

/* ── the tenth independent review of 11 Sep 2026: Paystack's documented shapes ─ */

describe('the documented refund envelope and refund read (no refund id, charge named by transaction id)', () => {
  /** Book through the real pipeline with a KNOWN provider transaction id. */
  async function bookWithTransactionId(businessId: string, reference: string, txId: string) {
    provider.willVerify(reference, { amountK: 15_000_000, providerTransactionId: txId });
    await storeEvent(chargeSuccess(reference));
    await pump();
    await drainJobs();
    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ id: string; provider_reference: string | null }>(sql`
        SELECT p.id, i.provider_reference
          FROM payments p JOIN payment_intents i ON i.id = p.payment_intent_id
         WHERE p.rekoda_reference = ${reference}
      `),
    );
    const row = [...rows][0];
    if (!row?.id) throw new Error('booking did not produce a payment');
    expect(row.provider_reference).toBe(txId);
    return row.id;
  }

  /** The published sample shape: digit-string amount, no data.id. */
  function documentedRefundEvent(reference: string, amountK: number, status = 'processed') {
    return {
      event: status === 'processed' ? 'refund.processed' : `refund.${status}`,
      data: {
        status,
        transaction_reference: reference,
        refund_reference: null,
        amount: String(amountK),
        currency: 'NGN',
        processor: 'instant-transfer',
        integration: 412829,
        domain: 'live',
      },
    };
  }

  it('an id-less refund.processed with a string amount is stored, matched through the refund list, and books once', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-900');

    /* The provider's list names the charge by transaction id only. */
    provider.willVerifyRefund('900', {
      amountK: 15_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-900',
    });
    const eventId = await storeEvent(
      documentedRefundEvent(intent.reference, 15_000_000),
      'sha256:documented-refund-900',
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBeNull();
    const refunds = await refundsOf(businessId);
    expect(refunds).toMatchObject([{ providerRefundId: '900', amountK: 15_000_000 }]);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);

    /* A byte-different redelivery (the same fact) is one refund still. */
    await storeEvent(
      documentedRefundEvent(intent.reference, 15_000_000),
      'sha256:documented-refund-900-again',
    );
    await pump();
    await drainJobs();
    expect(await refundsOf(businessId)).toHaveLength(1);
  });

  it('a refund read that names the charge by transaction id (Fetch shape) books against the payment that stored it', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-901');

    provider.willVerifyRefund('901', {
      amountK: 15_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-901',
    });
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 901 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBeNull();
    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
  });

  it('a refund read whose transaction id is ANOTHER charge is a mismatch, nothing posts', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-902');

    provider.willVerifyRefund('902', {
      amountK: 15_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-other',
    });
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 902 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('refund_reference_mismatch');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
  });

  it('a refund the provider cannot find yet is retried and books when it appears; one that never appears is an exception', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-903');

    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 903 }));
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    await runner.runOnce(); // 404: the attempt fails, nothing retired
    expect((await events.eventStatus(workerDb, eventId))?.processed).toBe(false);
    expect(await refundsOf(businessId)).toHaveLength(0);

    provider.willVerifyRefund('903', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
    );
    await drainJobs();
    expect((await events.eventStatus(workerDb, eventId))?.error).toBeNull();
    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');

    /* A second payment whose refund never becomes readable: five attempts,
     * then an exception and a retired event, never a dead job. */
    const second = await seedObligation(businessId);
    await bookWithTransactionId(businessId, second.intent.reference, 'pst-tx-904');
    const never = await storeEvent(refundEvent(second.intent.reference, 15_000_000, { id: 904 }));
    await pump();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      expect(await runner.runOnce()).toBe(true);
    }
    expect((await events.eventStatus(workerDb, never))?.error).toBe('refund_verify_not_found');
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((j) => j.state === 'dead' || j.state === 'pending')).toHaveLength(0);
  });

  it('a provider that cannot be read on any attempt ends as an exception, never a dead job', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-905');
    const linesBefore = (await ledgerTotals(businessId)).lines;

    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 905 }));
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      provider.failNextRefundReadWith(new Error('refund read returned an unreadable response'));
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      expect(await runner.runOnce()).toBe(true);
    }

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('refund_read_unavailable');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['refund_read_unavailable']);
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((j) => j.state === 'dead' || j.state === 'pending')).toHaveLength(0);
  });

  it('a totals-only payout with gross equal to net over a refunded payment is still refused', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-906');
    provider.willVerifyRefund('906', {
      amountK: 5_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 5_000_000, { id: 906 }));
    await pump();
    await drainJobs();
    expect(await paymentStatus(businessId, paymentId)).toBe('partially_refunded');
    const clearing = await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId);

    provider.willSettle({ references: [intent.reference], grossK: 15_000_000, netK: 15_000_000 });
    await sweepSettlements({ workerDb, appDb, provider });

    expect(await countRows(businessId, 'settlements')).toBe(0);
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      clearing,
    );
    expect(
      (await reconciliationsOf(businessId)).filter(
        (r) => r.reason === 'settlement_components_unknown',
      ),
    ).toHaveLength(1);
  });
});

describe('two equal partial refunds announced without refund ids', () => {
  it('the second id-less event books the refund not yet on file, and a redelivery of either adds nothing', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      providerTransactionId: 'pst-tx-920',
    });
    await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();
    const idless = (suffix: string) => ({
      event: 'refund.processed',
      data: {
        status: 'processed',
        transaction_reference: intent.reference,
        refund_reference: null,
        amount: '5000000',
        currency: 'NGN',
        processor: 'instant-transfer',
        integration: 412829,
        domain: 'live',
        _delivery: suffix,
      },
    });

    provider.willVerifyRefund('920', {
      amountK: 5_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-920',
    });
    await storeEvent(idless('first'), 'sha256:idless-920-first');
    await pump();
    await drainJobs();
    expect((await refundsOf(businessId)).map((r) => r.providerRefundId)).toEqual(['920']);

    provider.willVerifyRefund('921', {
      amountK: 5_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-920',
    });
    await storeEvent(idless('second'), 'sha256:idless-920-second');
    await pump();
    await drainJobs();
    expect((await refundsOf(businessId)).map((r) => r.providerRefundId).sort()).toEqual([
      '920',
      '921',
    ]);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(10_000_000);

    const again = await storeEvent(idless('again'), 'sha256:idless-920-again');
    await pump();
    await drainJobs();
    expect((await events.eventStatus(workerDb, again))?.error).toBe('refund_already_recorded');
    expect(await refundsOf(businessId)).toHaveLength(2);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(10_000_000);
  });
});

describe('an id-less refund event waits for a refund the provider lists but has not processed', () => {
  it('the second of two equal refunds still processing: retried, then booked once it is processed', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      providerTransactionId: 'pst-tx-950',
    });
    await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();
    const idless = (suffix: string) => ({
      event: 'refund.processed',
      data: {
        status: 'processed',
        transaction_reference: intent.reference,
        refund_reference: null,
        amount: '5000000',
        currency: 'NGN',
        processor: 'instant-transfer',
        integration: 412829,
        domain: 'live',
        _delivery: suffix,
      },
    });

    provider.willVerifyRefund('950', {
      amountK: 5_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-950',
    });
    await storeEvent(idless('first'), 'sha256:idless-950-first');
    await pump();
    await drainJobs();
    expect((await refundsOf(businessId)).map((r) => r.providerRefundId)).toEqual(['950']);

    /* The provider lists the second refund, still processing. */
    provider.willVerifyRefund('951', {
      amountK: 5_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-950',
      succeeded: false,
      providerStatus: 'processing',
    });
    const second = await storeEvent(idless('second'), 'sha256:idless-950-second');
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    expect(await runner.runOnce()).toBe(true);
    expect((await events.eventStatus(workerDb, second))?.processed).toBe(false);
    expect(await refundsOf(businessId)).toHaveLength(1);

    provider.willVerifyRefund('951', {
      amountK: 5_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-950',
    });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
    );
    await drainJobs();
    expect((await events.eventStatus(workerDb, second))?.error).toBeNull();
    expect((await refundsOf(businessId)).map((r) => r.providerRefundId).sort()).toEqual([
      '950',
      '951',
    ]);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(10_000_000);
  });

  it('one that never turns processed is refund_read_never_processed on the last attempt, never a dead job', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      providerTransactionId: 'pst-tx-952',
    });
    await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    provider.willVerifyRefund('952', {
      amountK: 15_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-952',
      succeeded: false,
      providerStatus: 'pending',
    });
    const eventId = await storeEvent(
      {
        event: 'refund.processed',
        data: {
          status: 'processed',
          transaction_reference: intent.reference,
          refund_reference: null,
          amount: '15000000',
          currency: 'NGN',
          processor: 'instant-transfer',
          integration: 412829,
          domain: 'live',
        },
      },
      'sha256:idless-952',
    );
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      expect(await runner.runOnce()).toBe(true);
    }
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe(
      'refund_read_never_processed',
    );
    expect(await refundsOf(businessId)).toHaveLength(0);
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((j) => j.state === 'dead' || j.state === 'pending')).toHaveLength(0);
  });
});
