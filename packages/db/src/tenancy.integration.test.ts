/**
 * The test the whole tenancy design rests on (MASTER-PLAN 5.2.6, 4.4 #2).
 *
 * `withBusiness()` pins `app.business_id` with `set_config(..., true)`, which
 * scopes it to the transaction. Everything about tenant safety depends on that
 * claim being true *over a pooled connection that other tenants also use* —
 * and that is not something types or code review can establish. It needs a real
 * server, a real pool, and two real tenants.
 *
 * Runs as `rekoda_app`: not the table owner, no BYPASSRLS, so the policies are
 * live. Run it as a superuser and every assertion here passes for the wrong
 * reason.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { products } from './schema/commerce.js';
import { identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  // max: 1 is the point. Every statement below is forced onto ONE physical
  // connection, so a `set_config` that outlived its transaction would be
  // visible to the next tenant immediately rather than one time in fifty.
  ({ db, close } = createDb(urls.app, { max: 1 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

/**
 * Assert on the reason PostgreSQL refused, not on the wrapper around it.
 *
 * Drivers wrap errors, and the wrapping changes: drizzle 0.45 began raising a
 * `DrizzleQueryError` whose message is "Failed query: …" with the real
 * PostgreSQL error demoted to `.cause`. A test matching `error.message` then
 * silently stops checking the policy and starts checking the ORM's phrasing —
 * it still passes when the database rejects for the WRONG reason, and fails
 * when nothing is wrong at all.
 *
 * Walking the cause chain keeps the assertion pointed at the database.
 */
async function expectRejectionBecause(
  operation: Promise<unknown> | (() => Promise<unknown>),
  pattern: RegExp,
): Promise<void> {
  try {
    await (typeof operation === 'function' ? operation() : operation);
  } catch (error) {
    const reasons: string[] = [];
    for (let e: unknown = error, depth = 0; e && depth < 10; depth++) {
      if (e instanceof Error) {
        reasons.push(e.message);
        e = (e as Error & { cause?: unknown }).cause;
      } else {
        reasons.push(String(e));
        break;
      }
    }
    expect(reasons.join(' | ')).toMatch(pattern);
    return;
  }
  throw new Error(`expected a rejection matching ${pattern}, but it resolved`);
}

async function seedTenant(name: string, phone: string) {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: 'Fashion & clothing',
    ownerUserId: user.id,
  });
  await withBusiness(db, business.id, async (tx) => {
    await tx.insert(products).values({
      businessId: business.id,
      name: `${name} signature wrapper`,
      unitPriceK: 1_250_000,
    });
  });
  return { user, business };
}

describe('tenant isolation over a pooled connection', () => {
  it('never shows one tenant another tenant rows, on the same reused connection', async () => {
    const ada = await seedTenant('Ada Fashion', '+2348030000001');
    const bola = await seedTenant('Bola Electronics', '+2348030000002');

    const adaRows = await withBusiness(db, ada.business.id, (tx) => tx.select().from(products));
    const bolaRows = await withBusiness(db, bola.business.id, (tx) => tx.select().from(products));

    expect(adaRows).toHaveLength(1);
    expect(bolaRows).toHaveLength(1);
    expect(adaRows[0]!.name).toContain('Ada Fashion');
    expect(bolaRows[0]!.name).toContain('Bola Electronics');
    expect(adaRows[0]!.businessId).toBe(ada.business.id);
    expect(bolaRows[0]!.businessId).toBe(bola.business.id);
  });

  it('returns ZERO rows when no tenant is pinned, not every row', async () => {
    await seedTenant('Ada Fashion', '+2348030000001');
    await seedTenant('Bola Electronics', '+2348030000002');

    // The failure this guards is fail-OPEN: a policy written without the
    // nullif() guard makes `business_id = NULL` unknown for every row, which
    // some readings of "no filter" turn into "no restriction".
    const unpinned = await db.select().from(products);
    expect(unpinned).toHaveLength(0);

    const unpinnedBusinesses = await db.execute(sql`SELECT count(*)::int AS n FROM businesses`);
    expect([...unpinnedBusinesses][0]).toMatchObject({ n: 0 });
  });

  it('does not leak the pin into the NEXT transaction on the same connection', async () => {
    const ada = await seedTenant('Ada Fashion', '+2348030000001');

    await withBusiness(db, ada.business.id, async (tx) => {
      expect(await tx.select().from(products)).toHaveLength(1);
    });

    // Same physical connection, immediately after. SET LOCAL semantics say the
    // setting died with the commit; this is the assertion that says so.
    expect(await db.select().from(products)).toHaveLength(0);
  });

  it('refuses to write into another tenant even when the id is supplied explicitly', async () => {
    const ada = await seedTenant('Ada Fashion', '+2348030000001');
    const bola = await seedTenant('Bola Electronics', '+2348030000002');

    // Pinned to Ada, deliberately writing Bola's business_id: the policy's
    // WITH CHECK has to reject it. Without WITH CHECK, USING alone would let a
    // tenant insert rows it then cannot see — a silent cross-tenant write.
    await expectRejectionBecause(
      withBusiness(db, ada.business.id, (tx) =>
        tx.insert(products).values({
          businessId: bola.business.id,
          name: 'smuggled',
          unitPriceK: 1,
        }),
      ),
      /row-level security/i,
    );
  });
});

describe('business creation under the tenant_self policy', () => {
  it('creates the business and its owner membership (MASTER-PLAN 4.4 #5)', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348030000003');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Chidi Provisions',
      businessType: 'Provisions & groceries',
      ownerUserId: user.id,
    });

    expect(business.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(business.plan).toBe('trial');

    const memberships = await identity.membershipsForUser(db, user.id);
    expect(memberships).toEqual([{ businessId: business.id, role: 'owner' }]);
  });

  it('reads a business back only under its own pin', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348030000004');
    const a = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const b = await identity.createBusinessWithOwner(db, {
      name: 'Ada Logistics',
      businessType: null,
      ownerUserId: user.id,
    });

    expect((await identity.businessById(db, a.id))?.name).toBe('Ada Fashion');
    expect((await identity.businessById(db, b.id))?.name).toBe('Ada Logistics');
  });

  it('gives one identity to a number that signs in twice', async () => {
    const first = await identity.upsertUserByPhone(db, '+2348030000005');
    const second = await identity.upsertUserByPhone(db, '+2348030000005');
    expect(second.id).toBe(first.id);
  });

  it('survives two devices verifying the same number at once', async () => {
    // The read-then-write version of upsertUserByPhone loses this race and
    // splits the merchant across two ledgers.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => identity.upsertUserByPhone(db, '+2348030000006')),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });
});

describe('the app role is constrained, not trusted', () => {
  it('cannot rewrite history on append-only tables', async () => {
    const ada = await seedTenant('Ada Fashion', '+2348030000001');
    await expectRejectionBecause(
      withBusiness(db, ada.business.id, (tx) =>
        tx.execute(sql`DELETE FROM ledger_entries WHERE business_id = ${ada.business.id}::uuid`),
      ),
      /permission denied/i,
    );
  });

  it('cannot turn row-level security off', async () => {
    await expectRejectionBecause(
      db.execute(sql`ALTER TABLE products DISABLE ROW LEVEL SECURITY`),
      /must be owner|permission denied/i,
    );
  });
});
