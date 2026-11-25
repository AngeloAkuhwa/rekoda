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
    ['different customers', 'Buyer: Ada Obi\nClient: bola@example.test', false],
    ['an exact spaced phone', 'Buyer: 0803 555 1234', true],
    ['extra phone digits', 'Buyer: 08035551234 567\nSeller: 08035551234', false],
  ])('%s', async (_, fields, accepted) => {
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

    await post(photoPayload(OWNER, 'wamid.BUYER-fields'));
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
  it.each(['Tel: 08035551234', 'Email: ada@example.test'])(
    'a sale read with no customer before %s is asked about',
    async (contact) => {
      const business = await seedMerchant('+' + OWNER);
      arrangePhoto();
      stubOcr.answerWith({
        text: `RECEIPT\nCustomer:\n${contact}\nWig 2 50000\nTOTAL 100,000`,
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
    },
  );
});
