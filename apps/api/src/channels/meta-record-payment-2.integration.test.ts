/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a payment the merchant reports (RecordPayment) (part 2 of 2). Split by
 * concern from meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { usageRepo, withBusiness, sql } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { issueRepo, settleRepo } from '@rekoda/db';
import {
  db,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import {
  paymentOf,
  seedMerchant,
  drain,
  issueUnpaidInvoice,
  usedOf,
} from './meta-record-payment.fixtures.js';

useMetaWebhookHarness();

describe('a payment the merchant reports (RecordPayment)', () => {
  /**
   * A receipt is a metered document, and the copy has always said so
   * ("invoices and receipts"). Recording a payment issues one, so it costs a
   * unit exactly like a sale does: leaving it free let a merchant on an
   * exhausted plan take receipts without limit.
   */
  it('spends a documents unit on the receipt a reported payment issues', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PB');
    const period = usagePeriod(new Date());
    const before = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.PB-pay', 'Ada paid 60k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.PB-confirm', 'yes'));
    await drain();

    const after = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usedOf(after, 'DOCUMENT_GENERATION') - usedOf(before, 'DOCUMENT_GENERATION')).toBe(1);
  });

  it('gives the unit back when the payment could not be placed', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PC');
    const period = usagePeriod(new Date());

    // Preview against the real invoice, then let the invoice settle before
    // the yes lands: the message unit is spent, the receipt never issues.
    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await post(messagePayload('2348031234567', 'wamid.PC-pay', 'Ada paid 20k'));
    await drain();

    const before = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    const open = await withBusiness(db, business.id, (tx) =>
      issueRepo.latestOpenInvoice(tx, business.id),
    );
    await withBusiness(db, business.id, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: business.id,
        invoiceId: open!.id,
        amountK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'settled-elsewhere',
        actor: 'test',
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.PC-confirm', 'yes'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
    const after = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usedOf(after, 'DOCUMENT_GENERATION')).toBe(usedOf(before, 'DOCUMENT_GENERATION'));
  });

  /**
   * The balance fell between the preview and the yes.
   *
   * The confirmation re-resolves the invoice and re-gates on the FRESH
   * balance, which is the whole reason it does not carry the preview's
   * figure forward: the merchant is asked before anything is attempted.
   * `BalanceMoved` in settle.ts guards the narrower race that remains,
   * between that read and the row lock, and refuses there too. Neither path
   * posts what fits and drops the rest, which would leave real money with no
   * story and only the merchant knows where it belongs.
   */
  it('asks rather than posting less when the invoice owes less than reported', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PD');

    stubTransport.replyWith(paymentOf({ amount: 150_000 }));
    await post(messagePayload('2348031234567', 'wamid.PD-pay', 'Ada paid 150k'));
    await drain();
    expect(stubSender.lastText).toContain('Reply *yes*');

    // A transfer lands while the merchant is typing their confirmation.
    const open = await withBusiness(db, business.id, (tx) =>
      issueRepo.latestOpenInvoice(tx, business.id),
    );
    await withBusiness(db, business.id, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: business.id,
        invoiceId: open!.id,
        amountK: 10_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'landed-meanwhile',
        actor: 'test',
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.PD-confirm', 'yes'));
    await drain();

    // G-49: the fresh balance makes this an overpayment nobody was shown, so
    // it is refused as stale rather than turned into ₦100,000 of credit.
    expect(stubSender.lastText).toContain('only has ₦50,000 owing');
    expect(stubSender.lastText).toContain('I have not recorded anything');
    // A question, never a preview: nothing here invites another yes.
    expect(stubSender.lastText).not.toContain('Reply *yes*');

    // Exactly the one payment that really landed, and no second receipt.
    const { rows: payments } = await withBusiness(db, business.id, (tx) =>
      settleRepo.paymentsFor(tx),
    );
    expect(payments).toHaveLength(1);
    // And nothing else of the stale yes: one receipt, one allocation, one
    // payment posting beside the sale's, no credit and no overpaid mark.
    const n = async (query: ReturnType<typeof sql>) =>
      [...(await withBusiness(db, business.id, (tx) => tx.execute(query)))].length;
    expect(await n(sql`SELECT 1 FROM receipts WHERE business_id = ${business.id}::uuid`)).toBe(1);
    expect(
      await n(sql`SELECT 1 FROM payment_allocations WHERE business_id = ${business.id}::uuid`),
    ).toBe(1);
    expect(
      await n(sql`SELECT 1 FROM customer_credits WHERE business_id = ${business.id}::uuid`),
    ).toBe(0);
    expect(
      await n(sql`SELECT 1 FROM reconciliations WHERE business_id = ${business.id}::uuid`),
    ).toBe(0);
    expect(
      await n(sql`SELECT 1 FROM ledger_transactions WHERE business_id = ${business.id}::uuid`),
    ).toBe(2);
  });

  it('tells the customer on the receipt that the seller recorded it, not a provider', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PA');

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.PA-pay', 'Ada paid 60k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.PA-confirm', 'yes'));
    await drain();

    const receipt = stubSender.documents.at(-1);
    expect(receipt).toBeDefined();
    // The caption the merchant forwards must never borrow "confirmed".
    expect(receipt?.caption ?? '').not.toContain('confirmed');
    expect(receipt?.caption ?? '').toContain('Forward it to your customer');
  });
});
