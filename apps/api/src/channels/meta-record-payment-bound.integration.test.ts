/**
 * A reported payment is booked to the invoice its preview SHOWED (OD-57, OWN-101).
 *
 * "Ada paid 20k" names a customer and no invoice number. The preview resolves Ada's newest
 * open invoice and shows it; the "yes" must book to that same invoice, never to whichever
 * invoice is newest when the yes arrives. The preview records the invoice it showed (its id,
 * the balance and the amount) beside the draft; at the yes that invoice is loaded by id
 * and its payable state revalidated, under the invoice's row lock as well. A confirmation
 * that no longer describes the truth is refused and asked again, never redirected.
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { settleRepo, sql, withBusiness } from '@rekoda/db';
import {
  db,
  knownCustomer,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import {
  A_SALE_FOR_PAYMENT,
  drain,
  issueUnpaidInvoice,
  paymentOf,
  seedMerchant,
} from './meta-record-payment.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';

async function send(text: string, wamid: string) {
  await post(messagePayload(OWNER, wamid, text));
  await drain();
}

type InvoiceRow = {
  id: string;
  invoice_number: string;
  balance_due_k: string;
  customer_id: string | null;
};

/** The business's invoices, oldest first. */
const invoices = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<InvoiceRow>(
      sql`SELECT id, invoice_number, balance_due_k::text, customer_id FROM invoices
           WHERE business_id = ${businessId}::uuid ORDER BY created_at, invoice_number`,
    ),
  ).then((rows) => [...rows]);

/** Chat-booked payments and the invoice each was allocated to. */
const chatPayments = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ amount_k: string; invoice_id: string }>(
      sql`SELECT p.amount_k::text, a.invoice_id
            FROM payments p JOIN payment_allocations a ON a.payment_id = p.id
           WHERE p.business_id = ${businessId}::uuid AND p.source_type = 'chat'
           ORDER BY p.created_at`,
    ),
  ).then((rows) => [...rows]);

const pendingPaymentDraft = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ id: string; confirmation_context: unknown }>(
      sql`SELECT id, confirmation_context FROM command_drafts
           WHERE business_id = ${businessId}::uuid AND intent = 'RecordPayment'
             AND state = 'pending'
           ORDER BY insertion_seq DESC LIMIT 1`,
    ),
  ).then((rows) => [...rows][0]);

/** A payment that lands outside the chat, between the preview and the yes. */
async function paidElsewhere(businessId: string, invoiceId: string, amountK: number) {
  await withBusiness(db, businessId, (tx) =>
    settleRepo.recordMerchantPayment(tx, {
      businessId,
      invoiceId,
      amountK,
      method: 'transfer',
      sourceType: 'dashboard',
      sourceId: `elsewhere-${invoiceId}-${amountK}`,
      actor: 'test',
    }),
  );
}

describe('a payment preview is bound to the invoice it showed (OD-57)', () => {
  it('(i) a newer invoice issued before the yes never takes the payment', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B1-1');
    const [inv1] = await invoices(business.id);

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await send('Ada paid 20k', 'wamid.B1-pay');
    expect(stubSender.lastText).toContain(`Payment on ${inv1!.invoice_number}`);

    // Before the yes, a second invoice is issued to Ada: it is now her newest open one.
    await issueUnpaidInvoice('wamid.B1-2');
    const [, inv2] = await invoices(business.id);
    expect(inv2).toBeDefined();

    await send('yes', 'wamid.B1-yes');

    expect(await chatPayments(business.id)).toEqual([
      { amount_k: '2000000', invoice_id: inv1!.id },
    ]);
    const [after1, after2] = await invoices(business.id);
    expect(after1!.balance_due_k).toBe('13000000');
    // The newer invoice is untouched.
    expect(after2!.balance_due_k).toBe('15000000');
    expect(stubSender.lastText).toContain(inv1!.invoice_number);
  });

  it('(ii) a CG5 nameless payment correction books to the invoice its preview showed', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B2-1');
    const [inv1] = await invoices(business.id);

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await send('Ada paid 20k', 'wamid.B2-pay');
    stubTransport.replyWith(paymentOf({ amount: 30_000, customer: { kind: 'none' } }));
    await send('no, 30k not 20k', 'wamid.B2-fix');
    expect(stubSender.lastText).toContain('replaced the earlier version');
    expect(stubSender.lastText).toContain(`Payment on ${inv1!.invoice_number}`);

    await issueUnpaidInvoice('wamid.B2-2');
    await send('yes', 'wamid.B2-yes');

    expect(await chatPayments(business.id)).toEqual([
      { amount_k: '3000000', invoice_id: inv1!.id },
    ]);
    const [, after2] = await invoices(business.id);
    expect(after2!.balance_due_k).toBe('15000000');
  });

  it('(iii) a shown invoice paid in full before the yes is refused', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B3-1');
    const [inv1] = await invoices(business.id);

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await send('Ada paid 20k', 'wamid.B3-pay');
    await paidElsewhere(business.id, inv1!.id, 15_000_000);
    // And a newer open invoice for Ada exists, which a re-resolution would pick.
    await issueUnpaidInvoice('wamid.B3-2');

    await send('yes', 'wamid.B3-yes');

    expect(stubSender.lastText).toBe(replies.paymentAlreadySettled(inv1!.invoice_number).text);
    expect(await chatPayments(business.id)).toEqual([]);
    const [, after2] = await invoices(business.id);
    expect(after2!.balance_due_k).toBe('15000000');
  });

  it('(iv) a part payment whose invoice balance changed is refused, not booked', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B4-1');
    const [inv1] = await invoices(business.id);

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await send('Ada paid 20k', 'wamid.B4-pay');
    expect(stubSender.lastText).toContain('Still owing after this: ₦130,000');
    // ₦10,000 lands elsewhere: the preview's "still owing" is no longer true.
    await paidElsewhere(business.id, inv1!.id, 1_000_000);

    await send('yes', 'wamid.B4-yes');

    expect(stubSender.lastText).toBe(
      replies.paymentBalanceMoved(inv1!.invoice_number, 14_000_000, 0).text,
    );
    expect(stubSender.lastText).not.toContain('Reply *yes*');
    expect(await chatPayments(business.id)).toEqual([]);
    const [after1] = await invoices(business.id);
    expect(after1!.balance_due_k).toBe('14000000');
  });

  it('(v) an unchanged invoice books once, even under a double yes', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B5-1');
    const [inv1] = await invoices(business.id);

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await send('Ada paid 20k', 'wamid.B5-pay');
    await send('yes', 'wamid.B5-yes');
    await send('yes', 'wamid.B5-yes2');

    expect(await chatPayments(business.id)).toEqual([
      { amount_k: '2000000', invoice_id: inv1!.id },
    ]);
    const [after1] = await invoices(business.id);
    expect(after1!.balance_due_k).toBe('13000000');
  });

  it('(vi) a payment that names its invoice number books to that invoice as before', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B6-1');
    await issueUnpaidInvoice('wamid.B6-2');
    const [inv1, inv2] = await invoices(business.id);

    stubTransport.replyWith(
      paymentOf({
        amount: 20_000,
        customer: { kind: 'none' },
        documentRef: inv1!.invoice_number,
      }),
    );
    await send(`${inv1!.invoice_number} paid 20k`, 'wamid.B6-pay');
    expect(stubSender.lastText).toContain(`Payment on ${inv1!.invoice_number}`);
    await send('yes', 'wamid.B6-yes');

    expect(await chatPayments(business.id)).toEqual([
      { amount_k: '2000000', invoice_id: inv1!.id },
    ]);
    const [, after2] = await invoices(business.id);
    expect(after2!.id).toBe(inv2!.id);
    expect(after2!.balance_due_k).toBe('15000000');
  });

  it('(vii) an overpayment still follows OWN-16 on the invoice it showed', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B7-1');
    const [inv1] = await invoices(business.id);

    stubTransport.replyWith(paymentOf({ amount: 160_000 }));
    await send('Ada paid 160k', 'wamid.B7-pay');
    expect(stubSender.lastText).toContain('Customer credit: ₦10,000');
    expect((await pendingPaymentDraft(business.id))?.confirmation_context).toMatchObject({
      kind: 'payment_overpayment',
      invoiceId: inv1!.id,
    });
    await issueUnpaidInvoice('wamid.B7-2');
    await send('yes', 'wamid.B7-yes');

    expect(await chatPayments(business.id)).toEqual([
      { amount_k: '16000000', invoice_id: inv1!.id },
    ]);
    const [after1, after2] = await invoices(business.id);
    expect(after1!.balance_due_k).toBe('0');
    expect(after2!.balance_due_k).toBe('15000000');
  });

  it('(viii) a draft previewed before the change (no stored invoice) is asked again', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B8-1');

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await send('Ada paid 20k', 'wamid.B8-pay');
    const draft = await pendingPaymentDraft(business.id);
    // What a draft written by the earlier code looks like: nothing recorded beside it.
    await withBusiness(db, business.id, (tx) =>
      tx.execute(
        sql`UPDATE command_drafts SET confirmation_context = NULL WHERE id = ${draft!.id}::uuid`,
      ),
    );

    await send('yes', 'wamid.B8-yes');

    expect(stubSender.lastText).toBe(replies.paymentPreviewOutOfDate().text);
    expect(await chatPayments(business.id)).toEqual([]);
  });

  it('(ix) another business’s invoice is never resolved, whatever the draft holds', async () => {
    const other = await seedMerchant('+2348030000999');
    // The other business's invoice, issued through its own owner.
    stubTransport.replyWith(A_SALE_FOR_PAYMENT);
    await post(messagePayload('2348030000999', 'wamid.B9-o-sale', 'Ada bought 3 wigs for 150k'));
    await drain();
    await post(messagePayload('2348030000999', 'wamid.B9-o-yes', 'yes'));
    await drain();
    const [foreign] = await invoices(other.id);
    expect(foreign).toBeDefined();

    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B9-1');
    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await send('Ada paid 20k', 'wamid.B9-pay');
    const draft = await pendingPaymentDraft(business.id);
    const context = draft!.confirmation_context as Record<string, unknown>;
    await withBusiness(db, business.id, (tx) =>
      tx.execute(
        sql`UPDATE command_drafts
               SET confirmation_context = ${JSON.stringify({ ...context, invoiceId: foreign!.id })}::jsonb
             WHERE id = ${draft!.id}::uuid`,
      ),
    );

    await send('yes', 'wamid.B9-yes');

    expect(stubSender.lastText).toBe(replies.paymentPreviewOutOfDate().text);
    expect(await chatPayments(business.id)).toEqual([]);
    expect(await chatPayments(other.id)).toEqual([]);
    const [foreignAfter] = await invoices(other.id);
    expect(foreignAfter!.balance_due_k).toBe('15000000');
  });

  it('(x) a shown invoice that is not the named customer’s is refused, never redirected', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B10-1');
    // Bola owes on her own invoice in the same business.
    await knownCustomer(business.id, 'Bola', 'CUSTOMER_9B1');
    stubTransport.replyWith({
      ...A_SALE_FOR_PAYMENT,
      customer: { kind: 'token', token: 'CUSTOMER_9B1' },
    });
    await send('Bola bought 3 wigs for 150k', 'wamid.B10-b-sale');
    await send('yes', 'wamid.B10-b-yes');
    const [, bolaInvoice] = await invoices(business.id);
    expect(bolaInvoice).toBeDefined();

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await send('Ada paid 20k', 'wamid.B10-pay');
    const draft = await pendingPaymentDraft(business.id);
    const context = draft!.confirmation_context as Record<string, unknown>;
    await withBusiness(db, business.id, (tx) =>
      tx.execute(
        sql`UPDATE command_drafts
               SET confirmation_context = ${JSON.stringify({ ...context, invoiceId: bolaInvoice!.id })}::jsonb
             WHERE id = ${draft!.id}::uuid`,
      ),
    );

    await send('yes', 'wamid.B10-yes');

    expect(stubSender.lastText).toBe(replies.paymentPreviewOutOfDate().text);
    expect(await chatPayments(business.id)).toEqual([]);
  });

  it('records the invoice it showed beside every payment preview', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B11-1');
    const [inv1] = await invoices(business.id);

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await send('Ada paid 20k', 'wamid.B11-pay');

    expect((await pendingPaymentDraft(business.id))?.confirmation_context).toEqual({
      kind: 'payment_invoice',
      invoiceId: inv1!.id,
      balanceShownK: 15_000_000,
      amountShownK: 2_000_000,
    });
  });

  it('the database refuses any other shape in the column (0247)', async () => {
    const business = await seedMerchant(`+${OWNER}`);
    await issueUnpaidInvoice('wamid.B12-1');
    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await send('Ada paid 20k', 'wamid.B12-pay');
    const draft = await pendingPaymentDraft(business.id);
    const context = draft!.confirmation_context as Record<string, unknown>;
    for (const bad of [
      { ...context, amountShownK: 15_000_001 },
      { ...context, amountShownK: 0 },
      { ...context, balanceShownK: 1.5 },
      { ...context, invoiceId: 'INV-2026-000001' },
      { ...context, customerName: 'Ada' },
      { ...context, kind: 'something_else' },
    ]) {
      await expect(
        withBusiness(db, business.id, (tx) =>
          tx.execute(
            sql`UPDATE command_drafts SET confirmation_context = ${JSON.stringify(bad)}::jsonb
                 WHERE id = ${draft!.id}::uuid`,
          ),
        ),
        JSON.stringify(bad),
      ).rejects.toThrow();
    }
  });
});
