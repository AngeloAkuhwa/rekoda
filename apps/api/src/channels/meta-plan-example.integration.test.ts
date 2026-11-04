/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: the plan's own example, end to end. Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  conversationsRepo,
  identity,
  jobsRepo,
  usageRepo,
  withBusiness,
  sql,
  suppliersRepo,
} from '@rekoda/db';
import { PLAN_ALLOWANCES, usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { issueRepo, spendRepo } from '@rekoda/db';
import { decryptFacet } from '@rekoda/core/vault';
import {
  db,
  deps,
  invoiceCount,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

describe("the plan's own example, end to end", () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  const THE_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 100_000,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  /**
   * Post a message and DRAIN the queue, which is what a real worker does.
   *
   * A single `runOnce()` was enough until issuing began enqueuing a render
   * job: the runner takes the oldest due job, so the render would be claimed
   * ahead of the next inbound message and the conversation would silently stop
   * advancing. The test failed in exactly that way, which is the right way for
   * it to fail.
   */
  /**
   * The numbers the books gave this business's one sale, read back rather than written as
   * literals. A sale confirmed now is numbered in the current Lagos year, so a literal year here
   * would fail from 1 January 2027 with nothing broken. The year itself is pinned at the Lagos boundary in
   * packages/db/src/documents/numbering-year-boundary.integration.test.ts.
   */
  async function issuedNumbers(
    businessId: string,
  ): Promise<{ invoice: string; receipt: string | null }> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ invoice: string; receipt: string | null }>(sql`
        SELECT (SELECT invoice_number FROM invoices WHERE business_id = ${businessId}::uuid) AS invoice,
               (SELECT receipt_number FROM receipts WHERE business_id = ${businessId}::uuid) AS receipt`),
    );
    const { invoice, receipt } = [...rows][0]!;
    expect(invoice).toMatch(/^INV-\d{4}-000001$/);
    // One sale, one moment: the receipt that came with it carries the same year.
    if (receipt !== null) expect(receipt).toBe(`RCT-${invoice.slice(4, 8)}-000001`);
    return { invoice, receipt };
  }

  async function send(text: string, wamid: string) {
    await post(messagePayload('2348031234567', wamid, text));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    expect(worked).toBe(true);
    while (worked) worked = await runner.runOnce();
  }

  it('turns a WhatsApp message into a confirmed, balanced, numbered record', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);

    // 1. The sale. CG2: previewed, not saved.
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    expect(stubSender.lastText).toContain('Please check this before I save it');
    expect(stubSender.lastText).toContain('Total: ₦150,000');
    expect(stubSender.lastText).toContain('Balance: ₦50,000');

    // Nothing issued yet — that is the entire point of the gate.
    expect(await invoiceCount(business.id)).toBe(0);

    // 2. The yes. CG3 claims the draft and the engine issues.
    await send('yes', 'wamid.YES');
    expect(stubSender.lastText).toMatch(/Saved ✅ INV-\d{4}-000001 for ₦150,000/);
    expect(stubSender.lastText).toContain('₦50,000 still owed');

    expect(await invoiceCount(business.id)).toBe(1);

    // 3. The books balance, read back out of the database.
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    const credits = entries.reduce((n, e) => n + e.creditK, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(15_000_000);
  });

  /**
   * The same yes, with the RecordSale rollout flag ON (PR-021): the identical
   * record comes out, because the flag changes which gates run around the
   * work and never the work. What the bus adds is visible in the database —
   * the idempotency claim it took for the draft, snapshot completed in the
   * same transaction as the sale it answers for.
   */
  it('the RecordSale flag routes the same yes through the command bus', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);

    const flagged = { ...deps, config: { ...deps.config, commandRecordSale: true } };
    async function sendFlagged(text: string, wamid: string) {
      await post(messagePayload('2348031234567', wamid, text));
      const runner = buildRunner(workerDb, db, flagged);
      let worked = await runner.runOnce();
      expect(worked).toBe(true);
      while (worked) worked = await runner.runOnce();
    }

    await sendFlagged('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await sendFlagged('yes', 'wamid.YES');

    expect(stubSender.lastText).toMatch(/Saved ✅ INV-\d{4}-000001 for ₦150,000/);
    // The bus path names the receipt too (G-48), from the run's own result.
    const { invoice, receipt } = await issuedNumbers(business.id);
    expect(stubSender.lastText).toContain(`Receipt ${receipt} is on its way.`);
    expect(await invoiceCount(business.id)).toBe(1);

    const claims = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ key: string; command_name: string; response_snapshot: unknown }>(
        sql`SELECT key, command_name, response_snapshot FROM idempotency_records
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    const claim = [...claims][0];
    expect([...claims]).toHaveLength(1);
    expect(claim?.command_name).toBe('RecordSale');
    expect(claim?.key).toMatch(/^draft:/);
    expect(claim?.response_snapshot).toMatchObject({
      invoiceNumber: invoice,
      receiptNumber: receipt,
    });
  });

  it('renders and stores the PDF, and it opens', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    // Issuing enqueues the render inside the same transaction, so draining the
    // queue after the confirmation is all it takes. Money was taken with the
    // sale (₦100,000 of ₦150,000), so the paper is its RECEIPT (G-48, journey
    // C5) — one document, not the invoice as well.
    const stored = await withBusiness(db, business.id, (tx) =>
      issueRepo.documentsFor(tx, business.id),
    );
    expect(stored).toHaveLength(1);
    const { receipt } = await issuedNumbers(business.id);
    expect(stored[0]).toMatchObject({ kind: 'receipt_pdf', refNumber: receipt });

    // The key is unguessable — a sequential one would let anyone holding one
    // document's URL walk the merchant's whole sales history by counting.
    expect(stored[0]!.storageKey).toMatch(
      new RegExp(`^documents/${business.id}/receipt_pdf/[0-9a-f]{32}\\.pdf$`),
    );

    // And the bytes are really there, and really a PDF.
    const bytes = await deps.storage.get(stored[0]!.storageKey);
    expect(bytes).not.toBeNull();
    expect(bytes!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes!.length).toBe(stored[0]!.bytes);
  });

  it('DELIVERS the document to the merchant', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    /**
     * The M2 exit criterion, end to end: a message became a confirmed record
     * and the merchant received the paper for it.
     */
    expect(stubSender.documents).toHaveLength(1);
    const sent = stubSender.lastDocument!;

    // Named so a merchant can find it again in three weeks, not by a uuid.
    // Money was taken with the sale, so it is the receipt (G-48, journey C5).
    const { invoice, receipt } = await issuedNumbers(business.id);
    expect(sent.filename).toBe(`${receipt}.pdf`);
    expect(sent.contentType).toBe('application/pdf');
    expect(sent.to).toBe('+2348031234567');
    // The merchant-recorded caption, naming the invoice it was paid against.
    // Never "confirmed": nobody verified this money with a provider (ADR 0014).
    expect(sent.caption).toBe(
      `Receipt ${receipt} for ₦100,000 on ${invoice} is attached. ` +
        'Forward it to your customer.',
    );
    expect(sent.caption).not.toMatch(/confirm|verif/i);

    // The real bytes, not a link — a link would need the PDF to be publicly
    // reachable, which is what the unguessable key exists to avoid.
    expect(sent.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // And the merchant's history shows what they actually received.
    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(messages.some((m) => m.kind === 'media' && m.direction === 'outbound')).toBe(true);
  });

  it('a sale on credit still delivers its INVOICE, and no receipt exists', async () => {
    // Journey C6: nothing was paid, so the invoice is the merchant's paper.
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({ ...THE_SALE, reportedPayment: null });
    await send('Ada bought 3 wigs for 150k, she will pay later', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    expect(stubSender.lastText).toMatch(/Saved ✅ INV-\d{4}-000001 for ₦150,000/);
    expect(stubSender.lastText).not.toContain('Receipt');
    expect(stubSender.documents).toHaveLength(1);
    const { invoice, receipt } = await issuedNumbers(business.id);
    expect(receipt).toBeNull();
    expect(stubSender.lastDocument!.filename).toBe(`${invoice}.pdf`);
    const receipts = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM receipts WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect([...receipts][0]?.n).toBe(0);
  });

  it('the yes for a paid sale names the receipt that follows', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes'));
    // One job: the reply is sent before the render is drained.
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);

    const { invoice, receipt } = await issuedNumbers(business.id);
    expect(stubSender.lastText).toBe(
      `Saved ✅ ${invoice} for ₦150,000.\n₦50,000 still owed.\n` +
        `Receipt ${receipt} is on its way.`,
    );
  });

  it('retries delivery rather than losing the document', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    // Meta is down at the moment the document is ready. Targeted at documents
    // specifically: a one-shot failure would be consumed by the text reply
    // that precedes it, and the delivery would then succeed.
    stubSender.failDocumentsWith();
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes'));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(stubSender.documents).toHaveLength(0);

    /**
     * A failed reply is swallowed; a failed DELIVERY is not. The reply is a
     * sentence the merchant misses — the document is the thing they asked for,
     * and the PDF already exists in storage, so a retry is cheap and is the
     * only way they ever get it.
     */
    const queued = await withBusiness(db, business.id, (tx) =>
      jobsRepo.jobsForBusiness(tx, 'document.deliver'),
    );
    expect(queued[0]).toMatchObject({ state: 'pending', attempts: 1 });

    // The invoice and its PDF survived the delivery failure untouched.
    expect(await invoiceCount(business.id)).toBe(1);
    const stored = await withBusiness(db, business.id, (tx) =>
      issueRepo.documentsFor(tx, business.id),
    );
    expect(stored).toHaveLength(1);
  });

  it('does not render two PDFs for one sale', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    // A second yes finds nothing pending (CG3), so nothing is issued and no
    // second render is enqueued. Two PDFs with two storage keys for one sale
    // is a document a customer could be shown twice at different URLs.
    await send('yes', 'wamid.YES2');

    const stored = await withBusiness(db, business.id, (tx) =>
      issueRepo.documentsFor(tx, business.id),
    );
    expect(stored).toHaveLength(1);
  });

  it('does not issue TWICE when the merchant taps yes twice', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    await send('yes', 'wamid.YES1');
    await send('yes', 'wamid.YES2');

    // CG3. On WhatsApp a double-tap is not an edge case, it is Tuesday.
    expect(await invoiceCount(business.id)).toBe(1);
    // And the second yes is told the truth rather than apologised to.
    expect(stubSender.lastText).toMatch(/nothing waiting for a yes|already saving/i);
  });

  it('questions an arithmetic mismatch instead of previewing it', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({ ...THE_SALE, statedTotal: 120_000, reportedPayment: null });

    await send('Ada bought 3 wigs, total 120k', 'wamid.ODD');

    // CG1 before CG2: a preview of numbers we know are wrong is a request to
    // approve a mistake.
    expect(stubSender.lastText).toContain('do not add up');
    expect(stubSender.lastText).toContain('₦30,000');
    expect(stubSender.lastText).not.toContain('Please check this before I save it');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('lets a correction replace the draft before anything is issued', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    // CG5 — "no, 4 not 3" re-runs the draft rather than mutating anything.
    stubTransport.replyWith({
      ...THE_SALE,
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    await send('no, 4 not 3', 'wamid.FIX');
    expect(stubSender.lastText).toContain('replaced the earlier version');
    expect(stubSender.lastText).toContain('Total: ₦200,000');

    await send('yes', 'wamid.YES');

    // One invoice, for the CORRECTED figure. Confirming the superseded draft
    // would be the failure CG5 exists to prevent.
    expect(await invoiceCount(business.id)).toBe(1);
    const rows = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(rows.map((r) => r.state).sort()).toEqual(['confirmed', 'superseded']);
  });

  it('discards the draft when the merchant says no', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    await send('no', 'wamid.NO');
    expect(stubSender.lastText).toMatch(/cancelled/i);

    // A discarded draft must not be confirmable by an accidental yes later.
    await send('yes', 'wamid.LATE');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('closes an exhausted month with a doorway, not a wall (metering-v1 §3)', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const allowance = PLAN_ALLOWANCES.trial.AI_ACTIONS;
    // The whole trial allowance, spent the atomic way fifty messages would.
    await withBusiness(db, business.id, (tx) =>
      usageRepo.consumeUnit(
        tx,
        business.id,
        usagePeriod(new Date()),
        'AI_ACTIONS',
        allowance,
        allowance,
      ),
    );

    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.EXHAUSTED');

    // Three things, exactly: what ran out, nothing lost, two doors forward.
    expect(stubSender.lastText).toContain(`used all ${allowance} messages`);
    expect(stubSender.lastText).toContain('who owes me');
    expect(stubSender.lastText).toContain('upgrade');
    // And the model was never paid for a refused message.
    expect(stubTransport.requests).toHaveLength(0);

    // Reading stays free FOREVER at zero units — the router tier is not metered.
    await send('help', 'wamid.STILLFREE');
    expect(stubSender.lastText).toContain('Record a sale');
  });

  it('refunds the unit when Rekoda failed, not the merchant (metering-v1)', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    // A reply the border checkpoint rejects: the model ran, Rekoda paid,
    // the merchant got nothing. Their meter must not move.
    stubTransport.replyWith({ intent: 'SomethingUnparseable' });
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.UNUSABLE');
    expect(stubSender.lastText).toContain('could not turn that into a record');

    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows[0]?.used ?? 0).toBe(0);
  });

  it('records an EXPENSE the same way: previewed, confirmed, balanced', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'fuel for generator',
      amount: 12_000,
      category: 'utilities',
      paymentMethod: 'cash',
    });

    // CG2: previewed, nothing in the books yet.
    await send('bought fuel for the gen, 12k', 'wamid.EXP');
    expect(stubSender.lastText).toContain('Expense: fuel for generator');
    expect(stubSender.lastText).toContain('*Amount: ₦12,000*');
    expect(
      await withBusiness(db, business.id, (tx) => spendRepo.expensesFor(tx, business.id)),
    ).toHaveLength(0);

    // The yes. Row + posting land together; the reply claims books, not paper.
    await send('yes', 'wamid.EXPYES');
    expect(stubSender.lastText).toContain('Saved ✅ ₦12,000 expense: fuel for generator');

    const rows = await withBusiness(db, business.id, (tx) =>
      spendRepo.expensesFor(tx, business.id),
    );
    expect(rows).toHaveLength(1);
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'EXPENSES', debitK: 1_200_000 }),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    expect(debits).toBe(entries.reduce((n, e) => n + e.creditK, 0));
  });

  it('records a stock purchase on credit and says what is still owed', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({
      intent: 'RecordPurchase',
      supplierMention: 'Mama Nkechi',
      description: 'ankara fabric',
      amount: 50_000,
      reportedPayment: 20_000,
      paymentMethod: 'cash',
      productMention: null,
      quantity: null,
    });

    await send('bought ankara from Mama Nkechi 50k, paid 20k', 'wamid.PUR');
    expect(stubSender.lastText).toContain('Owing to supplier: ₦30,000');

    await send('yes', 'wamid.PURYES');
    expect(stubSender.lastText).toContain('Saved ✅ ₦50,000 stock purchase');
    expect(stubSender.lastText).toContain('₦30,000 still owed to your supplier');

    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', debitK: 5_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'ACCOUNTS_PAYABLE', creditK: 3_000_000 }),
    );

    /* The supplier's NAME still stops at the preview — what the books keep
     * is a VAULT reference (migration 0050): the expense row points at a
     * supplier whose name exists only as a cipher. */
    const rows = await withBusiness(db, business.id, (tx) =>
      spendRepo.expensesFor(tx, business.id),
    );
    expect(rows[0]?.description).toBe('ankara fabric');
    expect(JSON.stringify(rows)).not.toContain('Nkechi');
    const supplierId = rows[0]?.supplierId;
    expect(supplierId).toBeTruthy();

    const ciphers = await withBusiness(db, business.id, (tx) =>
      suppliersRepo.supplierCiphersFor(tx, business.id, [supplierId!]),
    );
    const cipher = ciphers.get(supplierId!);
    expect(cipher).toBeTruthy();
    /* At rest it is a blob; only the vault key opens it. */
    expect(cipher).not.toContain('Nkechi');
    expect(decryptFacet(cipher!, deps.config.vaultKey, `${business.id}:supplier_name`)).toBe(
      'Mama Nkechi',
    );

    /* The same supplier, said sloppily, folds to the same row. */
    stubTransport.replyWith({
      intent: 'RecordPurchase',
      supplierMention: 'MAMA   nkechi',
      description: 'more ankara',
      amount: 10_000,
      reportedPayment: 10_000,
      paymentMethod: 'cash',
      productMention: null,
      quantity: null,
    });
    await send('bought more ankara from MAMA nkechi 10k paid', 'wamid.PUR2');
    await send('yes', 'wamid.PUR2YES');
    const after = await withBusiness(db, business.id, (tx) =>
      spendRepo.expensesFor(tx, business.id),
    );
    expect(after).toHaveLength(2);
    expect(new Set(after.map((r) => r.supplierId)).size).toBe(1);
  });
});
