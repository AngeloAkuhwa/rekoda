/**
 * The teardown itself, which every other integration test trusts.
 *
 * `truncateAll` is the one piece of the harness no suite asserts on directly,
 * and it is the piece that decides whether a test starts from a clean shelf or
 * from the previous test's leftovers. A bug here does not announce itself: it
 * makes some other suite fail somewhere else, or worse, pass because a row it
 * expected to be gone was still there.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, catalogueRepo, sql } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.owner, { max: 4 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const rowsIn = async (table: string): Promise<number> => {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`,
  );
  return Number([...rows][0]!.n);
};

describe('what teardown removes', () => {
  it('empties fixtures a test left behind', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348140000001');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Teardown probe',
      businessType: null,
      ownerUserId: user.id,
    });
    await withBusiness(db, business.id, (tx) =>
      catalogueRepo.createProduct(tx, business.id, { name: 'wig', unitPriceK: 1000 }),
    );
    expect(await rowsIn('businesses')).toBe(1);
    expect(await rowsIn('products')).toBe(1);

    await truncateAll(urls);

    expect(await rowsIn('businesses')).toBe(0);
    expect(await rowsIn('products')).toBe(0);
    expect(await rowsIn('users')).toBe(0);
  });

  it('reaches a table nobody remembered to name', async () => {
    /* The previous teardown listed its tables by hand, so a table added later
     * was simply never cleaned. This one reads the catalogue, and the proof is
     * that EVERY table outside the seeded set comes back empty rather than a
     * chosen few. */
    const leftovers = await db.execute<{ tablename: string; n: string }>(sql`
      SELECT tablename,
             (xpath('/row/c/text()',
                    query_to_xml('SELECT count(*) c FROM public.' || quote_ident(tablename),
                                 false, true, '')))[1]::text AS n
        FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT IN (
           'rekoda_migrations', 'entitlements', 'plan_versions', 'plan_prices',
           'plan_version_entitlements', 'allowance_versions', 'add_ons',
           'add_on_grants', 'usage_packs', 'provider_capabilities',
           'provider_cost_schedules')
    `);
    expect([...leftovers].filter((r) => Number(r.n) > 0)).toEqual([]);
  });

  it('deletes through the guards that refuse a delete', async () => {
    /* `journal_draft_lock`, `journal_draft_lines_lock` and
     * `accounts_mandatory_role_guard` exist to refuse deletion, and they are
     * right to: they protect a merchant's books. TRUNCATE never fired them;
     * DELETE would, which is why teardown suspends them. A business with a
     * seeded chart of accounts is enough to prove the accounts guard is not
     * blocking the wipe. */
    const user = await identity.upsertUserByPhone(db, '+2348140000002');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Guarded books',
      businessType: null,
      ownerUserId: user.id,
    });
    expect(await rowsIn('accounts')).toBeGreaterThan(0);

    await expect(truncateAll(urls)).resolves.toBeUndefined();
    expect(await rowsIn('accounts')).toBe(0);
    expect(business.id).toBeTruthy();
  });

  it('leaves the guards on for everyone else', async () => {
    /* Replica mode is set and reset inside teardown's own connection. If it
     * ever leaked, the next writer would be able to violate a foreign key. */
    const rows = await db.execute<{ role: string }>(
      sql`SELECT current_setting('session_replication_role') AS role`,
    );
    expect([...rows][0]!.role).toBe('origin');
  });
});

describe('what teardown preserves', () => {
  it('keeps the reference data migrations seeded', async () => {
    /* Not a taste: every suite reads the plan catalogue and the entitlement
     * keys, and nothing recreates them. Emptying these would not fail here, it
     * would fail somewhere else with an unrelated message. */
    for (const table of [
      'entitlements',
      'plan_versions',
      'plan_prices',
      'plan_version_entitlements',
      'allowance_versions',
      'add_ons',
      'usage_packs',
      'provider_capabilities',
      'provider_cost_schedules',
    ]) {
      expect({ table, rows: await rowsIn(table) }).toEqual({
        table,
        rows: expect.any(Number),
      });
      expect(await rowsIn(table)).toBeGreaterThan(0);
    }
  });

  it('keeps the migration ledger, so the next run does not re-apply history', async () => {
    expect(await rowsIn('rekoda_migrations')).toBeGreaterThan(0);
  });

  it('names only tables that exist', async () => {
    /* A typo in the keep-list would silently empty a catalogue every test
     * reads, and the failure would surface far from here. */
    const missing = await db.execute<{ name: string }>(sql`
      SELECT name FROM unnest(ARRAY[
        'rekoda_migrations', 'entitlements', 'plan_versions', 'plan_prices',
        'plan_version_entitlements', 'allowance_versions', 'add_ons',
        'add_on_grants', 'usage_packs', 'provider_capabilities',
        'provider_cost_schedules']) AS name
       WHERE name NOT IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
    `);
    expect([...missing]).toEqual([]);
  });
});
