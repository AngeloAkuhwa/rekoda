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

/**
 * G-60: adding a facet to a customer has an explicit contract. A facet that
 * already keys ANOTHER customer is an `IdentityConflict`, never a raw
 * database error and never a second owner; the same facet on the same
 * customer is already done; anything else is a real failure and surfaces.
 */
describe('adding a facet to a known customer (G-60)', () => {
  const nameFacet = (businessId: string, name: string) => ({
    facet: 'name' as const,
    ciphertext: encryptFacet(name, VAULT_KEY),
    matchKey: matchKeyFor(businessId, 'name', normaliseFacet('name', name), MATCH_KEY),
  });

  async function ownersOf(businessId: string, matchKey: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ customer_id: string }>(sql`
        SELECT customer_id FROM customer_identities
         WHERE business_id = ${businessId}::uuid AND match_key = ${matchKey}`),
    );
    return [...rows].map((r) => r.customer_id);
  }

  it('attaches a facet nobody holds', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000201');
    const ada = await rememberCustomer(business.id, '08031111111', 'Ada Obi');
    const facet = nameFacet(business.id, 'Ada Obi');

    await expect(customersRepo.addIdentityFacet(db, business.id, ada.id, facet)).resolves.toBe(
      'attached',
    );
    expect(await ownersOf(business.id, facet.matchKey)).toEqual([ada.id]);
  });

  it('treats the same facet on the same customer as already done', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000202');
    const ada = await rememberCustomer(business.id, '08031111111', 'Ada Obi');
    const facet = nameFacet(business.id, 'Ada Obi');
    await customersRepo.addIdentityFacet(db, business.id, ada.id, facet);

    await expect(customersRepo.addIdentityFacet(db, business.id, ada.id, facet)).resolves.toBe(
      'already-attached',
    );
    expect(await ownersOf(business.id, facet.matchKey)).toEqual([ada.id]);
  });

  it('refuses a facet that keys another customer, as an IdentityConflict', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000203');
    const ada = await rememberCustomer(business.id, '08031111111', 'Ada Obi');
    const bola = await rememberCustomer(business.id, '08032222222', 'Bola Ade');
    const facet = nameFacet(business.id, 'Ada Obi');
    await customersRepo.addIdentityFacet(db, business.id, ada.id, facet);

    await expect(
      customersRepo.addIdentityFacet(db, business.id, bola.id, facet),
    ).rejects.toBeInstanceOf(customersRepo.IdentityConflict);
    expect(await ownersOf(business.id, facet.matchKey)).toEqual([ada.id]);
  });

  it('gives one owner when two customers race for the same facet', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000204');
    const ada = await rememberCustomer(business.id, '08031111111', 'Ada Obi');
    const bola = await rememberCustomer(business.id, '08032222222', 'Bola Ade');
    const facet = nameFacet(business.id, 'Ada Obi');

    const outcomes = await Promise.allSettled([
      customersRepo.addIdentityFacet(db, business.id, ada.id, facet),
      customersRepo.addIdentityFacet(db, business.id, bola.id, facet),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      customersRepo.IdentityConflict,
    );
    const owners = await ownersOf(business.id, facet.matchKey);
    expect(owners).toHaveLength(1);
  });

  it('lets a failure that is not a conflict surface as itself', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000205');
    const facet = nameFacet(business.id, 'Ada Obi');
    /* No such customer: a foreign-key failure, not somebody else's facet. */
    const missing = '00000000-0000-4000-8000-000000000000';
    const failure = await customersRepo.addIdentityFacet(db, business.id, missing, facet).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(customersRepo.IdentityConflict);
    /* The database's reason, never the row it was writing. */
    expect((failure as Error).message).toMatch(/foreign key/i);
    expect((failure as Error).message).not.toContain(facet.ciphertext);
    expect((failure as Error).message).not.toContain(facet.matchKey);
    expect(await ownersOf(business.id, facet.matchKey)).toEqual([]);
  });

  /* Codex P2 on #271: when the facet is taken and the lookup of its holder
   * then fails, that failure is scrubbed like the insert's. */
  it('scrubs a failure of the holder lookup that follows a conflict', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000208');
    const ada = await rememberCustomer(business.id, '08031111111', 'Ada Obi');
    const bola = await rememberCustomer(business.id, '08032222222', 'Bola Ade');
    const facet = nameFacet(business.id, 'Ada Obi');
    await customersRepo.addIdentityFacet(db, business.id, ada.id, facet);

    const { db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 1 });
    let failure: unknown = null;
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_lookup_fails() RETURNS boolean AS $$
        BEGIN RAISE EXCEPTION 'g60: the lookup is unavailable'; END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE POLICY g60_lookup_fails ON customer_identities AS RESTRICTIVE FOR SELECT
          USING (g60_lookup_fails())`);
      failure = await customersRepo.addIdentityFacet(db, business.id, bola.id, facet).then(
        () => null,
        (error: unknown) => error,
      );
    } finally {
      await ownerDb.execute(sql`DROP POLICY IF EXISTS g60_lookup_fails ON customer_identities`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_lookup_fails()`);
      await closeOwner();
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(customersRepo.IdentityConflict);
    expect((failure as Error).message).toMatch(/the lookup is unavailable/);
    expect((failure as Error).message).not.toContain(facet.matchKey);
    expect((failure as Error).message).not.toMatch(/select|params/i);
  });

  /* Owner review of #271: the holder of a taken facet is erased between
   * the conflict and the lookup. The facet is free, so this is no conflict:
   * the attachment is tried again and wins. */
  it('attaches, never a false conflict, when the holder is erased mid-way', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000209');
    const ada = await rememberCustomer(business.id, '08031111111', 'Ada Obi');
    const bola = await rememberCustomer(business.id, '08032222222', 'Bola Ade');
    const facet = nameFacet(business.id, 'Ada Obi');
    await customersRepo.addIdentityFacet(db, business.id, ada.id, facet);

    const { db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 1 });
    let outcome: unknown;
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g60_erase_once`);
      /* The first holder lookup erases the holder and does not see it, as an
       * erasure committed between the two statements would leave it. */
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_erase_holder(k text) RETURNS boolean
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g60_erase_once') = 1 THEN
            DELETE FROM customer_identities WHERE match_key = k AND facet = 'name';
            RETURN false;
          END IF;
          RETURN true;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE POLICY g60_erase_holder ON customer_identities AS RESTRICTIVE FOR SELECT
          USING (match_key IS DISTINCT FROM ${sql.raw(`'${facet.matchKey}'`)} OR g60_erase_holder(match_key))`);
      outcome = await customersRepo.addIdentityFacet(db, business.id, bola.id, facet).then(
        (r) => r,
        (error: unknown) => error,
      );
    } finally {
      await ownerDb.execute(sql`DROP POLICY IF EXISTS g60_erase_holder ON customer_identities`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_erase_holder(text)`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g60_erase_once`);
      await closeOwner();
    }
    expect(outcome).toBe('attached');
    expect(await ownersOf(business.id, facet.matchKey)).toEqual([bola.id]);
  });

  it('keeps the database error code on a failure it surfaces, and nothing unsafe', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000210');
    const facet = nameFacet(business.id, 'Ada Obi');
    const missing = '00000000-0000-4000-8000-000000000000';
    const failure = (await customersRepo.addIdentityFacet(db, business.id, missing, facet).then(
      () => null,
      (error: unknown) => error,
    )) as Error & { code?: string };
    expect(failure.code).toBe('23503');
    expect(failure).not.toBeInstanceOf(customersRepo.IdentityConflict);
    expect(JSON.stringify(failure)).not.toContain(facet.matchKey);
    expect(JSON.stringify(failure)).not.toContain(facet.ciphertext);
    expect(String((failure as { cause?: unknown }).cause ?? '')).toBe('');
  });

  it('cannot attach a facet to another business customer', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348030000206');
    const bola = await seedBusiness('Bola Electronics', '+2348030000207');
    const theirs = await rememberCustomer(ada.id, '08031111111', 'Ada Obi');
    const facet = nameFacet(bola.id, 'Ada Obi');

    const failure = await customersRepo.addIdentityFacet(db, bola.id, theirs.id, facet).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(customersRepo.IdentityConflict);
    expect(await ownersOf(bola.id, facet.matchKey)).toEqual([]);
    expect(await ownersOf(ada.id, facet.matchKey)).toEqual([]);
  });
});

describe('the known-name lookup takes any number of keys (G-60 final review, round 4)', () => {
  it('answers 70,000 keys in one call', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000211');
    const keys = Array.from({ length: 70_000 }, (_, i) => `k${i}`);
    await expect(customersRepo.namesByMatchKeys(db, business.id, keys)).resolves.toEqual([]);
  });
});

/**
 * Codex on #271: a confirmed link bringing a trusted name onto a phone
 * customer, while a storefront checkout attaches its untrusted name to the
 * same customer. Both must contend on ONE lock, so the customer ends with one
 * name: the link's trusted name when the link commits first.
 */
describe('a link and a storefront name attach at once', () => {
  it('leaves one name, the trusted one, when the link commits first', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000301');
    const phone = '08035551234';
    const survivor = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      generateCustomerToken(random),
      [
        {
          facet: 'phone',
          ciphertext: encryptFacet(phone, VAULT_KEY),
          matchKey: matchKeyFor(business.id, 'phone', normaliseFacet('phone', phone), MATCH_KEY),
        },
      ],
    );
    const orphan = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      generateCustomerToken(random),
      [
        {
          facet: 'name',
          ciphertext: encryptFacet('Chidi Okafor', VAULT_KEY),
          matchKey: matchKeyFor(
            business.id,
            'name',
            normaliseFacet('name', 'Chidi Okafor'),
            MATCH_KEY,
          ),
        },
      ],
    );

    const { db: watcher, close: closeWatcher } = createDb(urls.owner, { max: 1 });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let linked!: () => void;
    const moved = new Promise<void>((r) => (linked = r));
    try {
      /* The link moves the trusted name, then holds its transaction open. */
      const linking = withBusiness(db, business.id, async (tx) => {
        const ok = await customersRepo.linkCustomers(tx, business.id, survivor.id, orphan.id);
        linked();
        await held;
        return ok;
      });
      await moved;
      /* The checkout starts while the link is uncommitted. */
      const attaching = customersRepo.addIdentityFacet(
        db,
        business.id,
        survivor.id,
        { facet: 'name', ciphertext: encryptFacet('Chidi O.', VAULT_KEY), matchKey: null },
        { unlessTheCustomerHasOne: true },
      );
      /* Wait until the checkout is blocked on a lock, then let the link commit. */
      for (let i = 0; i < 100; i++) {
        const [row] = [
          ...(await watcher.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`,
          )),
        ];
        if (Number(row?.n) > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      release();
      expect(await linking).toBe(true);
      expect(await attaching).toBe('kept-existing');
    } finally {
      release();
      await closeWatcher();
    }

    const names = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ trusted: boolean }>(sql`
        SELECT match_key IS NOT NULL AS trusted FROM customer_identities
         WHERE business_id = ${business.id}::uuid AND customer_id = ${survivor.id}::uuid
           AND facet = 'name'`),
    );
    expect([...names]).toEqual([{ trusted: true }]);
  });
});

/**
 * Codex on #271, the inverse: the survivor holds a trusted name and the
 * orphan is a new phone customer that a storefront checkout names at the
 * same moment. The link holds the advisory lock of BOTH customers, taken in
 * one order (sorted ids), so the checkout waits for it, and two links over
 * the same pair in opposite directions never deadlock.
 */
describe('a link and a checkout on the orphan, and opposite links', () => {
  const nameOf = (businessId: string, value: string) => ({
    facet: 'name' as const,
    ciphertext: encryptFacet(value, VAULT_KEY),
    matchKey: matchKeyFor(businessId, 'name', normaliseFacet('name', value), MATCH_KEY),
  });
  const phoneOf = (businessId: string, value: string) => ({
    facet: 'phone' as const,
    ciphertext: encryptFacet(value, VAULT_KEY),
    matchKey: matchKeyFor(businessId, 'phone', normaliseFacet('phone', value), MATCH_KEY),
  });
  const mint = (
    businessId: string,
    facet: ReturnType<typeof nameOf> | ReturnType<typeof phoneOf>,
  ) =>
    customersRepo.createCustomerWithIdentities(db, businessId, generateCustomerToken(random), [
      facet,
    ]);

  /** Hold a link's transaction open until released; resolves its result. */
  function holdLink(businessId: string, survivorId: string, orphanId: string) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let linked!: () => void;
    const done = new Promise<void>((r) => (linked = r));
    const result = withBusiness(db, businessId, async (tx) => {
      const ok = await customersRepo.linkCustomers(tx, businessId, survivorId, orphanId);
      linked();
      await held;
      return ok;
    });
    return { result, done, release };
  }

  async function waitingAdvisory(watcher: Db): Promise<number> {
    for (let i = 0; i < 100; i++) {
      const [row] = [
        ...(await watcher.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'advisory'`,
        )),
      ];
      if (Number(row?.n) > 0) return Number(row?.n);
      await new Promise((r) => setTimeout(r, 20));
    }
    return 0;
  }

  it('makes a checkout naming the orphan wait for the link, leaving one name', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000401');
    const survivor = await mint(business.id, nameOf(business.id, 'Chidi Okafor'));
    const orphan = await mint(business.id, phoneOf(business.id, '08035551234'));
    const { db: watcher, close: closeWatcher } = createDb(urls.owner, { max: 1 });
    const link = holdLink(business.id, survivor.id, orphan.id);
    try {
      await link.done;
      const attaching = customersRepo
        .addIdentityFacet(
          db,
          business.id,
          orphan.id,
          { facet: 'name', ciphertext: encryptFacet('Chidi O.', VAULT_KEY), matchKey: null },
          { unlessTheCustomerHasOne: true },
        )
        .then(
          (outcome) => outcome,
          () => 'refused' as const,
        );
      /* The checkout waits on the orphan's lock, which the link holds. */
      expect(await waitingAdvisory(watcher)).toBeGreaterThan(0);
      link.release();
      expect(await link.result).toBe(true);
      /* The orphan is gone, so the checkout cannot name it; its retry finds
       * the survivor by phone, which already has a name. */
      expect(await attaching).toBe('refused');
    } finally {
      link.release();
      await closeWatcher();
    }
    const names = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ trusted: boolean }>(sql`
        SELECT match_key IS NOT NULL AS trusted FROM customer_identities
         WHERE business_id = ${business.id}::uuid AND facet = 'name'`),
    );
    expect([...names]).toEqual([{ trusted: true }]);
    const phones = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ customer_id: string }>(sql`
        SELECT customer_id FROM customer_identities
         WHERE business_id = ${business.id}::uuid AND facet = 'phone'`),
    );
    expect([...phones].map((p) => p.customer_id)).toEqual([survivor.id]);
  });

  it('runs two opposite links over one pair one after the other, without deadlock', async () => {
    const business = await seedBusiness('Ada Fashion', '+2348030000402');
    const one = await mint(business.id, phoneOf(business.id, '08035550001'));
    const two = await mint(business.id, phoneOf(business.id, '08035550002'));
    const { db: watcher, close: closeWatcher } = createDb(urls.owner, { max: 1 });
    const first = holdLink(business.id, one.id, two.id);
    try {
      await first.done;
      const second = withBusiness(db, business.id, (tx) =>
        customersRepo.linkCustomers(tx, business.id, two.id, one.id),
      );
      expect(await waitingAdvisory(watcher)).toBeGreaterThan(0);
      first.release();
      expect(await first.result).toBe(true);
      /* The second finds its survivor already absorbed, and refuses. */
      expect(await second).toBe(false);
    } finally {
      first.release();
      await closeWatcher();
    }
    const customers = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM customers WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect([...customers].map((c) => c.id)).toEqual([one.id]);
  });
});
