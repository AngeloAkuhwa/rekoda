/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a payment the merchant reports (RecordPayment) (part 1 of 2). Split by
 * concern from meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, withBusiness, sql } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import { issueRepo, reportsRepo, settleRepo } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import {
  A_SALE_FOR_PAYMENT,
  paymentOf,
  seedMerchant,
  drain,
  issueUnpaidInvoice,
  issueUnpaidInvoiceToCustomer,
} from './meta-record-payment.fixtures.js';

useMetaWebhookHarness();

describe('a payment the merchant reports (RecordPayment)', () => {
  /**
   * The same yes with the RecordPayment rollout flag ON (PR-022): identical
   * receipt and ledger, because the flag changes which gates run around the
   * work and never the work. What the bus adds is in the database — the
   * completed claim for the draft — and what the work always adds now is
   * spec E.7's basis: this payment was TYPED.
   */
  it('the RecordPayment flag routes the same yes through the command bus', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PF');

    const flagged = { ...deps, config: { ...deps.config, commandRecordPayment: true } };
    async function drainFlagged() {
      const runner = buildRunner(workerDb, db, flagged);
      let worked = await runner.runOnce();
      while (worked) worked = await runner.runOnce();
    }

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.PF-pay', 'Ada paid 60k'));
    await drainFlagged();
    await post(messagePayload('2348031234567', 'wamid.PF-confirm', 'yes'));
    await drainFlagged();

    expect(stubSender.lastText).toContain('RCT-');
    expect(stubSender.lastText).toContain('₦60,000');

    const claims = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ key: string; command_name: string }>(
        sql`SELECT key, command_name FROM idempotency_records
            WHERE business_id = ${business.id}::uuid AND command_name = 'RecordPayment'`,
      ),
    );
    expect([...claims]).toHaveLength(1);
    expect([...claims][0]?.key).toMatch(/^draft:/);

    const stamped = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ evidence_basis: string | null; initial_confirmation_source: string }>(
        sql`SELECT evidence_basis, initial_confirmation_source FROM payments
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect([...stamped][0]?.evidence_basis).toBe('TYPED');
    expect([...stamped][0]?.initial_confirmation_source).toBe('MERCHANT_ATTESTED');
  });

  it('records a part payment, moves the ledger, and issues a receipt', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P1');

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.P1-pay', 'Ada paid 60k'));
    await drain();
    // CG2 first: money never moves on a preview.
    expect(stubSender.lastText).toContain('Payment on INV-');
    expect(stubSender.lastText).toContain('Still owing after this: ₦90,000');

    await post(messagePayload('2348031234567', 'wamid.P1-confirm', 'yes'));
    await drain();

    expect(stubSender.lastText).toContain('₦60,000 recorded against INV-');
    expect(stubSender.lastText).toContain('₦90,000 still owed');
    expect(stubSender.lastText).toContain('Receipt RCT-');

    const { rows: payments } = await withBusiness(db, business.id, (tx) =>
      settleRepo.paymentsFor(tx),
    );
    expect(payments).toHaveLength(1);
    // RECORDED, never verified: no provider confirmed this (ADR 0014).
    expect(payments[0]?.verified).toBe(0);
    expect(payments[0]?.amountK).toBe(6_000_000);

    // The books balance, and the receivable came down by exactly the payment.
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    const credits = entries.reduce((n, e) => n + e.creditK, 0);
    expect(debits).toBe(credits);
    const arCredit = entries
      .filter((e) => e.account === 'ACCOUNTS_RECEIVABLE')
      .reduce((n, e) => n + e.creditK, 0);
    expect(arCredit).toBe(6_000_000);
  });

  it('resolves "the rest" against the real balance and settles the invoice', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P2');

    stubTransport.replyWith(paymentOf({ relativeAmount: 'remainder' }));
    await post(messagePayload('2348031234567', 'wamid.P2-pay', 'Ada paid the rest'));
    await drain();
    expect(stubSender.lastText).toContain('settles the invoice');

    await post(messagePayload('2348031234567', 'wamid.P2-confirm', 'yes'));
    await drain();
    expect(stubSender.lastText).toContain('That settles it');

    const invoices = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(invoices.rows[0]?.status).toBe('paid');
    expect(invoices.outstandingK).toBe(0);
  });

  it('shows an overpayment as received, applied and the rest, and saves nothing yet', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P3');

    stubTransport.replyWith(paymentOf({ amount: 400_000 }));
    await post(messagePayload('2348031234567', 'wamid.P3-pay', 'Ada paid 400k'));
    await drain();

    // OWN-16: a preview the merchant decides on, never something the books
    // quietly round away. Nothing moves until the yes.
    expect(stubSender.lastText).toContain('*Amount received: ₦400,000*');
    expect(stubSender.lastText).toContain('₦150,000');
    expect(stubSender.lastText).toContain('₦250,000');
    expect(stubSender.lastText).toContain('Reply *yes*');
    const { rows: payments } = await withBusiness(db, business.id, (tx) =>
      settleRepo.paymentsFor(tx),
    );
    expect(payments).toHaveLength(0);

    // The draft carries exactly the figures shown, ids and kobo only.
    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraft(tx, business.id),
    );
    expect(draft?.confirmationContext).toEqual({
      kind: 'payment_overpayment',
      invoiceId: expect.any(String),
      balanceShownK: 15_000_000,
      amountReceivedK: 40_000_000,
      allocatedK: 15_000_000,
      creditK: 25_000_000,
    });

    // The database refuses any other shape, so no writer can park text here:
    // an extra key, a missing key, a name where the id goes, a fraction, a
    // negative figure, or an object with nothing in it.
    for (const change of [
      `confirmation_context || '{"note":"Ada"}'::jsonb`,
      `confirmation_context - 'creditK'`,
      `confirmation_context || '{"invoiceId":"Ada Obi 08031234567"}'::jsonb`,
      `confirmation_context || '{"creditK":1.5}'::jsonb`,
      `confirmation_context || '{"allocatedK":-3}'::jsonb`,
      `'{}'::jsonb`,
      `'{"kind":"payment_overpayment"}'::jsonb`,
      `confirmation_context || '{"kind":null}'::jsonb`,
      `confirmation_context || '{"kind":"sale_overpayment"}'::jsonb`,
      `'[]'::jsonb`,
      `'"x"'::jsonb`,
      `confirmation_context || '{"creditK":"5"}'::jsonb`,
      `confirmation_context || '{"invoiceId":5}'::jsonb`,
    ]) {
      const parked = await withBusiness(db, business.id, (tx) =>
        tx.execute(
          sql`UPDATE command_drafts SET confirmation_context = ${sql.raw(change)}
              WHERE id = ${draft!.id}::uuid`,
        ),
      ).then(
        () => null,
        (error: unknown) => error as Error & { cause?: unknown },
      );
      expect(String(parked) + String(parked?.cause), change).toContain(
        'command_drafts_confirmation_context_ck',
      );
    }
  });

  for (const method of ['cash', 'transfer'] as const) {
    it(`a confirmed ${method} overpayment settles the invoice and the rest is customer credit (G-49)`, async () => {
      const business = await seedMerchant('+2348031234567');
      await issueUnpaidInvoiceToCustomer(business.id, `wamid.PO-${method}`);

      stubTransport.replyWith(paymentOf({ amount: 180_000, paymentMethod: method }));
      await post(messagePayload('2348031234567', `wamid.PO-${method}-pay`, 'Ada paid 180k'));
      await drain();
      expect(stubSender.lastText).toContain('Customer credit: ₦30,000');

      await post(messagePayload('2348031234567', `wamid.PO-${method}-confirm`, 'yes'));
      await drain();
      expect(stubSender.lastText).toContain('₦180,000 received on INV-');
      expect(stubSender.lastText).toContain('₦150,000 applied. That settles it.');
      expect(stubSender.lastText).toContain('₦30,000 noted as customer credit.');

      // The receipt was rendered and delivered for ALL that arrived, with the
      // merchant-recorded caption, never "confirmed".
      const delivered = stubSender.documents.at(-1);
      expect(delivered?.caption).toMatch(/^Receipt RCT-\S+ for ₦180,000 on INV-/);
      expect(delivered?.caption ?? '').not.toMatch(/confirm|verif|refund/i);

      const { rows: payments } = await withBusiness(db, business.id, (tx) =>
        settleRepo.paymentsFor(tx),
      );
      expect(payments).toHaveLength(1);
      expect(payments[0]?.amountK).toBe(18_000_000);
      expect(payments[0]?.verified).toBe(0);

      const credits = await withBusiness(db, business.id, (tx) =>
        tx.execute<{ amount_minor: string; source_type: string }>(
          sql`SELECT amount_minor::text, source_type FROM customer_credits
              WHERE business_id = ${business.id}::uuid`,
        ),
      );
      expect([...credits]).toEqual([{ amount_minor: '3000000', source_type: 'overpayment' }]);

      const entries = await withBusiness(db, business.id, (tx) =>
        issueRepo.ledgerEntriesFor(tx, business.id),
      );
      expect(entries.reduce((n, e) => n + e.debitK, 0)).toBe(
        entries.reduce((n, e) => n + e.creditK, 0),
      );
      const net = (account: string) =>
        entries.filter((e) => e.account === account).reduce((n, e) => n + e.debitK - e.creditK, 0);
      expect(net(method === 'cash' ? 'CASH' : 'BANK')).toBe(18_000_000);
      expect(net('CUSTOMER_CREDIT')).toBe(-3_000_000);
      expect(net('ACCOUNTS_RECEIVABLE')).toBe(0);
    });
  }

  it('a correction from an overpayment to the exact balance drops the overpayment figures (G-49)', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoiceToCustomer(business.id, 'wamid.PC');

    stubTransport.replyWith(paymentOf({ amount: 180_000 }));
    await post(messagePayload('2348031234567', 'wamid.PC-pay', 'Ada paid 180k'));
    await drain();
    expect(stubSender.lastText).toContain('Customer credit: ₦30,000');

    // CG5: the correction replaces the draft, and the new one shows no excess.
    stubTransport.replyWith(paymentOf({ amount: 150_000 }));
    await post(messagePayload('2348031234567', 'wamid.PC-fix', 'no, 150k not 180k'));
    await drain();
    expect(stubSender.lastText).not.toContain('Customer credit');
    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraft(tx, business.id),
    );
    expect(draft?.confirmationContext ?? null).toBeNull();

    await post(messagePayload('2348031234567', 'wamid.PC-confirm', 'yes'));
    await drain();
    expect(stubSender.lastText).toContain('₦150,000 recorded against INV-');

    const { rows: payments } = await withBusiness(db, business.id, (tx) =>
      settleRepo.paymentsFor(tx),
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]?.amountK).toBe(15_000_000);
    const credits = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`SELECT 1 FROM customer_credits WHERE business_id = ${business.id}::uuid`),
    );
    expect([...credits]).toHaveLength(0);
  });

  it('an overpayment on an invoice with no customer is unapplied, never owed to anyone (G-49)', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PU');

    stubTransport.replyWith(paymentOf({ amount: 180_000 }));
    await post(messagePayload('2348031234567', 'wamid.PU-pay', 'Ada paid 180k'));
    await drain();
    expect(stubSender.lastText).toContain(
      'Unapplied: ₦30,000. It is not linked to a customer yet.',
    );
    expect(stubSender.lastText).not.toContain('Customer credit');

    await post(messagePayload('2348031234567', 'wamid.PU-confirm', 'yes'));
    await drain();
    expect(stubSender.lastText).toContain('₦30,000 recorded as unapplied.');

    const credits = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`SELECT 1 FROM customer_credits WHERE business_id = ${business.id}::uuid`),
    );
    expect([...credits]).toHaveLength(0);
    // The mark is on THIS payment, which is what the refund guard reads.
    const marks = await withBusiness(db, business.id, (tx) =>
      tx.execute(
        sql`SELECT 1 FROM reconciliations r JOIN payments p ON p.id = r.payment_id
            WHERE r.business_id = ${business.id}::uuid AND r.reason = 'overpaid'
              AND r.outstanding_k = -3000000 AND p.amount_k = 18000000`,
      ),
    );
    expect([...marks]).toHaveLength(1);

    // The liability is booked even with nobody to hold it.
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    const net = (account: string) =>
      entries.filter((e) => e.account === account).reduce((n, e) => n + e.debitK - e.creditK, 0);
    expect(net('CASH')).toBe(18_000_000);
    expect(net('CUSTOMER_CREDIT')).toBe(-3_000_000);
    expect(net('ACCOUNTS_RECEIVABLE')).toBe(0);
  });

  /**
   * The race OWN-16 is about. The preview showed 150,000 owing and the
   * merchant confirmed 180,000; 100,000 lands before the yes. Booking now
   * would turn 130,000 into credit nobody was shown. Nothing is written.
   */
  it('a stale overpayment confirmation writes nothing and asks again (G-49)', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoiceToCustomer(business.id, 'wamid.PS');

    stubTransport.replyWith(paymentOf({ amount: 180_000 }));
    await post(messagePayload('2348031234567', 'wamid.PS-pay', 'Ada paid 180k'));
    await drain();
    expect(stubSender.lastText).toContain('Reply *yes*');

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
    const count = async (table: string) =>
      Number(
        [
          ...(await withBusiness(db, business.id, (tx) =>
            tx.execute<{ n: string }>(
              sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}
                  WHERE business_id = ${business.id}::uuid`,
            ),
          )),
        ][0]?.n ?? 0,
      );
    const tables = [
      'payments',
      'payment_allocations',
      'receipts',
      'customer_credits',
      'reconciliations',
      'ledger_transactions',
    ];
    const before = await Promise.all(tables.map(count));

    await post(messagePayload('2348031234567', 'wamid.PS-confirm', 'yes'));
    await drain();

    // Figures were on the draft, so the reply names what changed, not why.
    expect(stubSender.lastText).toContain('now has ₦50,000 owing, which is not what I');
    expect(stubSender.lastText).toContain('I have not recorded anything');
    expect(stubSender.lastText).not.toContain('Reply *yes*');
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });

  it('never invents an allocation when nothing is open', async () => {
    await seedMerchant('+2348031234567');

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await post(messagePayload('2348031234567', 'wamid.P4-pay', 'Ada paid 20k'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
  });

  /**
   * The one that matters most on this whole path.
   *
   * A chat-issued invoice carries `customer_id = NULL` and keeps the customer
   * token in its snapshot, so resolving by a customer JOIN alone matched
   * nothing and fell through to "the newest open invoice at all" — which for
   * a shop that issues more than one invoice a day is somebody else's.
   */
  it('puts a named customer payment on THEIR invoice, not the newest one', async () => {
    const business = await seedMerchant('+2348031234567');
    // Ada first, then Bola. Bola's is newest, so a fallback would take it.
    await issueUnpaidInvoice('wamid.P5');
    stubTransport.replyWith({
      ...A_SALE_FOR_PAYMENT,
      customer: { kind: 'token', token: 'CUSTOMER_B9L' },
      items: [{ name: 'bag', quantity: 1, unitPrice: 80_000 }],
      statedTotal: 80_000,
    });
    await post(messagePayload('2348031234567', 'wamid.P5-sale2', 'Bola bought a bag for 80k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.P5-yes2', 'yes'));
    await drain();

    const before = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    const adaInvoice = before.rows.find((r) => r.totalK === 15_000_000)!;
    const bolaInvoice = before.rows.find((r) => r.totalK === 8_000_000)!;

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await post(messagePayload('2348031234567', 'wamid.P5-pay', 'Ada paid 20k'));
    await drain();
    expect(stubSender.lastText).toContain(`Payment on ${adaInvoice.invoiceNumber}`);

    await post(messagePayload('2348031234567', 'wamid.P5-confirm', 'yes'));
    await drain();

    const after = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    const ada = after.rows.find((r) => r.invoiceNumber === adaInvoice.invoiceNumber)!;
    const bola = after.rows.find((r) => r.invoiceNumber === bolaInvoice.invoiceNumber)!;
    expect(ada.paidK).toBe(2_000_000);
    // Bola never paid anything, and nothing may say otherwise.
    expect(bola.paidK).toBe(0);
    expect(bola.balanceDueK).toBe(8_000_000);
  });

  it('asks which invoice when nobody is named and several are open', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P6');
    stubTransport.replyWith({
      ...A_SALE_FOR_PAYMENT,
      customer: { kind: 'token', token: 'CUSTOMER_B9L' },
      items: [{ name: 'bag', quantity: 1, unitPrice: 80_000 }],
      statedTotal: 80_000,
    });
    await post(messagePayload('2348031234567', 'wamid.P6-sale2', 'Bola bought a bag for 80k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.P6-yes2', 'yes'));
    await drain();

    stubTransport.replyWith(paymentOf({ amount: 20_000, customer: { kind: 'none' } }));
    await post(messagePayload('2348031234567', 'wamid.P6-pay', 'received 20k'));
    await drain();

    expect(stubSender.lastText).toContain('2 unpaid invoices open');
    expect(stubSender.lastText).not.toContain('Reply *yes*');
  });

  it('says so rather than guessing when the named customer owes nothing', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P7');

    stubTransport.replyWith(
      paymentOf({ amount: 20_000, customer: { kind: 'token', token: 'CUSTOMER_ZZZ' } }),
    );
    await post(messagePayload('2348031234567', 'wamid.P7-pay', 'Ngozi paid 20k'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
  });

  it('takes the invoice number the merchant typed over the customer they named', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P8');
    const open = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    const number = open.rows[0]!.invoiceNumber;

    stubTransport.replyWith(
      paymentOf({
        amount: 20_000,
        documentRef: number,
        customer: { kind: 'token', token: 'CUSTOMER_ZZZ' },
      }),
    );
    await post(messagePayload('2348031234567', 'wamid.P8-pay', `${number} paid 20k`));
    await drain();

    expect(stubSender.lastText).toContain(`Payment on ${number}`);
  });

  it('refuses an invoice number that names nothing open, rather than falling back', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P9');

    stubTransport.replyWith(paymentOf({ amount: 20_000, documentRef: 'INV-2026-999999' }));
    await post(messagePayload('2348031234567', 'wamid.P9-pay', 'INV-2026-999999 paid 20k'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
  });
});
