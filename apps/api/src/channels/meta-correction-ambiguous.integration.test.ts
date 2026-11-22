/**
 * CG5 inherits a customer only when the correction is unambiguous (OWN-100). Beside
 * `meta-correction-customer.integration.test.ts`, which is at the layout limit.
 *
 * A message that came between the preview and the correction but is still retrying after a
 * failure has no conversation row yet, so `hasInboundBetween` cannot see it; the queue can.
 * While an earlier inbound message of the same business is pending or running, the correction
 * is asked about and changes nothing. Another business's queue never counts, a message that
 * died retires the preview (OWN-74), and a correction mixed with a new sale is asked about
 * (owner review of #437 at 49f2586).
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { identity, settleRepo, sql, withBusiness } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  knownCustomer,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import {
  asTenant,
  failOnceAndBackOff,
  killInboundJob,
  queueOnly,
} from './meta-lost-message.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';

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
const FOUR = {
  ...SALE,
  customer: { kind: 'none' },
  items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
  statedTotal: 200_000,
};

async function send(text: string, wamid: string, from = OWNER) {
  await post(messagePayload(from, wamid, text));
  const runner = buildRunner(workerDb, db, deps);
  let worked = await runner.runOnce();
  expect(worked).toBe(true);
  while (worked) worked = await runner.runOnce();
}

const sales = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string; customer: unknown }>(
      sql`SELECT state, command->'customer' AS customer FROM command_drafts
           WHERE business_id = ${businessId}::uuid AND intent = 'RecordSale'
           ORDER BY insertion_seq`,
    ),
  ).then((rows) => [...rows]);

async function seedOwner(phone = OWNER, name = 'Ada Fashion') {
  const user = await identity.upsertUserByPhone(db, `+${phone}`);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return { business, ada: await knownCustomer(business.id) };
}

/**
 * While an earlier message is live, a nameless correction never keeps Ada, and the preview it
 * corrects is withdrawn rather than left for a retried yes to book (CodeRabbit on #437 at
 * 1db1a0a): nothing waiting names her, and the merchant is asked for the record with its customer.
 */
const invoiceTotals = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ total: string }>(
      sql`SELECT total_k::text AS total FROM invoices WHERE business_id = ${businessId}::uuid`,
    ),
  ).then((rows) => [...rows].map((r) => r.total));

async function expectAdaWithdrawn(businessId: string) {
  const rows = await sales(businessId);
  expect(rows.map((r) => r.state)).toEqual(['superseded']);
}

/** The waiting sale's id and whole command, taken before the correction is sent. */
const saleDraft = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ id: string; command: unknown }>(
      sql`SELECT id, command FROM command_drafts
           WHERE business_id = ${businessId}::uuid AND intent = 'RecordSale' ORDER BY insertion_seq`,
    ),
  ).then((rows) => [...rows]);

/** Ada's preview is waiting, untouched, and still names her: the same draft holding the same
 * command, so no field it would book changed (CodeRabbit on #437 at 88258dc). */
async function expectAdaUntouched(
  businessId: string,
  adaToken: string,
  before: { id: string; command: unknown }[],
) {
  const rows = await sales(businessId);
  expect(rows.map((r) => r.state)).toEqual(['pending']);
  expect(rows[0]?.customer).toEqual({ kind: 'token', token: adaToken });
  expect(before).toHaveLength(1);
  expect(await saleDraft(businessId)).toEqual(before);
}

describe('CG5: a correction sent while an earlier message is still live', () => {
  it('is asked about while the earlier message backs off, and the preview is withdrawn', async () => {
    const { business } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.R1-SALE');

    /* A question after the preview fails once and backs off: it has no conversation row yet. */
    await queueOnly('wamid.R1-Q', 'how much did I sell this month?');
    await failOnceAndBackOff(business.id);

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.R1-FIX');
    expect(stubSender.lastText).toBe(replies.correctionWithdrawn().text);
    await expectAdaWithdrawn(business.id);
    /* Withdrawn, so a yes now books nothing of it. */
    await send('yes', 'wamid.R1-YES');
    expect(await invoiceTotals(business.id)).toEqual([]);
  });

  it('is asked about while the earlier message is running in another lane, and the preview is withdrawn', async () => {
    const { business } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.R2-SALE');
    await queueOnly('wamid.R2-Q', 'how much did I sell this month?');
    /* Claimed by a lane that has not committed anything yet, scheduled after the correction, so the
     * queue's entry check lets the correction pass and only the CG5 check can see it (as the owner:
     * the worker's columns). */
    await asTenant(
      business.id,
      sql`UPDATE jobs SET state = 'running', attempts = 1, locked_by = 'other-lane',
                          locked_at = now(), run_at = now() + interval '1 hour'
           WHERE business_id = ${business.id}::uuid AND state = 'pending'`,
    );

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.R2-FIX');
    expect(stubSender.lastText).toBe(replies.correctionWithdrawn().text);
    await expectAdaWithdrawn(business.id);
    /* Withdrawn, so a yes now books nothing of it. */
    await send('yes', 'wamid.R2-YES');
    expect(await invoiceTotals(business.id)).toEqual([]);
  });

  it("another business's retrying message never blocks this one's correction", async () => {
    const { business, ada } = await seedOwner();
    const other = await seedOwner('2348035550000', 'Other Shop');
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.R3-SALE');
    await queueOnly('wamid.R3-Q', 'how much did I sell this month?', '2348035550000');
    await failOnceAndBackOff(other.business.id);

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.R3-FIX');
    expect(stubSender.lastText).toContain('The same customer as before');
    const rows = await sales(business.id);
    expect(rows.map((r) => r.state)).toEqual(['superseded', 'pending']);
    expect(rows[1]?.customer).toEqual({ kind: 'token', token: ada.token });
  });

  it('a message that died in between retires the preview, so nothing is inherited', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.R4-SALE');
    await queueOnly('wamid.R4-Q', 'cancel');
    await killInboundJob(business.id, 'markFailed');

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.R4-FIX');
    /* OWN-74: the preview pending when the lost message arrived is withdrawn, never confirmable,
     * and no draft of this business names Ada any more except that withdrawn one. */
    const rows = await sales(business.id);
    expect(rows[0]?.state).not.toBe('pending');
    const live = rows.filter((r) => r.state === 'pending');
    expect(
      live.every(
        (r) => JSON.stringify(r.customer) !== JSON.stringify({ kind: 'token', token: ada.token }),
      ),
    ).toBe(true);
  });
});

describe('CG5: a correction mixed with another instruction, or about no field of the sale', () => {
  it.each([
    'No, 4 not 3, and I also sold 2 bags for 20k',
    'No, 4 not 3. Sold 2 bags at 10k to someone else',
    /* A comparison or a figure that changes no field of the sale (CodeRabbit at 49f2586). */
    'Sold 2 bags for 20k; deliver by bike rather than car',
    'No, delivery should be 2 days',
    'balance should be 10k by Friday',
    /* A new sale in any wording (independent review at b5079a8). */
    'Sold 5 bags, 10k each, total should be 50k',
    'Sold 3 wigs @30k, make it 4',
    'Sold 2 bags 20k. Balance should be 5k',
    /* Adding to the sale, or another sale (independent review at 1184521). */
    'make it 5 more',
    'the other should be 5k',
  ])('%j is asked about and the preview keeps its customer', async (text) => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.M-SALE');
    const before = await saleDraft(business.id);
    stubTransport.replyWith(FOUR);
    await send(text, 'wamid.M-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    await expectAdaUntouched(business.id, ada.token, before);
  });
});

describe("CG5: the owner's correction forms keep the customer end to end", () => {
  /* A price correction changes the price and keeps the quantity, so it tests inheritance on a
   * price change, not the quantity case again (CodeRabbit on #437 at 96b1b52). */
  const PRICE = {
    ...SALE,
    customer: { kind: 'none' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 60_000 }],
    statedTotal: 180_000,
  };
  it.each([
    { text: 'make it 4', reading: FOUR, item: { quantity: 4, unitPrice: 50_000 } },
    { text: 'the price should be 60k', reading: PRICE, item: { quantity: 3, unitPrice: 60_000 } },
    { text: '4 wigs instead of 3', reading: FOUR, item: { quantity: 4, unitPrice: 50_000 } },
    { text: 'No, 4 not 3.', reading: FOUR, item: { quantity: 4, unitPrice: 50_000 } },
    /* A named field, which the outer gate missed (Codex and CodeRabbit at fa62d87). */
    { text: 'change the price to 60k', reading: PRICE, item: { quantity: 3, unitPrice: 60_000 } },
  ])('$text corrects the waiting sale and keeps Ada', async ({ text, reading, item }) => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.K-SALE');
    stubTransport.replyWith(reading);
    await send(text, 'wamid.K-FIX');
    expect(stubSender.lastText).toContain('The same customer as before');
    const rows = await sales(business.id);
    expect(rows.map((r) => r.state)).toEqual(['superseded', 'pending']);
    expect(rows[1]?.customer).toEqual({ kind: 'token', token: ada.token });
    const [draft] = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ items: Array<{ quantity: number; unitPrice: number }> }>(
        sql`SELECT command->'items' AS items FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale' AND state = 'pending'`,
      ),
    );
    expect(draft?.items[0]).toMatchObject(item);
  });
});

/**
 * A correction that names somebody in its own words never takes the waiting draft's customer,
 * whatever the model returned for `customer` (OWN-100: "the correction names no other customer";
 * CodeRabbit and the independent review of #437 at ebeeadb). The preview would otherwise say
 * "The same customer as before" over a sale to Ada the merchant meant for Bola.
 */
describe('CG5: a correction that names somebody, read by the model as naming nobody', () => {
  it.each([
    /* Bola is recorded: the gateway issued this message her token. */
    'No, 4 for Bola, not 3',
    '4 Bola not 3',
    /* Tunde is recorded nowhere: the one free word is no word of the sale. */
    'No, 4 for Tunde, not 3',
    'make it 5 Tunde',
  ])('%j is asked about and the preview keeps Ada', async (text) => {
    const { business, ada } = await seedOwner();
    await knownCustomer(business.id, 'Bola', 'CUSTOMER_9B1');
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.N-SALE');
    const before = await saleDraft(business.id);
    stubTransport.replyWith(FOUR);
    await send(text, 'wamid.N-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    expect(stubSender.lastText).not.toContain('The same customer as before');
    await expectAdaUntouched(business.id, ada.token, before);
  });
});

/* The draft's own words that may explain a correction's free word are its items' names only:
 * the model's free text ("when Tunde comes") never does (independent review of #437 at 4480bc2). */
describe("CG5: a name in the waiting draft's free text never explains a correction", () => {
  it('"make it 5 Tunde" after a sale due "when Tunde comes" is asked about', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith({ ...SALE, dueDescription: 'when Tunde comes' });
    await send('Ada bought 3 wigs for 150k, paid 100k, balance when Tunde comes', 'wamid.V-SALE');
    const before = await saleDraft(business.id);
    stubTransport.replyWith(FOUR);
    await send('make it 5 Tunde', 'wamid.V-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    await expectAdaUntouched(business.id, ada.token, before);
  });
});

/**
 * A payment correction that inherits Ada keeps the invoice its preview showed: an invoice number
 * the model wrote that the draft did not carry cannot have come from "no, 60k not 50k", and it may
 * be another customer's (independent review of #437 at ebeeadb). Asked about, nothing booked.
 */
describe('CG5: a payment correction whose reading names another invoice', () => {
  it('is asked about, and neither invoice is paid', async () => {
    const { business, ada } = await seedOwner();
    const bola = await knownCustomer(business.id, 'Bola', 'CUSTOMER_9B1');
    stubTransport.replyWith({ ...SALE, reportedPayment: 0 });
    await send('Ada bought 3 wigs for 150k', 'wamid.P-SA');
    await send('yes', 'wamid.P-SA-YES');
    stubTransport.replyWith({
      ...SALE,
      customer: { kind: 'token', token: bola.token },
      reportedPayment: 0,
    });
    await send('Bola bought 3 wigs for 150k', 'wamid.P-SB');
    await send('yes', 'wamid.P-SB-YES');
    const numbers = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ invoice_number: string; customer_id: string }>(
        sql`SELECT invoice_number, customer_id FROM invoices
             WHERE business_id = ${business.id}::uuid ORDER BY invoice_number`,
      ),
    );
    const adaInvoice = numbers.find((r) => r.customer_id === ada.id)!.invoice_number;
    const bolaInvoice = numbers.find((r) => r.customer_id === bola.id)!.invoice_number;

    const PAY = {
      intent: 'RecordPayment',
      customer: { kind: 'token', token: ada.token },
      amount: 50_000,
      relativeAmount: null,
      documentRef: adaInvoice,
      paymentMethod: 'cash',
    };
    stubTransport.replyWith(PAY);
    await send(`Ada paid 50k on ${adaInvoice}`, 'wamid.P-PAY');
    expect(stubSender.lastText).toContain(`Payment on ${adaInvoice}`);

    stubTransport.replyWith({
      ...PAY,
      customer: { kind: 'none' },
      amount: 60_000,
      documentRef: bolaInvoice,
    });
    await send('no, 60k not 50k', 'wamid.P-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    /* The yes is about the refusal: nothing is booked, and Ada's ₦50,000 preview still waits
     * (CodeRabbit on #437 at 96b1b52). */
    await send('yes', 'wamid.P-YES');
    const paid = () =>
      withBusiness(db, business.id, (tx) => settleRepo.paymentsFor(tx)).then((r) => r.rows);
    expect(await paid()).toHaveLength(0);
    /* The control: the next yes books exactly the preview she was shown, ₦50,000 on her invoice. */
    await send('yes', 'wamid.P-YES2');
    const payments = await paid();
    expect(payments.map((p) => p.amountK)).toEqual([5_000_000]);
    const [adaOwes] = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ balance_due_k: string }>(
        sql`SELECT balance_due_k::text FROM invoices
             WHERE business_id = ${business.id}::uuid AND invoice_number = ${adaInvoice}`,
      ),
    );
    expect(adaOwes?.balance_due_k).toBe('10000000');
    const owed = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ balance_due_k: string }>(
        sql`SELECT balance_due_k::text FROM invoices
             WHERE business_id = ${business.id}::uuid AND invoice_number = ${bolaInvoice}`,
      ),
    );
    expect(owed[0]?.balance_due_k).toBe('15000000');
  });
});

/* The replacement carries the draft's own invoice reference when the correction gives none
 * (OWN-100(1); CodeRabbit on #437 at 3d66867): asserted on the draft, not only through a lookup
 * that would find the same invoice anyway. */
describe('CG5: a payment correction keeps its invoice reference on the replacement draft', () => {
  it('"no, 60k not 50k" keeps the reference Ada\'s preview showed', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith({ ...SALE, reportedPayment: 0 });
    await send('Ada bought 3 wigs for 150k', 'wamid.D-SA');
    await send('yes', 'wamid.D-SA-YES');
    const [invoice] = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ invoice_number: string }>(
        sql`SELECT invoice_number FROM invoices WHERE business_id = ${business.id}::uuid`,
      ),
    );
    const PAY = {
      intent: 'RecordPayment',
      customer: { kind: 'token', token: ada.token },
      amount: 50_000,
      relativeAmount: null,
      documentRef: invoice!.invoice_number,
      paymentMethod: 'cash',
    };
    stubTransport.replyWith(PAY);
    await send(`Ada paid 50k on ${invoice!.invoice_number}`, 'wamid.D-PAY');
    stubTransport.replyWith({
      ...PAY,
      customer: { kind: 'none' },
      amount: 60_000,
      documentRef: null,
    });
    await send('no, 60k not 50k', 'wamid.D-FIX');
    /* The correction replaced the payment: the ₦50,000 draft is superseded and the pending one is
     * the ₦60,000 replacement (CodeRabbit on #437 at d80426e). */
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string; amount: string; ref: string | null; customer: unknown }>(
        sql`SELECT state, command->>'amount' AS amount, command->>'documentRef' AS ref,
                   command->'customer' AS customer
              FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND intent = 'RecordPayment'
             ORDER BY insertion_seq`,
      ),
    ).then((r) => [...r]);
    expect(rows.map((r) => [r.state, r.amount])).toEqual([
      ['superseded', '50000'],
      ['pending', '60000'],
    ]);
    expect(rows[1]?.ref).toBe(invoice!.invoice_number);
    expect(rows[1]?.customer).toEqual({ kind: 'token', token: ada.token });
  });
});

/* OD-67 Option B (owner ruling OWN-103(3), 22 Nov 2026): a correction saying a figure was wrong that
 * the waiting draft does not hold is asked about; the draft, its customer and the books are kept. */
describe('CG5: a replaced figure the waiting draft does not hold (OD-67)', () => {
  const invoices = (businessId: string) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute<{ customer_id: string | null; total: string }>(
        sql`SELECT customer_id, total_k::text AS total FROM invoices
             WHERE business_id = ${businessId}::uuid`,
      ),
    ).then((rows) => [...rows]);

  it('"No, 5 not 4" beside Ada\'s 3 wigs changes nothing, and the yes books her sale once', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.F1-SALE');
    const before = await saleDraft(business.id);

    stubTransport.replyWith({
      ...FOUR,
      items: [{ name: 'wig', quantity: 5, unitPrice: 50_000 }],
      statedTotal: 250_000,
    });
    await send('No, 5 not 4', 'wamid.F1-FIX');
    expect(stubSender.lastText).toBe(replies.correctionFigureNotInDraft().text);
    await expectAdaUntouched(business.id, ada.token, before);
    expect(await invoices(business.id)).toEqual([]);

    /* The first yes answers the question and books nothing; the next books Ada's sale as shown. */
    await send('yes', 'wamid.F1-YES');
    expect(await invoices(business.id)).toEqual([]);
    await send('yes', 'wamid.F1-YES2');
    expect(await invoices(business.id)).toEqual([{ customer_id: ada.id, total: '15000000' }]);
  });

  it('"no, 60k not 40k" beside a 50k-a-wig sale changes nothing', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.F2-SALE');
    const before = await saleDraft(business.id);

    stubTransport.replyWith({
      ...FOUR,
      items: [{ name: 'wig', quantity: 3, unitPrice: 60_000 }],
      statedTotal: 180_000,
    });
    await send('no, 60k not 40k', 'wamid.F2-FIX');
    expect(stubSender.lastText).toBe(replies.correctionFigureNotInDraft().text);
    await expectAdaUntouched(business.id, ada.token, before);
  });

  it('a replaced figure the draft holds still corrects it and keeps Ada, booked once', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.F3-SALE');

    stubTransport.replyWith({
      ...FOUR,
      items: [{ name: 'wig', quantity: 3, unitPrice: 60_000 }],
      statedTotal: 180_000,
    });
    await send('no, ₦60,000 each not ₦50,000', 'wamid.F3-FIX');
    expect(stubSender.lastText).toContain('The same customer as before');
    const rows = await sales(business.id);
    expect(rows.map((r) => r.state)).toEqual(['superseded', 'pending']);
    expect(rows[1]?.customer).toEqual({ kind: 'token', token: ada.token });

    await send('yes', 'wamid.F3-YES');
    await send('yes', 'wamid.F3-YES2');
    expect(await invoices(business.id)).toEqual([{ customer_id: ada.id, total: '18000000' }]);
  });
});
