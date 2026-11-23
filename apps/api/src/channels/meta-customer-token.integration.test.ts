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
import { conversationsRepo, issueRepo, sql, withBusiness } from '@rekoda/db';
import { db, deps, stubSender, useMetaWebhookHarness } from './meta-webhook.fixtures.js';

import {
  balanceOf,
  footprint,
  identitiesOf,
  lastModelText,
  payment,
  plain,
  plaintextIn,
  sale,
  say,
  seedMerchant,
} from './meta-customer-token.fixtures.js';

useMetaWebhookHarness();

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

/** The one invoice's customer: its snapshot token, and whether `customer_id` is that customer's row
 * (CodeRabbit on #437 at ccdcc8e: the identity fields themselves, not only the counts). */
async function invoiceOwner(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ token: string | null; linked: boolean }>(sql`
      SELECT i.snapshot_json ->> 'customerToken' AS token,
             (c.id IS NOT NULL AND c.token = i.snapshot_json ->> 'customerToken') AS linked
        FROM invoices i
        LEFT JOIN customers c ON c.id = i.customer_id AND c.business_id = i.business_id
       WHERE i.business_id = ${businessId}::uuid`),
  );
  const row = [...rows][0]!;
  return { customerToken: row.token, linked: row.linked };
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

  /* A recorded name in the message is tokenised before the model reads it, so a mention the
   * model writes that finds a recorded customer was not typed: refused like an unissued token
   * (CodeRabbit on #437 at ebeeadb). */
  it('a sale naming a recorded customer the message never typed is not drafted', async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    await invoiceTo(business.id, bola.token);
    const before = await footprint(business.id);

    await say('wamid.T2m', payment({ kind: 'mention', mention: 'Bola Ige' }), 'she paid 20k');

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await footprint(business.id)).toEqual(before);
    await plain('wamid.T2m-yes', 'yes');
    expect(await footprint(business.id)).toEqual(before);
  });

  /* An email's local part is a contact, not a name typed (CodeRabbit on #437 at 3d66867). */
  it('a recorded name that appears only inside an email is not typed', async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola');
    await invoiceTo(business.id, bola.token);
    const before = await footprint(business.id);

    await say(
      'wamid.T2e',
      payment({ kind: 'mention', mention: 'Bola' }),
      'bola@example.com paid 20k',
    );

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await footprint(business.id)).toEqual(before);
  });

  /* OD-62(n): the guard never depended on the vault. A name nobody recorded that the merchant
   * never typed is the model's, so it creates nobody and drafts nothing (CodeRabbit on #437 at
   * 58dd68b). */
  it.each([
    ['a sale', 'wamid.T2n-sale', 'sold 2 wigs for 100k'],
    ['a payment', 'wamid.T2n-pay', 'she paid 20k'],
  ])('%s naming a new customer the message never typed creates nobody', async (_, wamid, text) => {
    const business = await seedMerchant();
    const before = await footprint(business.id);
    const mention = { kind: 'mention', mention: 'Bola Ige' };

    await say(wamid, text === 'she paid 20k' ? payment(mention) : sale(mention), text);

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await footprint(business.id)).toEqual(before);
    expect(await deps.gateway.findMention(business.id, 'Bola Ige')).toBeNull();
    await plain(`${wamid}-yes`, 'yes');
    expect(await footprint(business.id)).toEqual(before);
  });

  /* A combining mark continues a word: a name the merchant typed with one ("Ada" and U+0331,
   * which has no precomposed form) is not the shorter name (CodeRabbit on #437 at 56c4140). */
  it('a name the merchant typed with a trailing combining mark is not the shorter name', async () => {
    const business = await seedMerchant();
    const before = await footprint(business.id);

    await say('wamid.T2cm', payment({ kind: 'mention', mention: 'Ada' }), 'Ada\u0331 paid 20k');

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await footprint(business.id)).toEqual(before);
    expect(await deps.gateway.findMention(business.id, 'Ada')).toBeNull();
  });

  /* A removed contact separates the words around it: "Ada" and "Obi" on either side of an email
   * or a link were never typed together as "Ada Obi" (CodeRabbit on #437 at b497318). */
  it.each([
    ['email', 'wamid.T2split-e', 'Ada ada@example.test Obi bought 3 wigs for 30k'],
    ['link', 'wamid.T2split-u', 'Ada https://example.test/x Obi bought 3 wigs for 30k'],
  ])('a name joined across a removed %s is not typed', async (_, wamid, text) => {
    const business = await seedMerchant();
    const before = await footprint(business.id);

    await say(wamid, sale({ kind: 'mention', mention: 'Ada Obi' }), text);

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await footprint(business.id)).toEqual(before);
    expect(await deps.gateway.findMention(business.id, 'Ada Obi')).toBeNull();
    await plain(`${wamid}-yes`, 'yes');
    expect(await footprint(business.id)).toEqual(before);
  });

  /* Whole words, ignoring case, spacing and composition, are still the name typed, beside a
   * contact or not; the sale confirms with exactly one new customer and one invoice. */
  it.each([
    [
      'typed whole beside an email',
      'wamid.T2whole-e',
      'Ada Obi ada@example.test bought 2 wigs for 100k',
    ],
    ['in another case and spacing', 'wamid.T2whole-c', 'sold  ADA   obi 2 wigs for 100k'],
    ['in decomposed form', 'wamid.T2whole-n', 'sold Ade\u0301 Obi 2 wigs for 100k'],
  ])('a name %s is the name typed', async (_, wamid, text) => {
    const business = await seedMerchant();
    const before = await footprint(business.id);
    const mention = wamid.endsWith('-n') ? 'Ad\u00e9 Obi' : 'Ada Obi';

    await say(wamid, sale({ kind: 'mention', mention }), text);
    expect(stubSender.lastText).not.toContain('could not tell which customer');
    await plain(`${wamid}-yes`, 'yes');

    const after = await footprint(business.id);
    expect(after.invoices).toBe(before.invoices + 1);
    expect(after.customers).toBe(before.customers + 1);
    const named = await deps.gateway.findMention(business.id, mention);
    expect(named).not.toBeNull();
    expect(await invoiceOwner(business.id)).toEqual({ customerToken: named!.token, linked: true });
  });

  /* A hyphen joins a name: "Ada" in "Ada-Bola" is no name typed, so the recorded Ada is never
   * given a sale to Ada-Bola (CodeRabbit on #437 at cacc734). */
  it('a fragment of a hyphenated name is not typed', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada');
    await invoiceTo(business.id, ada.token);
    const before = await footprint(business.id);

    await say(
      'wamid.T2hy',
      sale({ kind: 'mention', mention: 'Ada' }),
      'sold to Ada-Bola 2 wigs for 100k',
    );

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await footprint(business.id)).toEqual(before);
  });

  it('a new customer the merchant typed is created at the sale and confirmed', async () => {
    const business = await seedMerchant();
    const before = await footprint(business.id);

    await say(
      'wamid.T2t',
      sale({ kind: 'mention', mention: 'tunde bakare' }),
      'sold Tunde Bakare 2 wigs for 100k',
    );
    expect(stubSender.lastText).not.toContain('could not tell which customer');
    await plain('wamid.T2t-yes', 'yes');

    const after = await footprint(business.id);
    expect(after.invoices).toBe(before.invoices + 1);
    expect(after.customers).toBe(before.customers + 1);
    const named = await deps.gateway.findMention(business.id, 'tunde bakare');
    expect(await invoiceOwner(business.id)).toEqual({ customerToken: named!.token, linked: true });
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

  it('a third contact cannot merge a new phone buyer into a recorded customer', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.P4-three',
      sale({ kind: 'token', token: 'CUSTOMER_U01' }),
      'Sold 2 wigs to 08039998888 for 100k; Ada Obi will collect; send details to dispatch@example.test',
    );

    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraftToAnswer(tx, business.id, { asOf: new Date() }),
    );
    const token = (draft?.command as { customer?: { token?: string } } | undefined)?.customer
      ?.token;
    expect(token).toMatch(/^CUSTOMER_/);
    expect(token).not.toBe(ada.token);
    expect(draft?.identityLink).toBeNull();
    expect(await identitiesOf(business.id)).toEqual(['phone']);

    await plain('wamid.P4-three-yes', 'yes');
    expect(await footprint(business.id)).toMatchObject({ customers: 2, invoices: 1 });
    expect(await invoiceOwner(business.id)).toEqual({ customerToken: token, linked: true });
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
