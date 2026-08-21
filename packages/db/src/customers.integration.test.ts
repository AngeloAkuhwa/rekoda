/**
 * The privacy gateway against a real database (ADR 0005).
 *
 * The properties worth testing here are the ones that only appear when
 * ciphertext, a keyed match, and row-level security meet: that a returning
 * customer is recognised, that no plaintext identity is ever stored, and that
 * one business cannot see another's customers even holding the same key.
 *
 * `@rekoda/core` is a devDependency of this package for exactly this file. The
 * repository under test deliberately knows no crypto — it stores whatever
 * ciphertext it is handed — so proving the pair works together means doing
 * here what the API layer will do in production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { customersRepo, identity, issueRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';
import { decryptFacet, encryptFacet, matchKeyFor, normaliseFacet } from '@rekoda/core/vault';
import { generateCustomerToken } from '@rekoda/core/privacy';

const VAULT_KEY = 'a'.repeat(64);
const MATCH_KEY = 'c'.repeat(64);
const random = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256));

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 2 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(name: string, phone: string) {
  const user = await identity.upsertUserByPhone(db, phone);
  return identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
}

/** What the API layer will do: encrypt, derive the match key, store. */
async function rememberCustomer(businessId: string, phone: string, displayName: string) {
  const normalised = normaliseFacet('phone', phone);
  const matchKey = matchKeyFor(businessId, 'phone', normalised, MATCH_KEY);

  const existing = await customersRepo.findCustomerByMatchKey(db, businessId, 'phone', matchKey);
  if (existing) return { ...existing, isNew: false };

  const created = await customersRepo.createCustomerWithIdentities(
    db,
    businessId,
    generateCustomerToken(random),
    [
      { facet: 'phone', ciphertext: encryptFacet(phone, VAULT_KEY), matchKey },
      { facet: 'name', ciphertext: encryptFacet(displayName, VAULT_KEY), matchKey: null },
    ],
  );
  return { ...created, isNew: true };
}

describe('recognising a customer', () => {
  it('creates once and recognises thereafter, however the number is written', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000101');

    const first = await rememberCustomer(business.id, '08031111111', 'Ada Obi');
    expect(first.isNew).toBe(true);

    // The same person, typed differently. If these produced two customers the
    // merchant would see one buyer as two, with the debt split between them.
    for (const form of ['+2348031111111', '234 803 111 1111', '0803-111-1111']) {
      const again = await rememberCustomer(business.id, form, 'Ada Obi');
      expect(again.isNew).toBe(false);
      expect(again.id).toBe(first.id);
      expect(again.token).toBe(first.token);
    }
  });

  it('gives the customer a token, and only a token, on the Zone 2 row', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000102');
    const customer = await rememberCustomer(business.id, '08031111111', 'Ada Obi');
    expect(customer.token).toMatch(/^CUSTOMER_[0-9A-HJKMNP-TV-Z]{3}$/);
  });
});

describe('what is actually written to disk', () => {
  it('stores no plaintext name or number anywhere', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000103');
    await rememberCustomer(business.id, '08031111111', 'Ada Obi');

    // Read the raw table as the owner, bypassing every application path.
    const { default: postgres } = await import('postgres');
    const raw = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      const rows = await raw`SELECT facet, ciphertext, match_key FROM customer_identities`;
      expect(rows.length).toBe(2);
      const blob = JSON.stringify(rows);
      // The two things a leaked dump must not contain.
      expect(blob).not.toContain('Ada Obi');
      expect(blob).not.toContain('08031111111');
      expect(blob).not.toContain('8031111111');
      for (const row of rows) expect(row['ciphertext']).toMatch(/^v1\./);
    } finally {
      await raw.end();
    }
  });

  it('round-trips through the database and back to plaintext', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000104');
    const customer = await rememberCustomer(business.id, '08031111111', 'Ada Obi');

    const stored = await customersRepo.identitiesForCustomer(db, business.id, customer.id);
    const byFacet = Object.fromEntries(stored.map((s) => [s.facet, s.ciphertext]));
    expect(decryptFacet(byFacet['name']!, VAULT_KEY)).toBe('Ada Obi');
    expect(decryptFacet(byFacet['phone']!, VAULT_KEY)).toBe('08031111111');
  });
});

describe('tenant isolation of customer identity', () => {
  it('does not recognise another business customer, even with the same key', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348030000105');
    const bola = await seedBusiness('Bola Electronics', '+2348030000106');

    const atAda = await rememberCustomer(ada.id, '08031111111', 'Chidi');
    const atBola = await rememberCustomer(bola.id, '08031111111', 'Chidi');

    // Same human, same phone, same secrets — two separate customer records,
    // because the match key mixes in the business id. Without that, a dump
    // would show which merchants share a buyer.
    expect(atBola.isNew).toBe(true);
    expect(atBola.id).not.toBe(atAda.id);
  });

  it('returns nothing when no tenant is pinned', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000107');
    await rememberCustomer(business.id, '08031111111', 'Ada Obi');

    expect(await db.select().from((await import('./schema/privacy.js')).customers)).toHaveLength(0);
    const count = await db.execute(sql`SELECT count(*)::int AS n FROM customer_identities`);
    expect([...count][0]).toMatchObject({ n: 0 });
  });
});

describe('erasure', () => {
  it('removes one facet without touching the others', async () => {
    // "Forget my address but keep the invoices" has to be possible — which is
    // why identities are one row per facet rather than a single blob.
    const business = await seedBusiness('Ada Fashion', '+2348030000108');
    const customer = await rememberCustomer(business.id, '08031111111', 'Ada Obi');

    expect(await customersRepo.eraseFacet(db, business.id, customer.id, 'name')).toBe(1);

    const left = await customersRepo.identitiesForCustomer(db, business.id, customer.id);
    expect(left.map((l) => l.facet)).toEqual(['phone']);
  });
});

/**
 * Joining two records the merchant has confirmed are one person.
 *
 * The merchant is asked in chat and the answer arrives here. What matters at
 * this level is that the join moves ciphertext without opening it, that the
 * orphan really goes, and above all that a record with financial history is
 * REFUSED: moving a merchant's invoices is not something a `yes` in a chat
 * should be able to do.
 */
describe('linking two customers', () => {
  /** A bare customer holding one facet, as the gateway mints one. */
  async function mintCustomer(businessId: string, facet: 'phone' | 'email', value: string) {
    return customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      generateCustomerToken(random),
      [
        {
          facet,
          ciphertext: encryptFacet(value, VAULT_KEY),
          matchKey: matchKeyFor(businessId, facet, normaliseFacet(facet, value), MATCH_KEY),
        },
      ],
    );
  }

  const link = (businessId: string, survivorId: string, orphanId: string) =>
    withBusiness(db, businessId, (tx) =>
      customersRepo.linkCustomers(tx, businessId, survivorId, orphanId),
    );

  it('moves the facet across and takes the orphan with it', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000201');
    const byPhone = await mintCustomer(business.id, 'phone', '08031234567');
    const byEmail = await mintCustomer(business.id, 'email', 'ada@example.com');

    expect(await link(business.id, byPhone.id, byEmail.id)).toBe(true);

    /* Both facets on one record, and the email still decrypts: an UPDATE of
     * customer_id rather than a decrypt-and-reinsert, so a merge never opens
     * the vault. */
    const facets = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, byPhone.id),
    );
    expect(facets.map((f) => f.facet).sort()).toEqual(['email', 'phone']);
    const email = facets.find((f) => f.facet === 'email');
    expect(decryptFacet(email!.ciphertext, VAULT_KEY)).toBe('ada@example.com');

    const orphan = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM customers WHERE id = ${byEmail.id}::uuid`,
      ),
    );
    expect(Number([...orphan][0]?.n)).toBe(0);
  });

  it('REFUSES a record that has an invoice against it', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000202');
    const byPhone = await mintCustomer(business.id, 'phone', '08031234567');
    const byEmail = await mintCustomer(business.id, 'email', 'ada@example.com');

    await withBusiness(db, business.id, (tx) =>
      issueRepo.issueSale(tx, {
        businessId: business.id,
        customerId: byEmail.id,
        customerToken: byEmail.token,
        items: [{ name: 'wig', quantity: 1, unitPriceK: 5_000_000 }],
        subtotalK: 5_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 5_000_000,
        paidK: 0,
        balanceDueK: 5_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-1',
        actor: 'system',
      }),
    );

    /* A record with history needs its invoices moved too, and moving a
     * merchant's financial history is a different operation with different
     * consequences. Refused, and both records stand. */
    expect(await link(business.id, byPhone.id, byEmail.id)).toBe(false);
    const still = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM customers WHERE id = ${byEmail.id}::uuid`,
      ),
    );
    expect(Number([...still][0]?.n)).toBe(1);
  });

  it('refuses to link a record to itself, or to one that has gone', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000203');
    const one = await mintCustomer(business.id, 'phone', '08031234567');

    expect(await link(business.id, one.id, one.id)).toBe(false);
    expect(await link(business.id, '00000000-0000-4000-8000-000000000000', one.id)).toBe(false);
  });

  it('cannot reach another tenant record, whatever id it is handed', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348030000204');
    const bola = await seedBusiness('Bola Electronics', '+2348030000205');
    const adasCustomer = await mintCustomer(ada.id, 'phone', '08031234567');
    const bolasCustomer = await mintCustomer(bola.id, 'phone', '08039999999');

    // Bola's tenant pin, Ada's customer id. Row-level security answers first.
    expect(await link(bola.id, bolasCustomer.id, adasCustomer.id)).toBe(false);
    const survived = await withBusiness(db, ada.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM customers WHERE id = ${adasCustomer.id}::uuid`,
      ),
    );
    expect(Number([...survived][0]?.n)).toBe(1);
  });
});
