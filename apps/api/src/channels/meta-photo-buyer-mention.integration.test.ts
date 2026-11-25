/**
 * CodeRabbit on #437 (PRRT_kwDOT845J8676qOZ): a photographed sale whose buyer the model returns as
 * a MENTION is judged by the same facets as one it returns as a token.
 *
 * A page can name one recorded customer through several buyer-labelled fields (`Buyer: Ada Obi`,
 * `Client: ada@example.test`). A token carries every facet this message observed; a mention used to
 * be compared by its name alone, so the email field "contradicted" it and a legitimate sale was
 * refused. The mention is now looked up (read-only, before anything is created) and, when it is a
 * customer this message was issued, judged by that customer's observed facets. The complete name is
 * still required, and nobody is merged or created. Asserted on the buyer actually stored and the
 * customer count, never only the reply.
 */
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
const ADA = 'CUSTOMER_7K2';
const BOLA = 'CUSTOMER_8K2';

async function seedCustomer(
  businessId: string,
  token: string,
  facets: ReadonlyArray<readonly ['name' | 'email' | 'phone', string]>,
) {
  await customersRepo.createCustomerWithIdentities(
    db,
    businessId,
    token,
    facets.map(([facet, value]) => ({
      facet,
      ciphertext: encryptFacet(value, deps.config.vaultKey, `${businessId}:${facet}`),
      matchKey: matchKeyFor(businessId, facet, normaliseFacet(facet, value), deps.config.matchKey),
    })),
  );
}

const customerCount = async (businessId: string) =>
  Number(
    [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM customers WHERE business_id = ${businessId}::uuid`,
        ),
      )),
    ][0]?.n,
  );

const previewedBuyers = async (businessId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{ customer: { kind: string; token?: string } }>(sql`
        SELECT command->'customer' AS customer FROM command_drafts
         WHERE business_id = ${businessId}::uuid AND intent = 'RecordSale'
           AND state = 'pending' AND previewed`),
    )),
  ].map((r) => r.customer);

async function photoSale(
  tag: string,
  page: string,
  customer: Record<string, unknown>,
  setup: (businessId: string) => Promise<void>,
) {
  const business = await seedMerchant('+' + OWNER);
  await setup(business.id);
  const customers = await customerCount(business.id);
  arrangePhoto();
  stubOcr.answerWith({ text: `RECEIPT\n${page}\n2 wigs TOTAL 100,000`, confidence: 0.9 });
  stubTransport.replyWith(sale(customer));
  await post(photoPayload(OWNER, `wamid.BM-${tag}`, {}));
  await drain();
  return { business, customers };
}

const both = async (id: string) => {
  await seedCustomer(id, ADA, [
    ['name', 'Ada Obi'],
    ['email', 'ada@example.test'],
    ['phone', '08035551234'],
  ]);
  await seedCustomer(id, BOLA, [
    ['name', 'Bola Ige'],
    ['email', 'bola@example.test'],
  ]);
};

describe('a photographed buyer returned as a mention (CodeRabbit on #437)', () => {
  it.each([
    ['name and email of one recorded customer', 'Buyer: Ada Obi\nClient: ada@example.test'],
    ['name and phone of one recorded customer', 'Buyer: Ada Obi\nClient: 0803 555 1234'],
  ])('accepts %s, for that customer, creating nobody', async (name, page) => {
    const { business, customers } = await photoSale(
      name.length.toString(),
      page,
      { kind: 'mention', mention: 'Ada Obi' },
      both,
    );

    const buyers = await previewedBuyers(business.id);
    expect(buyers).toEqual([{ kind: 'token', token: ADA }]);
    expect(await customerCount(business.id)).toBe(customers);
  });

  it.each([
    [
      'name and email of different customers',
      'Buyer: Ada Obi\nClient: bola@example.test',
      'Ada Obi',
    ],
    [
      'a buyer who is somebody else, the mention only a supplier',
      'Buyer: Bola Ige\nSupplier: Ada Obi',
      'Ada Obi',
    ],
    ['a first name only', 'Buyer: Ada Obi\nClient: ada@example.test', 'Ada'],
    ['a name the page never shows', 'Buyer: Ada Obi\nClient: ada@example.test', 'Chidi Eze'],
  ])('refuses %s: no preview, no new customer', async (name, page, mention) => {
    const { business, customers } = await photoSale(
      `n${name.length}`,
      page,
      { kind: 'mention', mention },
      both,
    );

    expect(await previewedBuyers(business.id)).toEqual([]);
    expect(await customerCount(business.id)).toBe(customers);
    expect(stubSender.lastText).toContain('could not tell which customer');
  });

  it('refuses a token this message was not issued', async () => {
    const { business, customers } = await photoSale(
      'unissued',
      'Buyer: Ada Obi\nClient: ada@example.test',
      { kind: 'token', token: 'CUSTOMER_9ZZ' },
      both,
    );

    expect(await previewedBuyers(business.id)).toEqual([]);
    expect(await customerCount(business.id)).toBe(customers);
  });
});
