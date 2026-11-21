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
