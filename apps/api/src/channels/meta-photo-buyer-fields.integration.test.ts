import { describe, expect, it } from 'vitest';
import { customersRepo, sql, withBusiness } from '@rekoda/db';
import { encryptFacet, matchKeyFor, normaliseFacet } from '@rekoda/core/vault';
import {
  db,
  deps,
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
