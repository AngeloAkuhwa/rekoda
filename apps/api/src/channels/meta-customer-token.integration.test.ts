/**
 * Which customer a message may name, end to end (owner directive on #437, 20 Nov 2026).
 *
 * G-137: a record names a customer only by a token this message was issued. The model
 * sees tokens as opaque and only this message's, so any other well-formed token is
 * invented or copied, and it may be another real customer's: a payment would be
 * previewed against their invoice and a "yes" would post it there. Token syntax is
 * not authority, so nothing is drafted.
 *
 * G-135 part 2 (BA-OD-3): a phone or email nobody recorded creates no customer when
 * the message is only a question. It stands as a provisional token until a record
 * needs the customer, and a question names nobody by it.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, identity, issueRepo, sql, withBusiness } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  photoPayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { drain, voicePayload } from './meta-voice-note.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';
const DELEGATE = '2348035550000';

async function seedMerchant() {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  return identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
}

async function say(wamid: string, command: unknown, text: string) {
  stubTransport.replyWith(command);
  await post(messagePayload(OWNER, wamid, text));
  await drain();
}

async function plain(wamid: string, text: string) {
  await post(messagePayload(OWNER, wamid, text));
  await drain();
}

const footprint = (businessId: string) =>
  withBusiness(db, businessId, async (tx) => {
    const [row] = [
      ...(await tx.execute<{
        customers: number;
        drafts: number;
        invoices: number;
        payments: number;
      }>(sql`
        SELECT (SELECT count(*)::int FROM customers WHERE business_id = ${businessId}::uuid) AS customers,
               (SELECT count(*)::int FROM command_drafts
                 WHERE business_id = ${businessId}::uuid AND intent NOT IN ('Query', 'Unclear')) AS drafts,
               (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
               (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}::uuid) AS payments`)),
    ];
    return row!;
  });

const sale = (customer: Record<string, unknown>) => ({
  intent: 'RecordSale',
  customer,
  items: [{ name: 'wig', quantity: 2, unitPrice: 50_000 }],
  statedTotal: 100_000,
  reportedPayment: 0,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
});

const payment = (customer: Record<string, unknown>) => ({
  intent: 'RecordPayment',
  customer,
  amount: 20_000,
  relativeAmount: null,
  documentRef: null,
  paymentMethod: 'cash',
});

const balanceOf = (customer: Record<string, unknown> | null) => ({
  intent: 'Query',
  topic: 'customer_balance',
  customer,
  period: 'month',
  periodText: null,
  format: 'chat',
});

const lastModelText = () => stubTransport.requests.at(-1)?.userText ?? '';

/** One ₦100,000 unpaid invoice to `token`. */
async function invoiceTo(businessId: string, token: string) {
  await withBusiness(db, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: token,
      items: [{ name: 'wig', quantity: 2, unitPriceK: 5_000_000 }],
      subtotalK: 10_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 10_000_000,
      paidK: 0,
      balanceDueK: 10_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-${token}`,
      actor: 'system',
    }),
  );
}

describe('a record names a customer only by a token this message was issued (G-137)', () => {
  it("a payment carrying another customer's real token is not drafted and cannot be confirmed", async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    await invoiceTo(business.id, bola.token);
    const before = await footprint(business.id);

    /* The message names Ada; the model hands back Bola's token. */
    await say('wamid.T1', payment({ kind: 'token', token: bola.token }), 'Ada paid 20k');

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await footprint(business.id)).toEqual(before);
    await plain('wamid.T1-yes', 'yes');
    expect(await footprint(business.id)).toEqual(before);
  });

  it('a sale carrying a token nobody issued is not drafted', async () => {
    const business = await seedMerchant();
    const before = await footprint(business.id);

    await say('wamid.T2', sale({ kind: 'token', token: 'CUSTOMER_7K2' }), 'sold 2 wigs for 100k');

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await footprint(business.id)).toEqual(before);
  });

  it('a known customer typed in the message still previews and confirms', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');

    await say(
      'wamid.T3',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    expect(lastModelText()).toContain(ada.token);
    expect(stubSender.lastText).not.toContain('could not tell which customer');
    await plain('wamid.T3-yes', 'yes');

    expect((await footprint(business.id)).invoices).toBe(1);
  });
});

describe('a phone or email nobody recorded creates no customer until a record needs one (G-135)', () => {
  it('a balance question about an unknown phone number creates nothing and names nobody', async () => {
    const business = await seedMerchant();
    const before = await footprint(business.id);

    await say(
      'wamid.P1',
      balanceOf({ kind: 'token', token: 'CUSTOMER_U01' }),
      'how much does 08039998888 owe me',
    );

    expect(lastModelText()).toContain('CUSTOMER_U01');
    expect(lastModelText()).not.toContain('08039998888');
    expect(stubSender.lastText).toContain('do not have a customer by that name');
    expect(await footprint(business.id)).toEqual(before);
  });

  it('a balance question about a known phone number is answered for that customer', async () => {
    const business = await seedMerchant();
    const known = await deps.gateway.tokenise(business.id, 'call 08039998888');
    const token = [...known.tokens.keys()].find((t) => t.startsWith('CUSTOMER_'))!;
    await invoiceTo(business.id, token);
    const before = await footprint(business.id);

    await say('wamid.P2', balanceOf({ kind: 'token', token }), 'how much does 08039998888 owe me');

    expect(stubSender.lastText).toContain('₦100,000 in total');
    expect(await footprint(business.id)).toEqual(before);
  });

  it('an unclear message with an unknown email creates nothing', async () => {
    const business = await seedMerchant();
    const before = await footprint(business.id);

    await say(
      'wamid.P3',
      { intent: 'Unclear', clarification: 'What would you like me to do?' },
      'ada.obi@example.com',
    );

    expect(await footprint(business.id)).toEqual(before);
  });

  it('a sale to an unknown phone number creates the customer and carries their stored token', async () => {
    const business = await seedMerchant();

    await say(
      'wamid.P4',
      sale({ kind: 'token', token: 'CUSTOMER_U01' }),
      'sold 2 wigs to 08039998888 for 100k',
    );

    expect((await footprint(business.id)).customers).toBe(1);
    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraftToAnswer(tx, business.id, { asOf: new Date() }),
    );
    const customer = (draft?.command as { customer?: { token?: string } }).customer;
    expect(customer?.token).toMatch(/^CUSTOMER_/);
    expect(customer?.token).not.toBe('CUSTOMER_U01');
    /* The preview reads the phone back to the merchant, never the token. */
    expect(stubSender.lastText).not.toContain('CUSTOMER_');

    await plain('wamid.P4-yes', 'yes');
    expect(await footprint(business.id)).toMatchObject({ customers: 1, invoices: 1 });
    const snapshot = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ token: string }>(
        sql`SELECT snapshot_json ->> 'customerToken' AS token FROM invoices
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect([...snapshot][0]?.token).toBe(customer?.token);
  });

  it('an unknown phone asked about and then sold to becomes one customer, at the sale', async () => {
    const business = await seedMerchant();

    await say(
      'wamid.P5a',
      balanceOf({ kind: 'token', token: 'CUSTOMER_U01' }),
      'how much does 08039998888 owe me',
    );
    expect((await footprint(business.id)).customers).toBe(0);
    await say(
      'wamid.P5b',
      sale({ kind: 'token', token: 'CUSTOMER_U01' }),
      'sold 2 wigs to 08039998888 for 100k',
    );
    expect((await footprint(business.id)).customers).toBe(1);
  });

  /* Independent review of e15b63a: a record that names no customer needs none, so a
   * phone that is only part of its words creates nobody. */
  it('an expense that only mentions an unknown phone creates no customer', async () => {
    const business = await seedMerchant();
    const before = await footprint(business.id);

    await say(
      'wamid.P6',
      {
        intent: 'RecordExpense',
        description: 'plumber',
        amount: 5_000,
        category: 'repairs',
        paymentMethod: 'cash',
      },
      'paid plumber 08039998888 5k cash',
    );

    expect((await footprint(business.id)).customers).toBe(before.customers);
  });

  /* Independent review of e15b63a: a refused record leaves no customer behind. */
  it('a sale refused for an invented token creates no customer from the unknown phone in it', async () => {
    const business = await seedMerchant();
    const before = await footprint(business.id);

    await say(
      'wamid.P7',
      sale({ kind: 'token', token: 'CUSTOMER_7K2' }),
      'sold 2 wigs to 08039998888 for 100k',
    );

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await footprint(business.id)).toEqual(before);
  });

  /* Owner review of #437 at 3a60b0f: a phone the model copied into a free-text field is
   * part of the record's words, not the customer of a record. Until 3a60b0f this created
   * a customer (the token was anywhere in the serialised command); now the words keep a
   * placeholder and nobody is created. */
  it('a provisional token copied into an expense description creates no customer and reads [phone]', async () => {
    const business = await seedMerchant();
    const before = await footprint(business.id);

    await say(
      'wamid.P8',
      {
        intent: 'RecordExpense',
        description: 'repairs for CUSTOMER_U01',
        amount: 5_000,
        category: 'repairs',
        paymentMethod: 'cash',
      },
      'paid 5k cash for repairs for 08039998888',
    );

    expect(stubSender.lastText).not.toContain('CUSTOMER_');
    expect(stubSender.lastText).toContain('repairs for [phone]');
    expect((await footprint(business.id)).customers).toBe(before.customers);
    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraftToAnswer(tx, business.id, { asOf: new Date() }),
    );
    expect((draft?.command as { description?: string }).description).toBe('repairs for [phone]');

    await plain('wamid.P8-yes', 'yes');
    expect((await footprint(business.id)).customers).toBe(before.customers);
    expect(await identitiesOf(business.id)).toEqual([]);
    expect(await plaintextIn(business.id, ['8039998888', 'CUSTOMER_U'])).toEqual([]);
  });
});

/** Every phone or email identity this business holds, by facet. */
const identitiesOf = (businessId: string) =>
  withBusiness(db, businessId, async (tx) =>
    [
      ...(await tx.execute<{ facet: string }>(sql`
        SELECT facet FROM customer_identities
         WHERE business_id = ${businessId}::uuid AND facet IN ('phone', 'email')
         ORDER BY facet`)),
    ].map((r) => r.facet),
  );

/**
 * The tables a record's words reach, each searched as text for every needle: the
 * books (expenses, invoices, their items, payments, the ledger), the drafts, the
 * conversation history, orders and suppliers. Names the tables holding a needle.
 */
async function plaintextIn(businessId: string, needles: readonly string[]): Promise<string[]> {
  const tables = [
    'expenses',
    'invoices',
    'invoice_items',
    'payments',
    'ledger_transactions',
    'ledger_entries',
    'command_drafts',
    'conversation_messages',
    'orders',
    'suppliers',
  ];
  const found: string[] = [];
  await withBusiness(db, businessId, async (tx) => {
    for (const table of tables) {
      for (const needle of needles) {
        const [row] = [
          ...(await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} t
                 WHERE t.business_id = ${businessId}::uuid
                   AND t::text LIKE ${'%' + needle + '%'}`,
          )),
        ];
        if ((row?.n ?? 0) > 0) found.push(`${table}:${needle}`);
      }
    }
  });
  return found;
}

/**
 * Customer creation follows the record's meaning, not where a token landed (owner
 * review of #437 at 3a60b0f). Only the customer of a sale, payment or order is a
 * customer; a phone or email anywhere else in a record's words is kept out of the
 * books as [phone] or [email] and creates nobody. The one exception is PR #77's
 * owner rule: a second facet typed beside a record's customer is ASKED about in the
 * preview ("same customer?"), so it is created only where that question is asked.
 */
describe('customer creation follows the record, not the token (owner review of #437)', () => {
  it('a supplier phone on a purchase creates no customer', async () => {
    const business = await seedMerchant();

    await say(
      'wamid.S1',
      {
        intent: 'RecordPurchase',
        supplierMention: 'Musa CUSTOMER_U01',
        description: 'cement from CUSTOMER_U01',
        amount: 40_000,
        reportedPayment: 40_000,
        paymentMethod: 'cash',
        productMention: null,
        quantity: null,
        supplierReference: null,
      },
      'bought cement from Musa 08039998888 for 40k cash',
    );
    expect(stubSender.lastText).not.toContain('CUSTOMER_');
    await plain('wamid.S1-yes', 'yes');

    expect((await footprint(business.id)).customers).toBe(0);
    expect(await identitiesOf(business.id)).toEqual([]);
    expect(await plaintextIn(business.id, ['8039998888', 'CUSTOMER_U'])).toEqual([]);
  });

  it('suppliers known only by phone are never merged into one supplier called [phone]', async () => {
    const business = await seedMerchant();
    const purchase = (supplierMention: string) => ({
      intent: 'RecordPurchase',
      supplierMention,
      description: 'cement',
      amount: 40_000,
      reportedPayment: 40_000,
      paymentMethod: 'cash',
      productMention: null,
      quantity: null,
      supplierReference: null,
    });

    await say('wamid.S9a', purchase('CUSTOMER_U01'), 'bought cement from 08039998888 for 40k cash');
    await plain('wamid.S9a-yes', 'yes');
    await say('wamid.S9b', purchase('CUSTOMER_U01'), 'bought cement from 08037776666 for 40k cash');
    await plain('wamid.S9b-yes', 'yes');
    await say(
      'wamid.S9c',
      purchase('Musa CUSTOMER_U01'),
      'bought cement from Musa 08035554444 for 40k cash',
    );
    await plain('wamid.S9c-yes', 'yes');

    const suppliers = await withBusiness(
      db,
      business.id,
      async (tx) =>
        [
          ...(await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM suppliers WHERE business_id = ${business.id}::uuid`,
          )),
        ][0]!.n,
    );
    /* Musa is one supplier; the two known only by number are none, never one shared. */
    expect(suppliers).toBe(1);
  });

  it('a second facet beside a sale customer creates nobody when no preview asks about it', async () => {
    const business = await seedMerchant();

    /* The stated total disagrees with the items, so the answer is an arithmetic
     * question, not a preview, and "same customer?" is never asked. */
    await say(
      'wamid.S10',
      { ...sale({ kind: 'token', token: 'CUSTOMER_U01' }), statedTotal: 90_000 },
      'Ada 08039998888 ada.obi@example.com bought 2 wigs, total 90k',
    );
    expect(stubSender.lastText).not.toContain('same customer');
    expect(await identitiesOf(business.id)).toEqual(['phone']);
  });

  it("a contact in an order's note is not the order's customer", async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');

    await say(
      'wamid.S2',
      {
        intent: 'RecordOrder',
        customer: { kind: 'token', token: bola.token },
        items: [{ name: 'wig', quantity: 1 }],
        note: 'deliver to her cousin CUSTOMER_U01',
      },
      'Bola Ige wants 1 wig, deliver to her cousin 08039998888',
    );

    expect(stubSender.lastText).not.toContain('same customer');
    expect((await footprint(business.id)).customers).toBe(1);
    expect(await identitiesOf(business.id)).toEqual([]);
    expect(await plaintextIn(business.id, ['8039998888', 'CUSTOMER_U'])).toEqual([]);
  });

  it("a known customer's phone pays against that customer's invoice and creates nobody", async () => {
    const business = await seedMerchant();
    const known = await deps.gateway.tokenise(business.id, 'call 08039998888');
    const token = [...known.tokens.keys()].find((t) => t.startsWith('CUSTOMER_'))!;
    await invoiceTo(business.id, token);
    const before = await footprint(business.id);

    await say('wamid.S3', payment({ kind: 'token', token }), '08039998888 paid 20k cash');
    expect(stubSender.lastText).not.toContain('could not tell which customer');
    await plain('wamid.S3-yes', 'yes');

    expect(await footprint(business.id)).toMatchObject({
      customers: before.customers,
      payments: before.payments + 1,
    });
  });

  it('a payment from an unknown phone becomes that one customer, never two', async () => {
    const business = await seedMerchant();

    await say(
      'wamid.S4',
      payment({ kind: 'token', token: 'CUSTOMER_U01' }),
      '08039998888 paid 20k cash',
    );

    expect((await footprint(business.id)).customers).toBe(1);
    expect(await identitiesOf(business.id)).toEqual(['phone']);
    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraftToAnswer(tx, business.id, { asOf: new Date() }),
    );
    expect(JSON.stringify(draft?.command ?? {})).not.toContain('CUSTOMER_U');
  });

  it('an invoice to an unknown email is issued to the customer that email became', async () => {
    const business = await seedMerchant();

    await say(
      'wamid.S5',
      sale({ kind: 'token', token: 'CUSTOMER_U01' }),
      'sold 2 wigs to ada.obi@example.com for 100k, she will pay later',
    );
    expect(await identitiesOf(business.id)).toEqual(['email']);
    await plain('wamid.S5-yes', 'yes');

    expect(await footprint(business.id)).toMatchObject({ customers: 1, invoices: 1 });
    const [row] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<{ token: string; due: string }>(
          sql`SELECT snapshot_json ->> 'customerToken' AS token, balance_due_k::text AS due
                FROM invoices WHERE business_id = ${business.id}::uuid`,
        ),
      )),
    ];
    expect(row?.token).toMatch(/^CUSTOMER_[0-9A-Z]{3,}$/);
    expect(row?.token).not.toMatch(/^CUSTOMER_U/);
    expect(row?.due).toBe('10000000');
    expect(await plaintextIn(business.id, ['ada.obi@example.com', 'CUSTOMER_U'])).toEqual([]);
  });

  it("another customer's real token copied into a record's words is not kept", async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');

    await say(
      'wamid.S6',
      {
        intent: 'RecordExpense',
        description: `transport for ${bola.token}`,
        amount: 3_000,
        category: 'transport',
        paymentMethod: 'cash',
      },
      'paid 3k cash for transport',
    );
    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraftToAnswer(tx, business.id, { asOf: new Date() }),
    );
    expect((draft?.command as { description?: string }).description).toBe(
      'transport for [customer]',
    );
    expect(stubSender.lastText).not.toContain('Bola');
  });

  it('a phone and an email typed for one sale customer are still asked about (PR #77)', async () => {
    const business = await seedMerchant();

    await say(
      'wamid.S7',
      sale({ kind: 'token', token: 'CUSTOMER_U01' }),
      'Ada 08039998888 ada.obi@example.com bought 2 wigs for 100k',
    );

    expect(stubSender.lastText).toContain('same customer');
    expect(await identitiesOf(business.id)).toEqual(['email', 'phone']);
  });

  it('a second phone beside a known customer on a payment creates nobody', async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    await invoiceTo(business.id, bola.token);

    await say(
      'wamid.S8',
      payment({ kind: 'token', token: bola.token }),
      'Bola Ige paid 20k, her driver is 08039998888 and 08037776666',
    );

    expect(await identitiesOf(business.id)).toEqual([]);
  });
});

/**
 * A refusal is not a preview, and a "yes" after it must not confirm what was shown before
 * it (owner review of #437 at 3a60b0f). The merchant last read "I could not tell which
 * customer"; their "yes" is about that, never agreement to an older sale.
 */
describe('a yes after a refused record', () => {
  it('does not confirm the older preview', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.R1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    expect(stubSender.lastText).toContain('Reply *yes*');
    const before = await footprint(business.id);

    await say('wamid.R2', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    expect(stubSender.lastText).toContain('could not tell which customer');

    await plain('wamid.R3', 'yes');
    expect(stubSender.lastText).toContain('Nothing was saved from your last message');
    expect(stubSender.lastText).toContain('still a preview waiting');
    expect(await footprint(business.id)).toEqual(before);

    /* Told the preview is waiting, the next yes is about it (Build 6's rule
     * for a question asked since a preview, applied to a refusal). */
    await plain('wamid.R3b', 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });

  it('a no after a refusal alone cancels nothing and says so', async () => {
    await seedMerchant();
    await say('wamid.R10', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    await plain('wamid.R11', 'no');
    expect(stubSender.lastText).not.toBe('Cancelled.');
    expect(stubSender.lastText).not.toContain('Cancelled');
  });

  it("another member's refusal does not stand between a member and their own preview", async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');

    await say(
      'wamid.R12',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    stubTransport.replyWith(payment({ kind: 'token', token: 'CUSTOMER_7K2' }));
    await post(messagePayload(DELEGATE, 'wamid.R13', 'Bisi paid 20k'));
    await drain();
    expect(stubSender.lastText).toContain('could not tell which customer');

    await plain('wamid.R14', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);
  });

  /* The reviewer of the owner-review fixes: the same shape outside the model path. */
  it.each([
    [
      'a photo cannot be fetched',
      'wamid.R15',
      () => photoPayload(OWNER, 'wamid.R15', { mediaId: 'gone' }),
    ],
    ['a voice note cannot be fetched', 'wamid.R16', () => voicePayload(OWNER, 'wamid.R16', 'gone')],
  ])('does not confirm the older preview when %s', async (_why, _wamid, payload) => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.R17',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    const before = await footprint(business.id);

    await post(payload());
    await drain();
    expect(stubSender.lastText).not.toContain('Reply *yes*');

    await plain('wamid.R18', 'yes');
    expect(stubSender.lastText).toContain('still a preview waiting');
    expect(await footprint(business.id)).toEqual(before);
  });

  /* The same shape, found while testing the one above and older than #437: a yes after
   * "I am very busy right now" (provider down) or "I could not turn that into a record"
   * (an answer that failed the schema) posted the sale previewed before it. */
  it.each([
    ['the model provider is down', () => stubTransport.script(new Error('provider timeout'))],
    ['the model answer is unusable', () => stubTransport.replyWith({ intent: 'Nonsense' })],
  ])('does not confirm the older preview when %s', async (_why, failNext) => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.R7',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    const before = await footprint(business.id);

    failNext();
    await plain('wamid.R8', 'Bisi paid 20k');
    expect(stubSender.lastText).not.toContain('Reply *yes*');

    await plain('wamid.R9', 'yes');
    expect(stubSender.lastText).toContain('still a preview waiting');
    expect(await footprint(business.id)).toEqual(before);
  });

  it('still lets a later, explicit preview be confirmed', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say('wamid.R4', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    expect(stubSender.lastText).toContain('could not tell which customer');

    await say(
      'wamid.R5',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    expect(stubSender.lastText).toContain('Reply *yes*');
    await plain('wamid.R6', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);
  });
});
