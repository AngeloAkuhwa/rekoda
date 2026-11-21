/**
 * CG5 corrections keep the customer of the draft they correct (owner ruling, 21 Nov 2026).
 *
 * "No, 4 not 3" names nobody, and the model reads a correction from its own words only, so
 * it cannot know who the sale was for. The customer comes back from the TRUSTED pending
 * draft the correction is about: the newest preview this member was shown, still live, the
 * only one waiting, of the same kind, with no question or refusal since. Never from a
 * token the model wrote: the issued-token guard (G-137) stays the authority, so a token
 * this message was not issued is still refused. Anything less clear is asked about and
 * changes nothing; a correction that comes when nothing is waiting is a new request and
 * inherits nobody.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, identity, settleRepo, sql, withBusiness } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  invoiceCount,
  knownCustomer,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';
const MEMBER = '2348039990001';

const SALE = {
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

/** What a correction that names nobody reads as: the model never saw Ada. */
const NAMELESS = { kind: 'none' } as const;
const FOUR = {
  ...SALE,
  customer: NAMELESS,
  items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
  statedTotal: 200_000,
};

async function seedOwner() {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const ada = await knownCustomer(business.id);
  return { business, ada };
}

async function send(text: string, wamid: string, from = OWNER) {
  await post(messagePayload(from, wamid, text));
  const runner = buildRunner(workerDb, db, deps);
  let worked = await runner.runOnce();
  expect(worked).toBe(true);
  while (worked) worked = await runner.runOnce();
}

const drafts = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ intent: string; state: string; customer: unknown; requested_by: string | null }>(
      sql`SELECT intent, state, command->'customer' AS customer, requested_by
            FROM command_drafts WHERE business_id = ${businessId}::uuid
           ORDER BY insertion_seq`,
    ),
  ).then((rows) => [...rows]);

const invoiceCustomers = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ customer_id: string | null; total_k: string }>(
      sql`SELECT customer_id, total_k::text FROM invoices WHERE business_id = ${businessId}::uuid`,
    ),
  ).then((rows) => [...rows]);

describe('CG5: a correction keeps the customer of the draft it corrects', () => {
  it('"No, 4 not 3" corrects the pending sale for Ada and one corrected invoice is issued', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C1-SALE');

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C1-FIX');
    expect(stubSender.lastText).toContain('replaced the earlier version');
    expect(stubSender.lastText).toContain('Total: ₦200,000');
    // The customer comes from the trusted draft; nothing is decrypted to name them (R12).
    expect(stubSender.lastText).toContain('The same customer as before');
    expect(stubSender.lastText).not.toContain('CUSTOMER_');

    const rows = await drafts(business.id);
    expect(rows.map((r) => r.state)).toEqual(['superseded', 'pending']);
    expect(rows[1]?.customer).toEqual({ kind: 'token', token: ada.token });

    await send('yes', 'wamid.C1-YES');
    // A double-tapped yes (CG3): the superseded draft is not confirmable either.
    await send('yes', 'wamid.C1-YES2');
    expect(await invoiceCount(business.id)).toBe(1);
    expect(await invoiceCustomers(business.id)).toEqual([
      { customer_id: ada.id, total_k: '20000000' },
    ]);
    expect((await drafts(business.id)).map((r) => r.state)).toEqual(['superseded', 'confirmed']);
  });

  it('"No, 4 for Ada, not 3" still corrects it: the name is issued its own token', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C2-SALE');
    stubTransport.replyWith({ ...FOUR, customer: { kind: 'token', token: ada.token } });
    await send('No, 4 for Ada, not 3', 'wamid.C2-FIX');
    expect(stubSender.lastText).toContain('replaced the earlier version');
    await send('yes', 'wamid.C2-YES');
    expect(await invoiceCustomers(business.id)).toEqual([
      { customer_id: ada.id, total_k: '20000000' },
    ]);
  });

  it('a price correction keeps the customer', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C3-SALE');
    stubTransport.replyWith({
      ...SALE,
      customer: NAMELESS,
      items: [{ name: 'wig', quantity: 3, unitPrice: 60_000 }],
      statedTotal: 180_000,
    });
    await send('sorry, 60k each not 50k', 'wamid.C3-FIX');
    expect(stubSender.lastText).toContain('Total: ₦180,000');
    await send('yes', 'wamid.C3-YES');
    expect(await invoiceCustomers(business.id)).toEqual([
      { customer_id: ada.id, total_k: '18000000' },
    ]);
  });

  it('a payment correction keeps the customer and the invoice it was against', async () => {
    const { business, ada } = await seedOwner();
    const bola = await knownCustomer(business.id, 'Bola', 'CUSTOMER_9B1');
    // Two open invoices, Ada's and Bola's: a payment with no customer would not know which.
    stubTransport.replyWith({ ...SALE, reportedPayment: 0 });
    await send('Ada bought 3 wigs for 150k', 'wamid.C4-SA');
    await send('yes', 'wamid.C4-SA-YES');
    stubTransport.replyWith({
      ...SALE,
      customer: { kind: 'token', token: bola.token },
      reportedPayment: 0,
    });
    await send('Bola bought 3 wigs for 150k', 'wamid.C4-SB');
    await send('yes', 'wamid.C4-SB-YES');
    const [adaInvoice] = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ invoice_number: string }>(
        sql`SELECT invoice_number FROM invoices
             WHERE business_id = ${business.id}::uuid AND customer_id = ${ada.id}::uuid`,
      ),
    );

    stubTransport.replyWith({
      intent: 'RecordPayment',
      customer: { kind: 'token', token: ada.token },
      amount: 50_000,
      relativeAmount: null,
      documentRef: adaInvoice!.invoice_number,
      paymentMethod: 'cash',
    });
    await send(`Ada paid 50k on ${adaInvoice!.invoice_number}`, 'wamid.C4-PAY');
    expect(stubSender.lastText).toContain(`Payment on ${adaInvoice!.invoice_number}`);

    stubTransport.replyWith({
      intent: 'RecordPayment',
      customer: NAMELESS,
      amount: 60_000,
      relativeAmount: null,
      documentRef: null,
      paymentMethod: 'cash',
    });
    await send('no, 60k not 50k', 'wamid.C4-FIX');
    expect(stubSender.lastText).toContain('replaced the earlier version');
    expect(stubSender.lastText).toContain(`Payment on ${adaInvoice!.invoice_number}`);
    expect(stubSender.lastText).toContain('Still owing after this: ₦90,000');

    await send('yes', 'wamid.C4-YES');
    const { rows: payments } = await withBusiness(db, business.id, (tx) =>
      settleRepo.paymentsFor(tx),
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]?.amountK).toBe(6_000_000);
    const [owed] = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ invoice_number: string; balance_due_k: string }>(
        sql`SELECT invoice_number, balance_due_k::text FROM invoices
             WHERE business_id = ${business.id}::uuid AND customer_id = ${ada.id}::uuid`,
      ),
    );
    expect(owed?.balance_due_k).toBe('9000000');
  });

  it('a correction that names a different customer is theirs, never Ada’s', async () => {
    const { business } = await seedOwner();
    const bola = await knownCustomer(business.id, 'Bola', 'CUSTOMER_9B1');
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C5-SALE');
    stubTransport.replyWith({ ...SALE, customer: { kind: 'token', token: bola.token } });
    await send('no, it was Bola not Ada', 'wamid.C5-FIX');
    expect(stubSender.lastText).toContain('replaced the earlier version');
    expect(stubSender.lastText).toContain('Bola');
    await send('yes', 'wamid.C5-YES');
    expect(await invoiceCustomers(business.id)).toEqual([
      { customer_id: bola.id, total_k: '15000000' },
    ]);
  });

  it('after the preview expired, a correction is a new request and inherits nobody', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C6-SALE');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
                      WHERE business_id = ${business.id}::uuid`),
    );
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C6-FIX');
    expect(stubSender.lastText).not.toContain('replaced the earlier version');
    expect(stubSender.lastText).not.toContain('Ada');
    const rows = await drafts(business.id);
    expect(rows.map((r) => r.state)).toEqual(['expired', 'pending']);
    expect(rows[1]?.customer).toEqual(NAMELESS);
    await send('yes', 'wamid.C6-YES');
    const issued = await invoiceCustomers(business.id);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.customer_id).not.toBe(ada.id);
  });

  it('after a cancellation, a correction never revives the old draft or its customer', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C7-SALE');
    await send('no', 'wamid.C7-NO');
    expect(stubSender.lastText).toMatch(/cancelled/i);
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C7-FIX');
    expect(stubSender.lastText).not.toContain('Ada');
    const rows = await drafts(business.id);
    // A "no" closes the preview as superseded; nothing brings it back.
    expect(rows[0]?.state).toBe('superseded');
    expect(rows.at(-1)?.customer).toEqual(NAMELESS);
    await send('yes', 'wamid.C7-YES');
    const issued = await invoiceCustomers(business.id);
    expect(issued.every((i) => i.customer_id !== ada.id)).toBe(true);
  });

  it('after a refusal, a nameless correction is asked about and the preview is left as it was', async () => {
    const { business } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C8-SALE');
    // A record carrying a token nobody issued: refused (G-137), recorded as a refusal.
    stubTransport.replyWith({ ...SALE, customer: { kind: 'token', token: 'CUSTOMER_Z99' } });
    await send('sold 2 wigs for 100k', 'wamid.C8-REFUSED');
    expect(stubSender.lastText).toContain('I could not tell which customer');

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C8-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    expect(stubSender.lastText).not.toContain('replaced the earlier version');
    const sale = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sale.map((r) => r.state)).toEqual(['pending']);
    // The yes after it is about the refusal, never a post of the preview behind it.
    await send('yes', 'wamid.C8-YES');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('after a question, a nameless correction is asked about, never applied', async () => {
    const { business } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C9-SALE');
    stubTransport.replyWith({
      intent: 'Query',
      topic: 'sales_summary',
      customer: null,
      period: 'month',
      periodText: null,
      format: 'chat',
    });
    await send('how much did I sell this month?', 'wamid.C9-Q');
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C9-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const sale = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sale.map((r) => r.state)).toEqual(['pending']);
    expect(await invoiceCount(business.id)).toBe(0);
  });

  /* CodeRabbit on #437 at 3ec6a0d: "who owes me" is answered by the router and writes no draft,
   * so the draft-based question check never saw it. */
  it('after a free "who owes me", a nameless correction is asked about, never applied', async () => {
    const { business } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C9b-SALE');
    await send('who owes me', 'wamid.C9b-Q');
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C9b-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const sale = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sale.map((r) => r.state)).toEqual(['pending']);
    expect(await invoiceCount(business.id)).toBe(0);
  });

  /* The merchant thread is shared by every member, so another member's message in between makes
   * the correction a question too: asked about, never applied (CodeRabbit on #437). */
  it("another member's message in between makes a nameless correction a question", async () => {
    const { business } = await seedOwner();
    const member = await identity.upsertUserByPhone(db, `+${MEMBER}`);
    await identity.addMembership(db, business.id, member.id, 'delegate');
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C9c-SALE');
    await send('help', 'wamid.C9c-HELP', MEMBER);
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C9c-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const sale = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sale.map((r) => r.state)).toEqual(['pending']);
  });

  it("another member's correction never inherits the owner's draft", async () => {
    const { business } = await seedOwner();
    const member = await identity.upsertUserByPhone(db, `+${MEMBER}`);
    await identity.addMembership(db, business.id, member.id, 'delegate');
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C10-SALE');

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C10-FIX', MEMBER);
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const rows = await drafts(business.id);
    const sales = rows.filter((r) => r.intent === 'RecordSale');
    // The owner's preview is untouched, and the member holds no draft naming Ada.
    expect(sales.map((r) => r.state)).toEqual(['pending']);
    expect(rows.filter((r) => r.requested_by === member.id && r.intent !== 'Unclear')).toEqual([]);
  });

  it('a new sale that only contains "not" never takes the waiting sale’s customer', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C12-SALE');
    stubTransport.replyWith({
      ...SALE,
      customer: NAMELESS,
      items: [{ name: 'bag', quantity: 2, unitPrice: 10_000 }],
      statedTotal: 20_000,
      reportedPayment: 0,
    });
    await send('Sold 2 bags for 20k, not paid yet', 'wamid.C12-NEW');
    // Not clearly a correction of Ada's sale: asked about, and Ada's preview is untouched.
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const sales = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sales.map((r) => r.state)).toEqual(['pending']);
    expect(sales[0]?.customer).toEqual({ kind: 'token', token: ada.token });
  });

  it('a correction the model could not read leaves the waiting preview as it was', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C13-SALE');
    // What a real model most often makes of "No, 4 not 3" without the earlier turn.
    stubTransport.replyWith({ intent: 'Unclear', clarification: 'Four of what?' });
    await send('No, 4 not 3', 'wamid.C13-FIX');
    const sales = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sales.map((r) => r.state)).toEqual(['pending']);
    expect(sales[0]?.customer).toEqual({ kind: 'token', token: ada.token });
  });

  it.each([
    ['Wait, I also sold 2 bags for 20k', 'wamid.C14a'],
    ['actually, sold 2 bags for 20k', 'wamid.C14b'],
  ])('%j is not a correction of the waiting sale and takes nobody', async (text, wamid) => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', `${wamid}-SALE`);
    stubTransport.replyWith({
      ...SALE,
      customer: NAMELESS,
      items: [{ name: 'bag', quantity: 2, unitPrice: 10_000 }],
      statedTotal: 20_000,
      reportedPayment: 0,
    });
    await send(text, wamid);
    expect(stubSender.lastText).not.toContain('Ada');
    const sales = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sales.map((r) => r.state)).toEqual(['pending']);
    expect(sales[0]?.customer).toEqual({ kind: 'token', token: ada.token });
  });

  it('with two previews waiting, a nameless correction is asked about', async () => {
    const { business } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C15-SALE');
    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'diesel',
      amount: 12_000,
      category: 'fuel',
      paymentMethod: 'cash',
    });
    await send('diesel 12k cash', 'wamid.C15-EXP');
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C15-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const states = (await drafts(business.id))
      .filter((r) => r.intent !== 'Unclear')
      .map((r) => `${r.intent}:${r.state}`);
    expect(states).toEqual(['RecordSale:pending', 'RecordExpense:pending']);
  });

  it('a correction of a different kind is asked about, never given the sale’s customer', async () => {
    const { business } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C16-SALE');
    stubTransport.replyWith({
      intent: 'RecordPayment',
      customer: NAMELESS,
      amount: 60_000,
      relativeAmount: null,
      documentRef: null,
      paymentMethod: 'cash',
    });
    await send('no, she paid 60k not 50k', 'wamid.C16-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const sales = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sales.map((r) => r.state)).toEqual(['pending']);
  });

  it("another member's nameless correction never replaces an invoice-only payment preview", async () => {
    const { business } = await seedOwner();
    const member = await identity.upsertUserByPhone(db, `+${MEMBER}`);
    await identity.addMembership(db, business.id, member.id, 'delegate');
    stubTransport.replyWith({ ...SALE, reportedPayment: 0 });
    await send('Ada bought 3 wigs for 150k', 'wamid.C17-SA');
    await send('yes', 'wamid.C17-SA-YES');
    const [invoice] = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ invoice_number: string }>(
        sql`SELECT invoice_number FROM invoices WHERE business_id = ${business.id}::uuid`,
      ),
    );
    const pay = (amount: number, documentRef: string | null) => ({
      intent: 'RecordPayment',
      customer: NAMELESS,
      amount,
      relativeAmount: null,
      documentRef,
      paymentMethod: 'cash',
    });
    stubTransport.replyWith(pay(50_000, invoice!.invoice_number));
    await send(`${invoice!.invoice_number} paid 50k`, 'wamid.C17-PAY');
    expect(stubSender.lastText).toContain(`Payment on ${invoice!.invoice_number}`);

    stubTransport.replyWith(pay(60_000, null));
    await send('no, 60k not 50k', 'wamid.C17-FIX', MEMBER);
    const payments = (await drafts(business.id)).filter((r) => r.intent === 'RecordPayment');
    expect(payments.map((r) => r.state)).toEqual(['pending']);
  });

  it('a clarification still waiting counts as a second draft, so the correction is asked about', async () => {
    const { business } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C18-SALE');
    stubTransport.replyWith({ intent: 'Unclear', clarification: 'Which bags?' });
    await send('and the bags', 'wamid.C18-Q');
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C18-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const sales = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sales.map((r) => r.state)).toEqual(['pending']);
  });

  it('an expired preview the sweep has not reached does not count as a second draft', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'diesel',
      amount: 12_000,
      category: 'fuel',
      paymentMethod: 'cash',
    });
    await send('diesel 12k cash', 'wamid.C19-EXP');
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C19-SALE');
    // The expense's window closes after the sale arrived, so no sweep has marked it yet.
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
                      WHERE business_id = ${business.id}::uuid AND intent = 'RecordExpense'`),
    );
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C19-FIX');
    expect(stubSender.lastText).toContain('replaced the earlier version');
    const sales = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sales.at(-1)?.customer).toEqual({ kind: 'token', token: ada.token });
  });

  it('a nameless sale correction never replaces an invoice-only payment preview', async () => {
    const { business } = await seedOwner();
    stubTransport.replyWith({ ...SALE, reportedPayment: 0 });
    await send('Ada bought 3 wigs for 150k', 'wamid.C20-SA');
    await send('yes', 'wamid.C20-SA-YES');
    const [invoice] = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ invoice_number: string }>(
        sql`SELECT invoice_number FROM invoices WHERE business_id = ${business.id}::uuid`,
      ),
    );
    stubTransport.replyWith({
      intent: 'RecordPayment',
      customer: NAMELESS,
      amount: 50_000,
      relativeAmount: null,
      documentRef: invoice!.invoice_number,
      paymentMethod: 'cash',
    });
    await send(`${invoice!.invoice_number} paid 50k`, 'wamid.C20-PAY');
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C20-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const payments = (await drafts(business.id)).filter((r) => r.intent === 'RecordPayment');
    expect(payments.map((r) => r.state)).toEqual(['pending']);
  });

  it.each([
    [
      'a refusal, even one already answered',
      async () => {
        stubTransport.replyWith({ ...SALE, customer: { kind: 'token', token: 'CUSTOMER_Z99' } });
        await send('sold 2 wigs for 100k', 'wamid.C21-R');
      },
    ],
    [
      'a question, even one a yes has retired',
      async () => {
        stubTransport.replyWith({
          intent: 'Query',
          topic: 'sales_summary',
          customer: null,
          period: 'month',
          periodText: null,
          format: 'chat',
        });
        await send('how much did I sell this month?', 'wamid.C21-Q');
      },
    ],
  ])('after %s, a nameless correction is still asked about', async (_why, between) => {
    const { business } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C21-SALE');
    await between();
    // The yes answers what came between and leaves the sale waiting.
    await send('yes', 'wamid.C21-YES');
    expect(await invoiceCount(business.id)).toBe(0);
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.C21-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const sales = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sales.map((r) => r.state)).toEqual(['pending']);
  });

  it('a token the model wrote is still refused on a correction (G-137)', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.C11-SALE');
    // The earlier sale's own token, copied into a correction that names nobody.
    stubTransport.replyWith({ ...FOUR, customer: { kind: 'token', token: ada.token } });
    await send('No, 4 not 3', 'wamid.C11-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const sales = (await drafts(business.id)).filter((r) => r.intent === 'RecordSale');
    expect(sales.map((r) => r.state)).toEqual(['pending']);
    // The preview it left stays the one a yes would confirm, never a corrected copy.
    expect(sales[0]?.customer).toEqual({ kind: 'token', token: ada.token });
    const pending = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(pending.filter((d) => d.state === 'pending' && d.intent === 'RecordSale')).toHaveLength(
      1,
    );
  });
});
