/**
 * The first two commands (spec §25; PR-021), proved on the properties the
 * slice exists for:
 *
 *   - replaying a command with the same idempotency key returns the FIRST
 *     response and writes nothing — no second invoice, no second event, no
 *     second job;
 *   - the outbox event and the state change commit or roll back TOGETHER;
 *   - the convert race mints one invoice however many hands convert;
 *   - the events the commands emit are types the production dispatcher
 *     handles, so nothing a command announces can go dead.
 *
 * Everything runs through the same `CommandBus` production wires and the
 * same work functions both flag positions share, because what the flag
 * changes is which gates run — never what a sale is.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  customersRepo,
  identity,
  ordersRepo,
  outboxRepo,
  settleRepo,
  sql,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { layoutReceipt, replies } from '@rekoda/core';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { CommandBus } from './command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import {
  issueInvoiceWork,
  recordSaleWork,
  voidReceiptWork,
  QuoteAlreadyTaken,
  type IssueInvoiceInput,
  type RecordSaleInput,
} from './sale-commands.js';
import { buildOutboxDispatcher } from '../jobs/jobs.module.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
const bus = new CommandBus(new RiskPolicyService());

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 8 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348160000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

function saleInput(businessId: string): RecordSaleInput {
  return {
    businessId,
    customerId: null,
    customerToken: 'cus_tok_1',
    items: [{ name: 'Ankara bale', quantity: 2, unitPriceK: 500_000 }],
    subtotalK: 1_000_000,
    discountK: 0,
    deliveryFeeK: 0,
    vatK: 0,
    totalK: 1_000_000,
    paidK: 1_000_000,
    balanceDueK: 0,
    method: 'cash',
    sourceType: 'chat',
    sourceId: 'draft-sale-1',
    saleSource: null,
    dueDate: null,
    actor: 'system',
  };
}

async function count(businessId: string, table: string, where = ''): Promise<number> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}
          WHERE business_id = ${businessId}::uuid ${sql.raw(where)}`,
    ),
  );
  return Number([...rows][0]?.n ?? 0);
}

describe('RecordSale through the bus', () => {
  it('issues once, and the replay returns the first answer writing nothing', async () => {
    const businessId = await seedBusiness();
    const input = saleInput(businessId);
    const envelope = {
      businessId,
      command: 'RecordSale' as const,
      payload: input,
      actor: 'system',
      ingress: 'CHAT' as const,
      idempotencyKey: 'draft:draft-sale-1',
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordSaleWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.replayed).toBe(false);
    expect(first.result.invoiceNumber).toMatch(/^INV-/);
    expect(first.result.balanceDueK).toBe(0);

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordSaleWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    /* Writes nothing: one invoice, one outbox event, one render job. */
    expect(await count(businessId, 'invoices')).toBe(1);
    expect(await count(businessId, 'outbox_events')).toBe(1);
    expect(await count(businessId, 'jobs')).toBe(1);
  });

  it('the outbox event and the sale commit or roll back together', async () => {
    const businessId = await seedBusiness();
    const input = saleInput(businessId);

    await expect(
      withBusiness(appDb, businessId, async (tx) => {
        await recordSaleWork(tx, input);
        throw new Error('after the work, before the commit');
      }),
    ).rejects.toThrow('after the work');

    /* Neither the sale nor its announcement survived: an event describing a
     * sale that never happened is exactly what §26 makes impossible. */
    expect(await count(businessId, 'invoices')).toBe(0);
    expect(await count(businessId, 'outbox_events')).toBe(0);
    expect(await count(businessId, 'jobs')).toBe(0);
  });

  it('announces the sale with the invoice identity, never the customer', async () => {
    const businessId = await seedBusiness();
    const input = saleInput(businessId);
    await withBusiness(appDb, businessId, (tx) => recordSaleWork(tx, input));

    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ type: string; payload: Record<string, unknown> }>(
        sql`SELECT type, payload FROM outbox_events WHERE business_id = ${businessId}::uuid`,
      ),
    );
    const event = [...rows][0];
    expect(event?.type).toBe('sale.recorded');
    expect(event?.payload['invoiceNumber']).toMatch(/^INV-/);
    expect(event?.payload['totalK']).toBe(1_000_000);
    /* The pseudonymous token stays out of the event: a consumer that needs
     * the customer asks the record, not the announcement. */
    expect(JSON.stringify(event?.payload)).not.toContain('cus_tok_1');
  });
});

describe('IssueInvoice through the bus', () => {
  async function seedQuote(businessId: string): Promise<{ quoteId: string }> {
    const quote = await withBusiness(appDb, businessId, (tx) =>
      ordersRepo.createQuote(tx, {
        businessId,
        customerId: null,
        lines: [
          {
            productId: null,
            name: 'Ankara bale',
            quantity: 3,
            unitPriceK: 400_000,
            lineTotalK: 1_200_000,
          },
        ],
        totalK: 1_200_000,
        validUntil: null,
        clientRef: null,
        sourceId: 'user:test',
      }),
    );
    return { quoteId: quote.id };
  }

  function invoiceInput(businessId: string, quoteId: string): IssueInvoiceInput {
    return {
      businessId,
      quoteId,
      customerId: null,
      items: [{ name: 'Ankara bale', quantity: 3, unitPriceK: 400_000 }],
      totalK: 1_200_000,
      dueDate: null,
      actor: 'user:test',
    };
  }

  it('converts once, replays the answer, and never mints a second invoice', async () => {
    const businessId = await seedBusiness();
    const { quoteId } = await seedQuote(businessId);
    const input = invoiceInput(businessId, quoteId);
    const envelope = {
      businessId,
      command: 'IssueInvoice' as const,
      payload: input,
      actor: 'user:test',
      ingress: 'DASHBOARD' as const,
      idempotencyKey: `quote-convert:${quoteId}`,
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => issueInvoiceWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.result.invoiceNumber).toMatch(/^INV-/);

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => issueInvoiceWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    expect(await count(businessId, 'invoices')).toBe(1);
    /* Render AND payable link, exactly one of each. */
    expect(await count(businessId, 'jobs')).toBe(2);
  });

  it('a convert race without the key loses whole: one invoice, one event', async () => {
    const businessId = await seedBusiness();
    const { quoteId } = await seedQuote(businessId);
    const input = invoiceInput(businessId, quoteId);

    await withBusiness(appDb, businessId, (tx) => issueInvoiceWork(tx, input));
    /* The second hand meets `quoted -> confirmed` already taken, and the
     * refusal rolls its invoice back — the winner's is the only one. */
    await expect(
      withBusiness(appDb, businessId, (tx) => issueInvoiceWork(tx, input)),
    ).rejects.toThrow(QuoteAlreadyTaken);

    expect(await count(businessId, 'invoices')).toBe(1);
    expect(await count(businessId, 'outbox_events')).toBe(1);
  });
});

describe('VoidReceipt: the dashboard two-step (Appendix D)', () => {
  it('refuses without a confirmation, voids with one, and a refusal writes nothing', async () => {
    const businessId = await seedBusiness();
    const sale = await withBusiness(appDb, businessId, (tx) =>
      recordSaleWork(tx, { ...saleInput(businessId), paidK: 0, balanceDueK: 1_000_000 }),
    );

    const input = {
      businessId,
      invoiceNumber: sale.invoiceNumber,
      reason: 'wrong customer',
      actor: 'user:test',
    };
    const envelope = {
      businessId,
      command: 'VoidReceipt' as const,
      payload: input,
      subject: `invoice:${sale.invoiceNumber}`,
      actor: 'user:test',
      ingress: 'DASHBOARD' as const,
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => voidReceiptWork(tx, input)),
    );
    expect(first.outcome).toBe('confirm_first');
    expect(await count(businessId, 'outbox_events', "AND type = 'invoice.voided'")).toBe(0);

    const opened = await withBusiness(appDb, businessId, (tx) =>
      bus.riskPolicy.ask(tx, {
        businessId,
        command: 'VoidReceipt',
        subject: `invoice:${sale.invoiceNumber}`,
        actor: 'user:test',
        ingress: 'DASHBOARD',
        consequence: `${sale.invoiceNumber} will be voided and its posting reversed.`,
        reason: 'wrong customer',
      }),
    );
    const second = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, { ...envelope, confirmationId: opened.id }, () => voidReceiptWork(tx, input)),
    );
    expect(second.outcome).toBe('done');
    if (second.outcome !== 'done') return;
    expect(second.result).toMatchObject({ outcome: 'voided', invoiceNumber: sale.invoiceNumber });
    expect(await count(businessId, 'outbox_events', "AND type = 'invoice.voided'")).toBe(1);
  });

  it('a paid invoice is refused with has_payments, announcing nothing', async () => {
    const businessId = await seedBusiness();
    const sale = await withBusiness(appDb, businessId, (tx) =>
      recordSaleWork(tx, saleInput(businessId)),
    );

    const refused = await withBusiness(appDb, businessId, (tx) =>
      voidReceiptWork(tx, {
        businessId,
        invoiceNumber: sale.invoiceNumber,
        reason: 'testing the refusal',
        actor: 'user:test',
      }),
    );
    expect(refused.outcome).toBe('has_payments');
    expect(await count(businessId, 'outbox_events', "AND type = 'invoice.voided'")).toBe(0);
  });
});

/**
 * G-48: a sale paid at issue ends in its RECEIPT (spec §15, journey C5).
 *
 * The receipt acknowledges the payment `issueSale` already takes: one sale,
 * one invoice, one payment, one verification, one allocation, one posting,
 * one receipt. Nothing here may move money twice.
 */
describe('G-48: a sale paid at issue ends in its receipt', () => {
  const CUSTOMER_TOKEN = 'cus_tok_g48';

  function sale(businessId: string, over: Partial<RecordSaleInput> = {}): RecordSaleInput {
    return { ...saleInput(businessId), customerToken: CUSTOMER_TOKEN, ...over };
  }

  async function rows<T extends Record<string, unknown>>(
    businessId: string,
    query: ReturnType<typeof sql>,
  ): Promise<T[]> {
    const result = await withBusiness(appDb, businessId, (tx) => tx.execute<T>(query));
    return [...result] as T[];
  }

  /** What every account holds for this business, by chart code. */
  async function ledgerByCode(businessId: string): Promise<Record<string, number>> {
    const found = await rows<{ code: string; net: string }>(
      businessId,
      sql`SELECT a.code, SUM(e.debit_k - e.credit_k)::text AS net
          FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
          WHERE e.business_id = ${businessId}::uuid
          GROUP BY a.code`,
    );
    return Object.fromEntries(found.map((r) => [r.code, Number(r.net)]));
  }

  async function renderJobs(businessId: string) {
    return rows<{ payload: Record<string, unknown>; singleton_key: string }>(
      businessId,
      sql`SELECT payload, singleton_key FROM jobs
          WHERE business_id = ${businessId}::uuid AND kind = 'document.render'`,
    );
  }

  it('a sale on credit is unchanged: its invoice, no payment and no receipt', async () => {
    const businessId = await seedBusiness();
    const done = await withBusiness(appDb, businessId, (tx) =>
      recordSaleWork(tx, sale(businessId, { paidK: 0, balanceDueK: 1_000_000 })),
    );

    expect(done).toMatchObject({ paymentId: null, receiptId: null, receiptNumber: null });
    expect(await count(businessId, 'invoices')).toBe(1);
    expect(await count(businessId, 'payments')).toBe(0);
    expect(await count(businessId, 'payment_allocations')).toBe(0);
    expect(await count(businessId, 'payment_verifications')).toBe(0);
    expect(await count(businessId, 'receipts')).toBe(0);
    /* The invoice is the merchant's paper, and only it. */
    const jobs = await renderJobs(businessId);
    expect(jobs.map((j) => j.payload)).toEqual([{ invoiceId: done.invoiceId }]);
    /* It still owes the lot. */
    expect(await ledgerByCode(businessId)).toEqual({ '1100': 1_000_000, '4000': -1_000_000 });
  });

  it('a fully paid sale writes one receipt for its one payment, and queues only it', async () => {
    const businessId = await seedBusiness();
    /* A known customer, so the receipt's customer can be checked too. */
    const customer = await customersRepo.createCustomerWithIdentities(
      appDb,
      businessId,
      CUSTOMER_TOKEN,
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g48' }],
    );
    const done = await withBusiness(appDb, businessId, (tx) =>
      recordSaleWork(tx, sale(businessId, { customerId: customer.id })),
    );

    expect(done.paymentId).not.toBeNull();
    expect(done.receiptId).not.toBeNull();
    expect(done.receiptNumber).toMatch(/^RCT-\d{4}-000001$/);

    expect(await count(businessId, 'invoices')).toBe(1);
    expect(await count(businessId, 'payments')).toBe(1);
    expect(await count(businessId, 'payment_allocations')).toBe(1);
    expect(await count(businessId, 'receipts')).toBe(1);
    expect(
      await count(businessId, 'payment_verifications', "AND source = 'MERCHANT_ATTESTED'"),
    ).toBe(1);
    expect(await count(businessId, 'payment_verifications')).toBe(1);

    const [receipt] = await rows<{
      id: string;
      receipt_number: string;
      payment_id: string;
      invoice_id: string;
      customer_id: string | null;
      amount_k: string;
      currency: string;
    }>(
      businessId,
      sql`SELECT id, receipt_number, payment_id, invoice_id, customer_id, amount_k::text, currency
          FROM receipts WHERE business_id = ${businessId}::uuid`,
    );
    expect(receipt).toMatchObject({
      id: done.receiptId,
      customer_id: customer.id,
      receipt_number: done.receiptNumber,
      payment_id: done.paymentId,
      invoice_id: done.invoiceId,
      amount_k: '1000000',
      currency: 'NGN',
    });

    /* The payment stays what the merchant attested, and nobody verified it. */
    const [payment] = await rows<{ verified: number; initial_confirmation_source: string }>(
      businessId,
      sql`SELECT verified, initial_confirmation_source FROM payments
          WHERE business_id = ${businessId}::uuid`,
    );
    expect(payment).toEqual({ verified: 0, initial_confirmation_source: 'MERCHANT_ATTESTED' });

    /* The receipt is the merchant's paper; the invoice row stays for the books. */
    const jobs = await renderJobs(businessId);
    expect(jobs).toEqual([
      { payload: { receiptId: done.receiptId }, singleton_key: `receipt:${done.receiptId}` },
    ]);
    const [invoice] = await rows<{ status: string; balance_due_k: string }>(
      businessId,
      sql`SELECT status, balance_due_k::text FROM invoices WHERE business_id = ${businessId}::uuid`,
    );
    expect(invoice).toEqual({ status: 'paid', balance_due_k: '0' });
  });

  it('a part-paid sale writes one receipt for what was paid, and the balance stays owed', async () => {
    const businessId = await seedBusiness();
    const done = await withBusiness(appDb, businessId, (tx) =>
      recordSaleWork(tx, sale(businessId, { paidK: 400_000, balanceDueK: 600_000 })),
    );

    expect(await count(businessId, 'invoices')).toBe(1);
    expect(await count(businessId, 'payments')).toBe(1);
    expect(await count(businessId, 'payment_allocations')).toBe(1);
    expect(await count(businessId, 'receipts')).toBe(1);

    const [allocation] = await rows<{ amount_k: string }>(
      businessId,
      sql`SELECT amount_k::text FROM payment_allocations WHERE business_id = ${businessId}::uuid`,
    );
    expect(allocation?.amount_k).toBe('400000');
    const [receipt] = await rows<{ amount_k: string; snapshot_json: Record<string, unknown> }>(
      businessId,
      sql`SELECT amount_k::text, snapshot_json FROM receipts WHERE business_id = ${businessId}::uuid`,
    );
    expect(receipt?.amount_k).toBe('400000');
    expect(receipt?.snapshot_json).toMatchObject({ amountK: 400_000, allocatedK: 400_000 });

    const [invoice] = await rows<{ status: string; paid_k: string; balance_due_k: string }>(
      businessId,
      sql`SELECT status, paid_k::text, balance_due_k::text FROM invoices
          WHERE business_id = ${businessId}::uuid`,
    );
    expect(invoice).toEqual({
      status: 'partially_paid',
      paid_k: '400000',
      balance_due_k: '600000',
    });

    expect((await renderJobs(businessId)).map((j) => j.payload)).toEqual([
      { receiptId: done.receiptId },
    ]);
  });

  it('the receipt moves no money: one posting, exactly the sale the books held before G-48', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      recordSaleWork(tx, sale(businessId, { paidK: 400_000, balanceDueK: 600_000 })),
    );

    /* One ledger transaction for the whole sale: the receipt adds none. */
    expect(await count(businessId, 'ledger_transactions')).toBe(1);
    /* DR Cash 4,000 / DR AR 6,000 / CR Sales Revenue 10,000, and nothing on
     * Bank or anywhere else. A second Cash or Revenue line would show here. */
    expect(await ledgerByCode(businessId)).toEqual({
      '1000': 400_000,
      '1100': 600_000,
      '4000': -1_000_000,
    });
  });

  it('an overpaid sale is receipted for all that arrived, and promises nothing about the excess', async () => {
    /* ₦12,000 stated against a ₦10,000 sale. Overpayment itself is not
     * G-48's to change: the payment row keeps the stated figure and the books
     * the total, as before. The receipt says what arrived (amountK) and what
     * was applied (allocatedK); nothing books, refunds or credits the excess
     * on this path yet (G-49), so the receipt must not promise it. */
    const businessId = await seedBusiness();
    const done = await withBusiness(appDb, businessId, (tx) =>
      recordSaleWork(tx, sale(businessId, { paidK: 1_200_000, balanceDueK: 0 })),
    );

    expect(await count(businessId, 'payments')).toBe(1);
    expect(await count(businessId, 'payment_allocations')).toBe(1);
    expect(await count(businessId, 'receipts')).toBe(1);

    const [payment] = await rows<{ amount_k: string }>(
      businessId,
      sql`SELECT amount_k::text FROM payments WHERE business_id = ${businessId}::uuid`,
    );
    expect(payment?.amount_k).toBe('1200000');
    const [allocation] = await rows<{ amount_k: string }>(
      businessId,
      sql`SELECT amount_k::text FROM payment_allocations WHERE business_id = ${businessId}::uuid`,
    );
    expect(allocation?.amount_k).toBe('1000000');

    const [receipt] = await rows<{
      payment_id: string;
      amount_k: string;
      snapshot_json: Record<string, unknown>;
    }>(
      businessId,
      sql`SELECT payment_id, amount_k::text, snapshot_json FROM receipts
          WHERE business_id = ${businessId}::uuid`,
    );
    expect(receipt?.payment_id).toBe(done.paymentId);
    expect(receipt?.amount_k).toBe('1200000');
    expect(receipt?.snapshot_json).toMatchObject({
      amountK: 1_200_000,
      allocatedK: 1_000_000,
      verified: false,
    });

    /* What the customer reads: the stored snapshot through the real receipt
     * layout, the way render-document builds the PDF from it. */
    const snapshot = receipt!.snapshot_json;
    const printed = layoutReceipt({
      documentNumber: String(snapshot['documentNumber']),
      issuedAt: new Date(String(snapshot['issuedAtIso'])),
      businessName: 'Ada Fashion',
      invoiceNumber: String(snapshot['invoiceNumber']),
      reference: '',
      amountK: Number(snapshot['amountK']),
      allocatedK: Number(snapshot['allocatedK']),
      verified: snapshot['verified'] !== false,
    })
      .map((block) => `${block.text} ${block.value ?? ''}`)
      .join('\n');
    expect(printed).toContain('Amount received ₦12,000');
    expect(printed).toContain(`Applied to ${done.invoiceNumber} ₦10,000`);
    expect(printed).toContain('The remaining ₦2,000 was not applied to this invoice.');
    expect(printed).not.toMatch(/review|refund|credited/i);

    /* And the caption the merchant forwards with it, built from the same
     * snapshot the way deliver-document does: what arrived, never confirmed. */
    const caption = replies.receiptRecordedReady(
      Number(snapshot['amountK']),
      String(snapshot['invoiceNumber']),
      String(snapshot['documentNumber']),
    ).text;
    expect(caption).toBe(
      `Receipt ${done.receiptNumber} for ₦12,000 on ${done.invoiceNumber} is attached. ` +
        'Forward it to your customer.',
    );
    expect(caption).not.toMatch(/confirm|verif|refund|credit/i);

    /* The books, unchanged: one posting, Cash and Revenue at the total. */
    expect(await count(businessId, 'ledger_transactions')).toBe(1);
    expect(await ledgerByCode(businessId)).toEqual({ '1000': 1_000_000, '4000': -1_000_000 });
  });

  it('the receipt snapshot names the money and never the customer', async () => {
    const businessId = await seedBusiness();
    const done = await withBusiness(appDb, businessId, (tx) =>
      recordSaleWork(tx, sale(businessId)),
    );

    const [receipt] = await rows<{ snapshot_json: Record<string, unknown>; doc_hash: string }>(
      businessId,
      sql`SELECT snapshot_json, doc_hash FROM receipts WHERE business_id = ${businessId}::uuid`,
    );
    expect(receipt?.snapshot_json).toEqual({
      documentNumber: done.receiptNumber,
      issuedAtIso: expect.any(String),
      invoiceNumber: done.invoiceNumber,
      amountK: 1_000_000,
      allocatedK: 1_000_000,
      currency: 'NGN',
      verified: false,
    });
    expect(receipt?.doc_hash).toMatch(/^[0-9a-f]{64}$/);
    /* No customer token, name or number, whatever the sale carried. */
    expect(JSON.stringify(receipt?.snapshot_json)).not.toContain(CUSTOMER_TOKEN);
    expect(Object.keys(receipt?.snapshot_json ?? {})).not.toContain('customerToken');
  });

  it('a failure late in the sale takes the receipt and its number down with everything else', async () => {
    const businessId = await seedBusiness();
    /* A deterministic failure at issueSale's LAST write (the invoice audit
     * row), after the payment, verification, allocation, receipt, receipt
     * counter and posting are all written. The trigger belongs to the test:
     * it fires only for THIS business, is dropped before it is created (a
     * run killed mid-test on a persistent database leaves nothing that
     * breaks the next one) and is dropped again whatever happens. */
    /* DDL takes no parameters, so the id goes in as text: a uuid and nothing
     * else, checked first. */
    expect(businessId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const { db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 1 });
    await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g48_fail_issue_audit ON audit_events`);
    await ownerDb.execute(sql`
      CREATE OR REPLACE FUNCTION g48_fail_issue_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.business_id = '${sql.raw(businessId)}'::uuid
           AND NEW.entity = 'invoice' AND NEW.action = 'issued' THEN
          RAISE EXCEPTION 'g48: forced failure after the receipt';
        END IF;
        RETURN NEW;
      END $$`);
    await ownerDb.execute(sql`
      CREATE TRIGGER g48_fail_issue_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION g48_fail_issue_audit()`);
    try {
      const failed = await withBusiness(appDb, businessId, (tx) =>
        recordSaleWork(tx, sale(businessId)),
      ).then(
        () => null,
        (error: unknown) => error as Error & { cause?: unknown },
      );
      /* The driver wraps the database error as "Failed query: …" and keeps
       * the original on `cause`. */
      expect(String(failed) + String(failed?.cause)).toContain(
        'g48: forced failure after the receipt',
      );
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g48_fail_issue_audit ON audit_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g48_fail_issue_audit()`);
      await closeOwner();
    }

    for (const table of [
      'invoices',
      'payments',
      'payment_verifications',
      'payment_allocations',
      'receipts',
      'ledger_transactions',
      'ledger_entries',
      'jobs',
      'outbox_events',
    ]) {
      expect(await count(businessId, table), table).toBe(0);
    }
    expect(await count(businessId, 'doc_counters')).toBe(0);

    /* And the next sale takes the numbers the failed one never kept. */
    const next = await withBusiness(appDb, businessId, (tx) =>
      recordSaleWork(tx, sale(businessId)),
    );
    expect(next.invoiceNumber).toMatch(/-000001$/);
    expect(next.receiptNumber).toMatch(/^RCT-\d{4}-000001$/);
  });

  it('a failure after the receipt render is queued takes the job down with the sale', async () => {
    /* The last write of recordSaleWork (the sale.recorded outbox row), after
     * the receipt render job was enqueued: the job must not survive a sale
     * that did not. Scoped, pre-dropped and dropped exactly like the test
     * above. */
    const businessId = await seedBusiness();
    expect(businessId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const { db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 1 });
    await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g48_fail_sale_outbox ON outbox_events`);
    await ownerDb.execute(sql`
      CREATE OR REPLACE FUNCTION g48_fail_sale_outbox() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.business_id = '${sql.raw(businessId)}'::uuid AND NEW.type = 'sale.recorded' THEN
          RAISE EXCEPTION 'g48: forced failure after the render job';
        END IF;
        RETURN NEW;
      END $$`);
    await ownerDb.execute(sql`
      CREATE TRIGGER g48_fail_sale_outbox BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION g48_fail_sale_outbox()`);
    try {
      const failed = await withBusiness(appDb, businessId, (tx) =>
        recordSaleWork(tx, sale(businessId)),
      ).then(
        () => null,
        (error: unknown) => error as Error & { cause?: unknown },
      );
      expect(String(failed) + String(failed?.cause)).toContain(
        'g48: forced failure after the render job',
      );
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g48_fail_sale_outbox ON outbox_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g48_fail_sale_outbox()`);
      await closeOwner();
    }

    for (const table of ['jobs', 'receipts', 'payments', 'invoices', 'doc_counters']) {
      expect(await count(businessId, table), table).toBe(0);
    }
  });

  it('a replayed or competing yes still makes one sale, one payment and one receipt', async () => {
    const businessId = await seedBusiness();
    const input = sale(businessId);
    const envelope = {
      businessId,
      command: 'RecordSale' as const,
      payload: input,
      actor: 'system',
      ingress: 'CHAT' as const,
      idempotencyKey: 'draft:draft-g48',
    };
    const run = () =>
      withBusiness(appDb, businessId, (tx) =>
        bus.run(tx, envelope, () => recordSaleWork(tx, input)),
      );

    /* Two at once, then a replay. */
    const raced = await Promise.allSettled([run(), run()]);
    expect(raced.some((r) => r.status === 'fulfilled')).toBe(true);
    const replay = await run();
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result.receiptNumber).toMatch(/^RCT-\d{4}-000001$/);

    for (const table of [
      'invoices',
      'payments',
      'payment_verifications',
      'payment_allocations',
      'receipts',
      'ledger_transactions',
    ]) {
      expect(await count(businessId, table), table).toBe(1);
    }
    expect((await renderJobs(businessId)).length).toBe(1);
  });

  it('a later payment recorded by the merchant still numbers its own receipt after the sale one', async () => {
    const businessId = await seedBusiness();
    const done = await withBusiness(appDb, businessId, (tx) =>
      recordSaleWork(tx, sale(businessId, { paidK: 400_000, balanceDueK: 600_000 })),
    );
    const later = await withBusiness(appDb, businessId, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: done.invoiceId,
        amountK: 600_000,
        method: 'cash',
        sourceType: 'dashboard',
        sourceId: done.invoiceNumber,
        actor: 'user:test',
      }),
    );

    expect(later.receiptNumber).toMatch(/^RCT-\d{4}-000002$/);
    expect(later.balanceDueK).toBe(0);
    expect(await count(businessId, 'receipts')).toBe(2);
    expect(await count(businessId, 'payments')).toBe(2);
    /* Its receipt is unchanged in shape: merchant-recorded, never verified. */
    const [snapshot] = await rows<{ snapshot_json: Record<string, unknown> }>(
      businessId,
      sql`SELECT snapshot_json FROM receipts
          WHERE business_id = ${businessId}::uuid AND receipt_number = ${later.receiptNumber}`,
    );
    expect(snapshot?.snapshot_json).toEqual({
      documentNumber: later.receiptNumber,
      issuedAtIso: expect.any(String),
      invoiceNumber: done.invoiceNumber,
      amountK: 600_000,
      allocatedK: 600_000,
      currency: 'NGN',
      verified: false,
    });
  });
});

describe('the announcements reach the production dispatcher', () => {
  it('every event a command emits is a type the dispatcher handles', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) => recordSaleWork(tx, saleInput(businessId)));

    const dispatcher = buildOutboxDispatcher();
    const pass = await dispatcher.runOnce(workerDb);
    expect(pass.failed).toBe(0);
    expect(pass.delivered).toBe(1);
    expect(await outboxRepo.deadEvents(workerDb)).toEqual([]);
  });
});
