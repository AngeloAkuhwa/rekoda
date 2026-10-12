/**
 * The privacy gateway, wired (MASTER-PLAN §5.3.2, ADR 0005).
 *
 * `@rekoda/core` proves the crypto and the detection as pure functions. What
 * needs a real database is everything this file is about: that one person is
 * one customer across messages and across a race, that the plaintext is only
 * ever in the vault, and that two merchants cannot be shown to share a
 * customer by anyone holding a dump.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, customersRepo, identity, schema, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { decryptFacet, encryptFacet, matchKeyFor, normaliseFacet } from '@rekoda/core/vault';
import { rehydrate } from '@rekoda/core/privacy';
import { PrivacyGateway } from './gateway.service.js';
import { loadConfig, type ApiConfig } from '../config.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;
let config: ApiConfig;
let gateway: PrivacyGateway;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  config = loadConfig();
  gateway = new PrivacyGateway(db, config);
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(name: string, phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('what leaves, and what does not', () => {
  it('replaces a phone number with a customer token', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { text, tokens } = await gateway.tokenise(
      businessId,
      'Ada 08031234567 bought 3 wigs for 150k',
    );

    expect(text).not.toContain('08031234567');
    expect(text).toMatch(/CUSTOMER_[0-9A-Z]{3}/);
    // The amount survives. Tokenising "150k" would protect nobody and destroy
    // the only thing a model is there to read.
    expect(text).toContain('150k');
    expect([...tokens.values()]).toContain('08031234567');
  });

  it('replaces an email too', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { text } = await gateway.tokenise(businessId, 'send the receipt to ada@example.com');
    expect(text).not.toContain('ada@example.com');
    expect(text).toMatch(/CUSTOMER_[0-9A-Z]{3}/);
  });

  it('collapses the same number mentioned twice into ONE token', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { text } = await gateway.tokenise(
      businessId,
      'call 08031234567 then send the receipt to 08031234567',
    );
    const found = [...text.matchAll(/CUSTOMER_[0-9A-Z]{3}/g)].map((m) => m[0]);
    expect(found).toHaveLength(2);
    // Same person, same token: information the model legitimately needs and
    // which reveals nothing.
    expect(new Set(found).size).toBe(1);
  });

  it('still gives a phone and an email their own records, and PROPOSES a link', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { text, link } = await gateway.tokenise(
      businessId,
      'Ada 08031234567 ada@example.com bought 3 wigs',
    );

    /* Not merged. "Ada 0803..., send it to accounts@bigco.com" is the same
     * sentence to a regular expression, and guessing would put one customer's
     * address on another customer's invoice. */
    const found = [...text.matchAll(/CUSTOMER_[0-9A-Z]{3}/g)].map((m) => m[0]);
    expect(new Set(found).size).toBe(2);

    // But the split is REPORTED, so the merchant can be asked about it.
    expect(link).not.toBeNull();
    expect(link!.survivorToken).not.toBe(link!.orphanToken);
    // A phone is the identity anchor everywhere else here, so it survives.
    expect(text.indexOf(link!.survivorToken)).toBeLessThan(text.indexOf(link!.orphanToken));
  });

  it('proposes nothing for an ordinary one-customer message', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { link } = await gateway.tokenise(businessId, 'Ada 08031234567 bought 3 wigs');
    expect(link).toBeNull();
  });

  it('proposes nothing when both customers are already known', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    await gateway.tokenise(businessId, 'call 08031234567');
    await gateway.tokenise(businessId, 'mail ada@example.com');

    /* Two records the merchant has been using are a different question with
     * different consequences, and joining those must not ride on a sale
     * preview. */
    const { link } = await gateway.tokenise(
      businessId,
      'Ada 08031234567 ada@example.com bought 3 wigs',
    );
    expect(link).toBeNull();
  });

  it('proposes nothing when a message names three people', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { link } = await gateway.tokenise(
      businessId,
      'Ada 08031234567, Bola 08039999999, mail chidi@example.com',
    );
    // Three is not a split, it is a sentence about several people.
    expect(link).toBeNull();
  });

  it('does NOT store an account number anywhere', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { text } = await gateway.tokenise(businessId, 'transfer to account 0123456789');

    expect(text).not.toContain('0123456789');
    expect(text).toContain('ACCOUNT_1');

    // No customer, no identity row, nothing in the vault. The cheapest way to
    // protect a bank account number is not to hold it.
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.select().from(schema.customerIdentities),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('one person is one customer', () => {
  it('gives the same token to the same number in a later message', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const first = await gateway.tokenise(businessId, 'Ada 08031234567 bought wigs');
    const second = await gateway.tokenise(businessId, 'payment from 0803 123 4567');

    const tokenOf = (t: string) => t.match(/CUSTOMER_[0-9A-Z]{3}/)![0];
    // Written differently, normalised identically — this is what makes a
    // returning customer a returning customer rather than a new one.
    expect(tokenOf(second.text)).toBe(tokenOf(first.text));
  });

  it('survives eight messages from the same NEW number arriving at once', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');

    // The race `identities_match_ux` exists for. Read-then-write, every one of
    // these finds nothing and creates a customer: one person becomes eight,
    // with eight tokens and a debtor balance split eight ways.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => gateway.tokenise(businessId, 'from 08031234567')),
    );

    const tokens = new Set(results.map((r) => r.text.match(/CUSTOMER_[0-9A-Z]{3}/)![0]));
    expect(tokens.size).toBe(1);

    const rows = await withBusiness(db, businessId, (tx) => tx.select().from(schema.customers));
    expect(rows).toHaveLength(1);
  });
});

describe('the vault is the only plaintext', () => {
  it('stores the number encrypted, and it decrypts back', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    await gateway.tokenise(businessId, 'from 08031234567');

    const [row] = await withBusiness(db, businessId, (tx) =>
      tx.select().from(schema.customerIdentities),
    );

    expect(row!.ciphertext).not.toContain('08031234567');
    /* v2: the blob is bound to this business and facet as associated data,
     * so a copy moved onto another row fails authentication. */
    expect(row!.ciphertext.startsWith('v2.')).toBe(true);
    expect(decryptFacet(row!.ciphertext, config.vaultKey, `${businessId}:phone`)).toBe(
      '08031234567',
    );
    expect(() => decryptFacet(row!.ciphertext, config.vaultKey)).toThrow();
  });

  it('stores a match key that is NOT a bare hash of the number', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    await gateway.tokenise(businessId, 'from 08031234567');

    const [row] = await withBusiness(db, businessId, (tx) =>
      tx.select().from(schema.customerIdentities),
    );

    // A phone number has ~10^10 possibilities, so sha256(phone) is reversible
    // by exhaustive search in seconds. The stored key is an HMAC under a
    // secret held nowhere near the data.
    const bareHash = createHash('sha256').update('8031234567').digest('base64url');
    expect(row!.matchKey).not.toBe(bareHash);
    expect(row!.matchKey).toBeTruthy();
  });

  it('gives two businesses DIFFERENT keys for the same customer', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348060000001');
    const bola = await seedBusiness('Bola Electronics', '+2348060000002');

    await gateway.tokenise(ada, 'from 08031234567');
    await gateway.tokenise(bola, 'from 08031234567');

    const [adaRow] = await withBusiness(db, ada, (tx) =>
      tx.select().from(schema.customerIdentities),
    );
    const [bolaRow] = await withBusiness(db, bola, (tx) =>
      tx.select().from(schema.customerIdentities),
    );

    // Without businessId mixed into the HMAC, these would match — and a dump
    // would reveal which merchants share a customer. Nobody consented to that
    // and preventing it costs nothing.
    expect(adaRow!.matchKey).not.toBe(bolaRow!.matchKey);
  });

  it('keeps one business from resolving another business`s token', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348060000001');
    const bola = await seedBusiness('Bola Electronics', '+2348060000002');
    await gateway.tokenise(ada, 'from 08031234567');

    const rows = await withBusiness(db, bola, (tx) => tx.select().from(schema.customers));
    expect(rows).toHaveLength(0);
  });
});

describe('a known customer name never reaches a model', () => {
  it('replaces a stored name, case-folded, and leaves an unknown name alone', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { token } = await gateway.resolveMention(businessId, 'Ada Obi');

    const { text, tokens } = await gateway.tokenise(businessId, 'sold 3 wigs to ada obi today');
    expect(text).not.toContain('ada obi');
    expect(text).toContain(token);
    expect(tokens.get(token)).toBe('ada obi');

    const untouched = await gateway.tokenise(businessId, 'sold 3 wigs to Chidi Nwosu today');
    expect(untouched.text).toContain('Chidi Nwosu');
  });

  it('prefers the longer name so a first name cannot half-eat a full name', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const first = await gateway.resolveMention(businessId, 'Ada');
    const full = await gateway.resolveMention(businessId, 'Ada Obi');

    const { text } = await gateway.tokenise(businessId, 'paid: Ada Obi');
    expect(text).toContain(full.token);
    expect(text).not.toContain(first.token);
    expect(text).not.toContain('Ada Obi');
  });

  it('recognises a name stored long ago even past the old 2,000-name ceiling', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    /* Stored FIRST, so under the retired "newest 2,000 names" cap this
     * customer fell off the end and her name leaked. */
    const { token } = await gateway.resolveMention(businessId, 'Ada Obi');

    /* 2,500 newer named customers. The lookup is by keyed hash now, so their
     * number cannot push Ada out of reach; under the old cap it did. */
    const bulk = 2_500;
    const inserted = await withBusiness(db, businessId, (tx) =>
      tx
        .insert(schema.customers)
        .values(Array.from({ length: bulk }, (_, i) => ({ businessId, token: `BULK_${i}` })))
        .returning({ id: schema.customers.id }),
    );
    await withBusiness(db, businessId, (tx) =>
      tx.insert(schema.customerIdentities).values(
        inserted.map((row, i) => ({
          businessId,
          customerId: row.id,
          facet: 'name',
          ciphertext: 'x',
          matchKey: `bulk-key-${i}`,
        })),
      ),
    );

    const { text } = await gateway.tokenise(businessId, 'balance due from Ada Obi');
    expect(text).not.toContain('Ada Obi');
    expect(text).toContain(token);
  });
});

/**
 * G-60: one customer named by several facets in one message, a token that a
 * later pass must treat as opaque, and a storefront facet that conflicts.
 */
describe('one person, several facets, one message (G-60)', () => {
  /** A customer known by name AND phone, as a storefront checkout leaves them. */
  async function adaKnownByNameAndPhone(businessId: string) {
    const { token, customerId } = await gateway.resolveMention(businessId, 'Ada Obi');
    await customersRepo.addIdentityFacet(db, businessId, customerId, {
      facet: 'phone',
      ciphertext: encryptFacet('08031234567', config.vaultKey, `${businessId}:phone`),
      matchKey: matchKeyFor(
        businessId,
        'phone',
        normaliseFacet('phone', '08031234567'),
        config.matchKey,
      ),
    });
    return token;
  }

  it('shows every facet the merchant typed, name first, whichever pass ran last', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const token = await adaKnownByNameAndPhone(businessId);

    const tokenised = await gateway.tokenise(businessId, 'Ada Obi on 08031234567 paid 20k');
    expect(tokenised.text).toBe(`${token} on ${token} paid 20k`);
    /* One token for one person, and the reply names her by what was typed:
     * never the name standing where the phone was, nor the reverse. */
    expect(rehydrate(`Receipt sent to ${token}`, tokenised.tokens)).toBe(
      'Receipt sent to Ada Obi (08031234567)',
    );
  });

  it('gives the same display whatever order the facets were typed in', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const token = await adaKnownByNameAndPhone(businessId);

    const nameFirst = await gateway.tokenise(businessId, 'Ada Obi on 08031234567 paid 20k');
    const phoneFirst = await gateway.tokenise(businessId, '08031234567 is Ada Obi, paid 20k');
    expect(phoneFirst.tokens.get(token)).toBe(nameFirst.tokens.get(token));
  });

  it('shows one number once when it is typed in two formats', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const tokenised = await gateway.tokenise(
      businessId,
      '08031234567 paid, call +234 803 123 4567 tomorrow',
    );
    const [token] = [...tokenised.tokens.keys()];
    expect(tokenised.tokens.size).toBe(1);
    expect(tokenised.tokens.get(token!)).toBe('08031234567');
  });

  it('keeps two different customers apart', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const ada = await adaKnownByNameAndPhone(businessId);
    const bola = (await gateway.resolveMention(businessId, 'Bola Ade')).token;
    const tokenised = await gateway.tokenise(businessId, 'Ada Obi and Bola Ade paid');
    expect(tokenised.tokens.get(ada)).toBe('Ada Obi');
    expect(tokenised.tokens.get(bola)).toBe('Bola Ade');
  });
});

describe('a token is one opaque span (G-60)', () => {
  /** A customer whose token we choose, known by a phone number. */
  async function customerWithToken(businessId: string, token: string, phone: string) {
    await customersRepo.createCustomerWithIdentities(db, businessId, token, [
      {
        facet: 'phone',
        ciphertext: encryptFacet(phone, config.vaultKey, `${businessId}:phone`),
        matchKey: matchKeyFor(businessId, 'phone', normaliseFacet('phone', phone), config.matchKey),
      },
    ]);
  }

  it.each([
    ['at the start', '08031234567 paid 20k'],
    ['in the middle', 'today 08031234567 paid 20k'],
    ['beside punctuation', 'paid by (08031234567).'],
  ])('survives byte for byte %s, even when a stored name spells part of it', async (_, text) => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    await customerWithToken(businessId, 'CUSTOMER_ABC', '08031234567');
    /* Names that spell the token's own words, and one that runs past it. */
    await gateway.resolveMention(businessId, 'Abc');
    await gateway.resolveMention(businessId, 'Customer');
    await gateway.resolveMention(businessId, 'Abc Paid');

    const tokenised = await gateway.tokenise(businessId, text);
    expect(tokenised.text).toBe(text.replace('08031234567', 'CUSTOMER_ABC'));
    expect(rehydrate(tokenised.text, tokenised.tokens)).toBe(text);
  });

  it('keeps two tokens whole and still replaces a real name beside them', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    await customerWithToken(businessId, 'CUSTOMER_ABC', '08031234567');
    await customerWithToken(businessId, 'CUSTOMER_XYZ', '08099998888');
    await gateway.resolveMention(businessId, 'Abc');
    await gateway.resolveMention(businessId, 'Xyz');
    const bola = (await gateway.resolveMention(businessId, 'Bola Ade')).token;

    const text = 'Bola Ade, 08031234567 and 08099998888 paid Bola Ade';
    const tokenised = await gateway.tokenise(businessId, text);
    expect(tokenised.text).toBe(`${bola}, CUSTOMER_ABC and CUSTOMER_XYZ paid ${bola}`);
    expect(rehydrate(tokenised.text, tokenised.tokens)).toBe(text);
  });

  it('never reads a token the merchant pasted back as a name', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    await customerWithToken(businessId, 'CUSTOMER_ABC', '08031234567');
    await gateway.resolveMention(businessId, 'Abc');
    const tokenised = await gateway.tokenise(businessId, 'did CUSTOMER_ABC pay?');
    expect(tokenised.text).toBe('did CUSTOMER_ABC pay?');
  });
});

describe('a storefront checkout attaches the typed name only when it is free (G-60)', () => {
  it('attaches a new name to a new phone', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const resolved = await gateway.resolveStorefrontCustomer(businessId, 'Ada Obi', '08031234567');
    const named = await gateway.resolveMention(businessId, 'Ada Obi');
    expect(named.customerId).toBe(resolved!.customerId);
  });

  it('keeps the phone anchor and merges nothing when the name is another customer', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const other = await gateway.resolveMention(businessId, 'Ada Obi');

    const resolved = await gateway.resolveStorefrontCustomer(businessId, 'Ada Obi', '08031234567');
    expect(resolved!.customerId).not.toBe(other.customerId);
    /* The name still belongs to the customer who had it; the phone anchors
     * a separate record, and nothing moved between them. */
    expect((await gateway.resolveMention(businessId, 'Ada Obi')).customerId).toBe(other.customerId);
    const facets = await customersRepo.identitiesForCustomer(db, businessId, resolved!.customerId);
    expect(facets.map((f) => f.facet)).toEqual(['phone']);
  });

  it('does not swallow a failure that is not an identity conflict', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_name_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.facet = 'name' THEN RAISE EXCEPTION 'g60: the vault is unavailable'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_name_fails BEFORE INSERT ON customer_identities
          FOR EACH ROW EXECUTE FUNCTION g60_name_fails()`);

      const failure = await gateway
        .resolveStorefrontCustomer(businessId, 'Ada Obi', '08031234567')
        .then(
          () => null,
          (error: unknown) => error as Error,
        );
      /* It surfaces, with the database's reason and nothing it was writing:
       * no ciphertext, no match key, no statement. */
      expect(failure?.message).toMatch(/the vault is unavailable/);
      expect(failure?.message).not.toMatch(/insert into|params|v[0-9]\./i);
      expect(failure?.message).not.toContain('Ada Obi');
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_name_fails ON customer_identities`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_name_fails()`);
      await closeOwner();
    }
  });
});

describe('every name the product can store is recognised (G-60 final review)', () => {
  const SEVEN = 'Alhaji Musa Ibrahim Chukwu Emeka Obi Junior';
  /* 80 characters: the longest name the contracts let anyone store. */
  const LONGEST =
    'Alhaji Ibrahim Musa Abubakar Sani Danjuma Chukwuemeka Obi Junior Ade Bello Okafo';

  it('the longest fixture is exactly the contract limit', () => {
    expect(LONGEST.length).toBe(80);
  });

  it.each([
    ['a seven-word name', SEVEN, (n: string) => `${n} paid 20k for 2 wigs`],
    ['the longest storable name', LONGEST, (n: string) => `${n} paid 20k for 2 wigs`],
    ['a long name beside a phone', SEVEN, (n: string) => `${n} 08031234567 paid 20k`],
    ['a long name beside an email', SEVEN, (n: string) => `${n} ada@mail.com paid 20k`],
  ])('keeps %s away from the model', async (_, name, sentence) => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { token } = await gateway.resolveMention(businessId, name);
    const tokenised = await gateway.tokenise(businessId, sentence(name));
    for (const word of ['Alhaji', 'Ibrahim', 'Junior']) expect(tokenised.text).not.toContain(word);
    expect(tokenised.text).toContain(token);
    expect(tokenised.text).toContain('20k');
  });

  it('does not make long prose somebody else', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    await gateway.resolveMention(businessId, SEVEN);
    const prose = 'sold seven bales of ankara and two cartons of lace to the man from Kano for 20k';
    const tokenised = await gateway.tokenise(businessId, prose);
    expect(tokenised.text).toBe(prose);
  });
});

describe('a name beside a token is still a name (G-60 final review)', () => {
  it.each([
    'Ada Obi-08031234567 paid',
    'Ada Obi08031234567 paid',
    '08031234567-Ada Obi paid',
    '08031234567Ada Obi paid',
    'Ada Obi,ada@mail.com paid',
    '08031234567 Ada Obi 08099998888 paid',
  ])('tokenises the known name in %j and keeps every token whole', async (text) => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { token } = await gateway.resolveMention(businessId, 'Ada Obi');
    const tokenised = await gateway.tokenise(businessId, text);
    expect(tokenised.text).not.toContain('Ada');
    expect(tokenised.text).not.toContain('Obi');
    expect(tokenised.text).toContain(token);
    expect(tokenised.text).not.toMatch(/\d{7}/);
    expect(rehydrate(tokenised.text, tokenised.tokens)).toBe(text);
  });
});

describe('a resolved mention composes with what the merchant typed (G-60 final review)', () => {
  async function live(businessId: string, text: string) {
    const tokenised = await gateway.tokenise(businessId, text);
    return {
      displays: new Map(tokenised.tokens),
      facets: new Map([...tokenised.facets].map(([t, f]) => [t, [...f]])),
    };
  }

  it('adds the name to the phone shown for the same customer, once', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const table = await live(businessId, '08031234567 paid 20k');
    const [token] = [...table.displays.keys()];
    gateway.noteMention(table, token!, 'Ada Obi');
    expect(table.displays.get(token!)).toBe('Ada Obi (08031234567)');
    gateway.noteMention(table, token!, 'ada  obi');
    expect(table.displays.get(token!)).toBe('Ada Obi (08031234567)');
  });

  it('never folds one customer into another', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const table = await live(businessId, '08031234567 and 08099998888 paid');
    const [ada, bola] = [...table.displays.keys()];
    gateway.noteMention(table, bola!, 'Bola Ade');
    expect(table.displays.get(ada!)).toBe('08031234567');
    expect(table.displays.get(bola!)).toBe('Bola Ade (08099998888)');
  });
});
