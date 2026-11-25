import { describe, expect, it } from 'vitest';
import { customersRepo, sql, withBusiness } from '@rekoda/db';
import { encryptFacet, matchKeyFor, normaliseFacet } from '@rekoda/core/vault';
import {
  db,
  deps,
  messagePayload,
  photoPayload,
  post,
  stubOcr,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { sale } from './meta-customer-token.fixtures.js';
import { arrangePhoto, drain, seedMerchant } from './meta-receipt-photo.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';
const TOKEN = 'CUSTOMER_7K2';

describe('buyer fields on a photographed sale', () => {
  it.each([
    ['matching name and email', 'Buyer: Ada Obi\nClient: ada@example.test', true],
    ['a buyer on the next line', 'Buyer:\nAda Obi', true],
    ['a phone on the next line', 'Buyer:\n08035551234', true],
    /* The value after a contact heading is the buyer field, never the heading itself. */
    ['a phone under a contact heading', 'Buyer:\nTel: 08035551234', true],
    ['an email under a contact heading', 'Customer:\nEmail: ada@example.test', true],
    /* The same contact heading on the label's own line (CodeRabbit on #437 at 600a155). */
    ['a phone after a contact heading on the same line', 'Buyer: Tel: 08035551234', true],
    /* A caption that labels Ada as the seller is no evidence she bought (CodeRabbit, 600a155). */
    ['a seller named in the caption', 'Buyer: Bola Ige', false, 'Seller: Ada Obi'],
    ['the buyer typed in the caption', 'Items:', true, 'sold to Ada Obi'],
    ['different customers', 'Buyer: Ada Obi\nClient: bola@example.test', false],
    ['an exact spaced phone', 'Buyer: 0803 555 1234', true],
    ['extra phone digits', 'Buyer: 08035551234 567\nSeller: 08035551234', false],
  ] as [string, string, boolean, string?][])('%s', async (_, fields, accepted, caption) => {
    const business = await seedMerchant('+' + OWNER);
    const facets = [
      ['name', 'Ada Obi'],
      ['email', 'ada@example.test'],
      ['phone', '08035551234'],
    ] as const;
    await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      TOKEN,
      facets.map(([facet, value]) => ({
        facet,
        ciphertext: encryptFacet(value, deps.config.vaultKey, `${business.id}:${facet}`),
        matchKey: matchKeyFor(
          business.id,
          facet,
          normaliseFacet(facet, value),
          deps.config.matchKey,
        ),
      })),
    );
    await customersRepo.createCustomerWithIdentities(db, business.id, 'CUSTOMER_8K2', [
      {
        facet: 'email',
        ciphertext: encryptFacet('bola@example.test', deps.config.vaultKey, `${business.id}:email`),
        matchKey: matchKeyFor(business.id, 'email', 'bola@example.test', deps.config.matchKey),
      },
    ]);
    arrangePhoto();
    stubOcr.answerWith({ text: `RECEIPT\n${fields}\n2 wigs TOTAL 100,000`, confidence: 0.9 });
    stubTransport.replyWith(sale({ kind: 'token', token: TOKEN }));

    await post(photoPayload(OWNER, 'wamid.BUYER-fields', caption ? { caption } : {}));
    await drain();

    const drafts = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        SELECT command->'customer' AS customer FROM command_drafts
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'
           AND state = 'pending' AND previewed`),
    );
    expect([...drafts]).toEqual(accepted ? [{ customer: { kind: 'token', token: TOKEN } }] : []);
    if (!accepted) expect(stubSender.lastText).toContain('could not tell which customer');
  });
});

describe('an empty buyer label does not name a customer', () => {
  it.each([
    'Item Qty Price',
    'Description Quantity Amount',
    'Items:',
    'Seller: Wigs Ltd',
    /* An empty contact heading ends the empty field too (CodeRabbit on #437 at 6b3fc05). */
    'Tel:',
  ])('leaves the sale anonymous before %s', async (heading) => {
    const business = await seedMerchant('+' + OWNER);
    arrangePhoto();
    stubOcr.answerWith({
      text: `RECEIPT\nCustomer:\n${heading}\nWig 2 50000\nTOTAL 100,000`,
      confidence: 0.9,
    });
    stubTransport.replyWith(sale({ kind: 'none' }));

    await post(photoPayload(OWNER, 'wamid.BUYER-empty'));
    await drain();

    const drafts = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
          SELECT command->'customer' AS customer FROM command_drafts
           WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'
             AND state = 'pending' AND previewed`),
    );
    expect([...drafts]).toEqual([{ customer: { kind: 'none' } }]);
  });
});

/* A contact block under the label still names a customer: read with nobody, the sale is asked
 * about, never booked as anonymous (OWN-103(4), OWN-102(6); independent review on #437). */
describe('a contact under an empty buyer label is evidence of a buyer', () => {
  it.each([
    'Customer:\nTel: 08035551234',
    'Customer:\nEmail: ada@example.test',
    /* A same-line empty heading with its value below (independent review of 5e5267c). */
    'Customer: Tel:\n08035551234',
    'Customer:\nTel:\n08035551234',
    /* A name beside the phone below the heading, or no contact at all below a same-line heading
     * (independent review of a4ba72d). */
    'Customer: Tel:\nAda Obi 08035551234',
    'Customer:\nTel:\nAda Obi 08035551234',
    'Customer: Tel:\nAda Obi',
    /* A value below that is no usable field keeps the same-line heading (third review). */
    'Customer: Tel:\n• 08035551234',
    'Customer: Tel:\n1 Wig 2 5000000000',
    'Customer: Email:\n- ada@example.test',
  ])('a sale read with no customer under %j is asked about', async (contact) => {
    const business = await seedMerchant('+' + OWNER);
    arrangePhoto();
    stubOcr.answerWith({
      text: `RECEIPT\n${contact}\nWig 2 50000\nTOTAL 100,000`,
      confidence: 0.9,
    });
    stubTransport.replyWith(sale({ kind: 'none' }));

    await post(photoPayload(OWNER, 'wamid.BUYER-contact'));
    await drain();

    const drafts = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
          SELECT 1 FROM command_drafts
           WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'
             AND state = 'pending' AND previewed`),
    );
    expect([...drafts]).toEqual([]);
  });
});

async function seedAda(businessId: string) {
  const facets = [
    ['name', 'Ada Obi'],
    ['email', 'ada@example.test'],
    ['phone', '08035551234'],
  ] as const;
  await customersRepo.createCustomerWithIdentities(
    db,
    businessId,
    TOKEN,
    facets.map(([facet, value]) => ({
      facet,
      ciphertext: encryptFacet(value, deps.config.vaultKey, `${businessId}:${facet}`),
      matchKey: matchKeyFor(businessId, facet, normaliseFacet(facet, value), deps.config.matchKey),
    })),
  );
}

const previewedSales = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute(sql`
      SELECT command->'customer' AS customer FROM command_drafts
       WHERE business_id = ${businessId}::uuid AND intent = 'RecordSale'
         AND state = 'pending' AND previewed`),
  ).then((rows) => [...rows]);

/* The caption the merchant typed is evidence of the buyer only where it does not label that name
 * as somebody else (CodeRabbit on #437 at 600a155, OWN-102(6)), and a buyer the caption labels is
 * evidence of a buyer as much as one the page labels (OWN-103(4)). */
describe('a caption that labels its names', () => {
  it.each([
    ['labels the chosen customer as the supplier', 'Supplier - Ada Obi', 'RECEIPT', false],
    ['labels the chosen customer as the buyer', 'Buyer: Ada Obi', 'Seller: Wigs Ltd', true],
    ['labels the chosen customer as the delivery contact', 'Deliver to: Ada Obi', 'RECEIPT', false],
    /* "Received from" is a buyer label, not another party (independent review of 5e5267c). */
    ['receives from the chosen customer', 'Received from: Ada Obi', 'RECEIPT', true],
    /* A caption's buyer and the page's must agree (independent review of 5e5267c). */
    ['labels another buyer than the page', 'Buyer: Tunde Bello', 'Buyer: Ada Obi', false],
    /* A caption that rules the chosen customer out is no evidence she bought, while the same
     * words without the negation are (CodeRabbit on #437 at 400ca58). */
    ['rules the chosen customer out', 'Not sold to Ada Obi', 'RECEIPT', false],
    ['rules the chosen customer out with "not for"', 'Not for Ada Obi', 'RECEIPT', false],
    /* A typographic apostrophe, as phone keyboards type it (independent review of 55f4e22). */
    [
      'rules the chosen customer out with a curly apostrophe',
      'Wasn’t sold to Ada Obi',
      'RECEIPT',
      false,
    ],
    /* A negation after the buyer's name says something else about the sale. */
    ['names the buyer before "not paid yet"', 'Sold to Ada Obi, not paid yet', 'RECEIPT', true],
    ['names the chosen customer as the buyer', 'Sold to Ada Obi', 'RECEIPT', true],
  ])('a caption that %s', async (_, caption, page, accepted) => {
    const business = await seedMerchant('+' + OWNER);
    await seedAda(business.id);
    arrangePhoto();
    stubOcr.answerWith({ text: `${page}\n2 wigs TOTAL 100,000`, confidence: 0.9 });
    stubTransport.replyWith(sale({ kind: 'token', token: TOKEN }));

    await post(photoPayload(OWNER, 'wamid.BUYER-caption', { caption }));
    await drain();

    expect(await previewedSales(business.id)).toEqual(
      accepted ? [{ customer: { kind: 'token', token: TOKEN } }] : [],
    );
    if (!accepted) expect(stubSender.lastText).toContain('could not tell which customer');
  });

  it.each(['Buyer: Tunde Bello', 'Customer - Tunde Bello'])(
    'a sale read with no customer under the caption %s is asked about',
    async (caption) => {
      const business = await seedMerchant('+' + OWNER);
      arrangePhoto();
      stubOcr.answerWith({ text: 'RECEIPT\n2 wigs TOTAL 100,000', confidence: 0.9 });
      stubTransport.replyWith(sale({ kind: 'none' }));

      await post(photoPayload(OWNER, 'wamid.BUYER-caption-none', { caption }));
      await drain();

      expect(await previewedSales(business.id)).toEqual([]);
      expect(stubSender.lastText).toContain('could not tell which customer');
    },
  );
});

/* OD-72 Option A (owner ruling 25 Nov 2026): a caption that carries a customer token this message
 * was issued (a recorded customer's name, phone or email, or a new phone or email) is evidence of
 * a buyer. Read by the model as nobody, the sale is asked about, never previewed as anonymous, and
 * nobody is created. A caption with no issued token, or whose only token sits in a clause naming
 * another party or ruling the person out, leaves an ordinary anonymous sale. No capitalised-name
 * detector: an unrecorded name typed without a label issues no token. */
describe('a caption that names an issued customer, read with no customer (OD-72)', () => {
  const footprint = (businessId: string) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute<{ customers: number; invoices: number; postings: number }>(sql`
        SELECT (SELECT count(*)::int FROM customers WHERE business_id = ${businessId}::uuid) AS customers,
               (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
               (SELECT count(*)::int FROM ledger_transactions
                 WHERE business_id = ${businessId}::uuid) AS postings`),
    ).then((rows) => rows[0]!);

  async function seedBola(businessId: string) {
    await customersRepo.createCustomerWithIdentities(db, businessId, 'CUSTOMER_8K2', [
      {
        facet: 'email',
        ciphertext: encryptFacet('bola@example.test', deps.config.vaultKey, `${businessId}:email`),
        matchKey: matchKeyFor(businessId, 'email', 'bola@example.test', deps.config.matchKey),
      },
    ]);
  }

  async function photographed(caption: string, page = 'RECEIPT') {
    const business = await seedMerchant('+' + OWNER);
    await seedAda(business.id);
    await seedBola(business.id);
    arrangePhoto();
    stubOcr.answerWith({ text: `${page}\n2 wigs TOTAL 100,000`, confidence: 0.9 });
    stubTransport.replyWith(sale({ kind: 'none' }));
    await post(photoPayload(OWNER, 'wamid.OD72', { caption }));
    await drain();
    return business;
  }

  it.each([
    ['a recorded customer by name', 'Ada Obi 2 wigs'],
    ['a recorded customer by a spaced phone', 'for 0803 555 1234'],
    ['a recorded customer by email', 'ada@example.test'],
    ['a new phone, issued a provisional token', '08099998888 took 2 wigs'],
    ['two different people', 'Ada Obi and bola@example.test'],
    /* The caption's customer contradicts the page's labelled buyer. */
    ['a customer the page contradicts', 'Ada Obi', 'Buyer: Bola Ige'],
  ] as [string, string, string?][])(
    'is asked about when the caption names %s',
    async (_, caption, page) => {
      const business = await photographed(caption, page);

      expect(await previewedSales(business.id)).toEqual([]);
      expect(stubSender.lastText).toContain('could not tell which customer');
      /* Nobody created (Ada and Bola were seeded), nothing invoiced or posted. */
      expect(await footprint(business.id)).toEqual({ customers: 2, invoices: 0, postings: 0 });
      /* A generic yes afterwards books nothing. */
      await post(messagePayload(OWNER, 'wamid.OD72-yes', 'yes'));
      await drain();
      expect(await footprint(business.id)).toEqual({ customers: 2, invoices: 0, postings: 0 });
    },
  );

  it.each([
    ['names nobody', '2 wigs'],
    ['names only the supplier', 'Supplier: Ada Obi'],
    ['names only the delivery contact', 'Deliver to ada@example.test'],
    ['rules the customer out', 'Not sold to Ada Obi'],
  ])('leaves an anonymous sale when the caption %s', async (_, caption) => {
    const business = await photographed(caption);

    expect(await previewedSales(business.id)).toEqual([{ customer: { kind: 'none' } }]);
    expect(await footprint(business.id)).toEqual({ customers: 2, invoices: 0, postings: 0 });
  });

  it('books the sale to the buyer once the merchant says who it is for', async () => {
    const business = await photographed('Ada Obi 2 wigs');
    expect(await previewedSales(business.id)).toEqual([]);

    /* The merchant sends the photo again and labels the buyer; the model now names her. */
    arrangePhoto();
    stubOcr.answerWith({ text: 'RECEIPT\n2 wigs TOTAL 100,000', confidence: 0.9 });
    stubTransport.replyWith(sale({ kind: 'token', token: TOKEN }));
    await post(photoPayload(OWNER, 'wamid.OD72-again', { caption: 'Buyer: Ada Obi' }));
    await drain();
    expect(await previewedSales(business.id)).toEqual([
      { customer: { kind: 'token', token: TOKEN } },
    ]);
    expect(await footprint(business.id)).toEqual({ customers: 2, invoices: 0, postings: 0 });

    await post(messagePayload(OWNER, 'wamid.OD72-again-yes', 'yes'));
    await drain();
    const invoices = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ token: string | null }>(sql`
        SELECT c.token FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
         WHERE i.business_id = ${business.id}::uuid`),
    ).then((rows) => [...rows]);
    expect(invoices).toEqual([{ token: TOKEN }]);
    expect((await footprint(business.id)).customers).toBe(2);
  });
});
