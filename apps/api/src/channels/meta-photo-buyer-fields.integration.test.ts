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
import { plaintextIn, sale } from './meta-customer-token.fixtures.js';
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
    /* A labelled field the caption negates rules the buyer out (Codex on #437 at 1ec5a22). */
    ['a negated buyer field in the caption', 'Items:', false, 'Not sold to: Ada Obi'],
    /* A whole address in quotes is the buyer; a longer address it prefixes is not (CodeRabbit on
     * #437 at 1ec5a22). */
    ['a quoted email typed in the caption', 'Items:', true, 'For "ada@example.test"'],
    ['a longer address the email only prefixes', 'Items:', false, 'For ada@example.test.ng'],
    ['a negated buyer field, curled apostrophe', 'Items:', false, 'Wasn’t sold to: Ada Obi'],
    ['different customers', 'Buyer: Ada Obi\nClient: bola@example.test', false],
    ['an exact spaced phone', 'Buyer: 0803 555 1234', true],
    /* A caption that offers alternatives selects nobody, so the sale is asked about (OWN-103(4);
     * CodeRabbit on #437 at c5392f0). One name alone still selects her. */
    ['the buyer alone typed in the caption', 'Items:', true, 'For Ada Obi'],
    ['alternative buyers in the caption', 'Items:', false, 'For Ada Obi or Bola Ige'],
    ['either of two buyers in the caption', 'Items:', false, 'Either Ada Obi or Bola, not sure'],
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
    /* Independent review of 42a2422: a +234 phone, an email inside punctuation, and a negation
     * that rules nobody out before the buyer's name. */
    ['a recorded customer by a +234 phone', '+234 803 555 1234 2 wigs'],
    ['a recorded customer by a labelled email', 'email:ada@example.test'],
    ['a recorded customer by a quoted email', '"ada@example.test"'],
    ['a buyer after an unrelated negation', 'Not paid yet Ada Obi 0803 555 1234'],
    ['a buyer after an unrelated dashed negation', 'Not paid yet - Ada Obi'],
    /* "for" after a negation need not name a person (second review of 42a2422..20a95c4). */
    ['a buyer after "not for credit"', 'Not for credit Ada Obi 0803 555 1234'],
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

  /* A caption of many digit groups is read in time (independent review of 42a2422: the phone
   * match was cubic in the number of groups). */
  it('reads a caption of thousands of digit groups quickly', async () => {
    const started = Date.now();
    const business = await photographed(`${'1 '.repeat(4000)}08099998888`);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await previewedSales(business.id)).toEqual([]);
  }, 60_000);

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
const OWNERM = '2348031234567';
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
  const business = await seedMerchant('+' + OWNERM);
  await setup(business.id);
  const customers = await customerCount(business.id);
  arrangePhoto();
  stubOcr.answerWith({ text: `RECEIPT\n${page}\n2 wigs TOTAL 100,000`, confidence: 0.9 });
  stubTransport.replyWith(sale(customer));
  await post(photoPayload(OWNERM, `wamid.BM-${tag}`, {}));
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

/* OD-74 Option A (owner ruling OWN-107): for a photographed record, an unrecorded buyer name may reach
 * the approved Anthropic document classifier as read, within OWN-106's limits. Recorded identities and
 * every phone or email are tokenised before it, and the name is stored nowhere. */
describe('the document classifier on a photographed record (OD-74)', () => {
  it('reads an unrecorded buyer as written, never a recorded name, phone or email', async () => {
    const business = await seedMerchant('+' + OWNER);
    /* A recorded name as well as a recorded phone (CodeRabbit on #437 at c5392f0). */
    await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      TOKEN,
      (
        [
          ['phone', '08035551234'],
          ['name', 'Ada Obi'],
        ] as const
      ).map(([facet, value]) => ({
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
    arrangePhoto();
    stubOcr.answerWith({
      text: 'RECEIPT\nBuyer: Chidi Eze\nRef: 08035551234 chidi@example.test 08039998888\nAlso for Ada Obi\n2 wigs TOTAL 100,000',
      confidence: 0.9,
    });
    stubTransport.replyWith(sale({ kind: 'none' }));
    stubTransport.requests.length = 0;

    await post(photoPayload(OWNER, 'wamid.OD74-1', {}));
    await drain();

    const classifier = stubTransport.requests.filter((r) => r.toolName === 'classify_document');
    expect(classifier).toHaveLength(1);
    expect(classifier[0]!.userText).toContain('Chidi Eze');
    for (const raw of ['08035551234', 'chidi@example.test', '08039998888', 'Ada Obi']) {
      expect(classifier[0]!.userText).not.toContain(raw);
    }
    expect(await plaintextIn(business.id, ['Chidi Eze'])).toEqual([]);
  });
});
