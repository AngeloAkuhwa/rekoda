/**
 * Migration 0035, against real PostgreSQL.
 *
 * The migration moves ledger entries that balance sheets have already been
 * built from, so the claim worth proving is not that it runs. It is that it
 * moves exactly the merchant's own bank money and exactly none of the
 * provider's settlements, and that no total anywhere changes as a result.
 *
 * It is tested by writing entries the OLD way, on BANK_PAYSTACK, and running
 * the migration's own statement against them. A test that used the new
 * writers would prove nothing about the rows already in the database, which
 * are the only rows this migration exists for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDb, withBusiness, type Db } from './client.js';
import { identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;
/**
 * The migration runs as the OWNER, not as the application, and the
 * application could not run it if it tried: 0001_rls.sql revokes UPDATE on
 * ledger_entries from rekoda_app, which is what makes the ledger append-only.
 * A test that reached this through `db` would be testing a path that cannot
 * exist.
 */
let owner: postgres.Sql;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
  owner = postgres(urls.owner, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
  await close?.();
  await owner?.end();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Mama Chidi Stores',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** A posting written the way the code wrote them before ADR 0025. */
async function legacyPosting(businessId: string, sourceType: string, amountK: number) {
  await withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
      VALUES (${businessId}::uuid, ${`legacy ${sourceType}`}, ${sourceType}, 'x')
      RETURNING id
    `);
    const id = [...rows][0]!.id;
    await tx.execute(sql`
      INSERT INTO ledger_entries (business_id, transaction_id, account, debit_k, credit_k)
      VALUES (${businessId}::uuid, ${id}::uuid, 'BANK_PAYSTACK', ${amountK}, 0),
             (${businessId}::uuid, ${id}::uuid, 'SALES_REVENUE', 0, ${amountK})
    `);
  });
}

/**
 * The migration's statement, run the way 0035 runs it: as the owner, with
 * row-level security disabled for the length of one transaction.
 *
 * The disable is not incidental. RLS is FORCED on ledger_entries so it
 * applies to the owner too, and a migration sets no tenant pin, so without
 * this the UPDATE matches nothing and reports success.
 */
async function runMigration(): Promise<void> {
  await owner.begin(async (tx) => {
    await tx.unsafe('ALTER TABLE ledger_entries DISABLE ROW LEVEL SECURITY');
    await tx.unsafe(`
      UPDATE ledger_entries e
         SET account = 'BANK'
        FROM ledger_transactions t
       WHERE t.id = e.transaction_id
         AND t.business_id = e.business_id
         AND e.account = 'BANK_PAYSTACK'
         AND t.source_type <> 'webhook'`);
    await tx.unsafe('ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY');
    await tx.unsafe('ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY');
  });
}

async function balances(businessId: string): Promise<Record<string, number>> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ account: string; balance_k: string }>(sql`
      SELECT account, (SUM(debit_k) - SUM(credit_k))::bigint AS balance_k
      FROM ledger_entries WHERE business_id = ${businessId}::uuid
      GROUP BY account
    `),
  );
  return Object.fromEntries([...rows].map((r) => [r.account, Number(r.balance_k)]));
}

describe('splitting the bank account on existing books', () => {
  it('moves a merchant transfer and leaves a provider settlement where it is', async () => {
    const businessId = await seedBusiness('+2348100000001');
    await legacyPosting(businessId, 'chat', 4_000_000);
    await legacyPosting(businessId, 'dashboard', 1_000_000);
    await legacyPosting(businessId, 'webhook', 2_500_000);

    expect(await balances(businessId)).toMatchObject({ BANK_PAYSTACK: 7_500_000 });
    await runMigration();

    const after = await balances(businessId);
    expect(after['BANK']).toBe(5_000_000);
    expect(after['BANK_PAYSTACK']).toBe(2_500_000);
  });

  /**
   * The property that makes this safe to run on books somebody has read.
   * Both accounts are assets and both are counted by the cash lens, so the
   * split changes which line a figure appears on and nothing else.
   */
  it('changes no total, only which line the money is on', async () => {
    const businessId = await seedBusiness('+2348100000002');
    for (const source of ['chat', 'dashboard', 'webhook', 'recurring', 'opening']) {
      await legacyPosting(businessId, source, 1_000_000);
    }

    const before = await balances(businessId);
    const bankBefore = (before['BANK'] ?? 0) + (before['BANK_PAYSTACK'] ?? 0);
    const debitsBefore = Object.values(before).reduce((n, v) => n + v, 0);

    await runMigration();

    const after = await balances(businessId);
    expect((after['BANK'] ?? 0) + (after['BANK_PAYSTACK'] ?? 0)).toBe(bankBefore);
    /* Every account nets to the same figure, so the trial balance is
     * untouched and the sheet still balances. */
    expect(Object.values(after).reduce((n, v) => n + v, 0)).toBe(debitsBefore);
    expect(after['SALES_REVENUE']).toBe(before['SALES_REVENUE']);
  });

  /**
   * The VERIFIED lens (ADR 0014) reads `account = 'BANK_PAYSTACK' AND
   * source_type = 'webhook'`, which is the same predicate this migration
   * leaves alone. So the figure is unchanged by construction, and this is the
   * test that says so out loud.
   */
  it('leaves the verified-money figure exactly where it was', async () => {
    const businessId = await seedBusiness('+2348100000003');
    await legacyPosting(businessId, 'webhook', 3_000_000);
    await legacyPosting(businessId, 'chat', 9_000_000);

    const verified = () =>
      withBusiness(db, businessId, (tx) =>
        tx.execute<{ k: string }>(sql`
          SELECT COALESCE(SUM(e.debit_k), 0)::bigint AS k
          FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
          WHERE e.business_id = ${businessId}::uuid
            AND e.account = 'BANK_PAYSTACK' AND t.source_type = 'webhook'
        `),
      );
    const before = Number([...(await verified())][0]!.k);
    await runMigration();
    expect(Number([...(await verified())][0]!.k)).toBe(before);
    expect(before).toBe(3_000_000);
  });

  it('touches no other account, however much money is on it', async () => {
    const businessId = await seedBusiness('+2348100000004');
    await withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
        VALUES (${businessId}::uuid, 'cash sale', 'chat', 'c1') RETURNING id
      `);
      const id = [...rows][0]!.id;
      await tx.execute(sql`
        INSERT INTO ledger_entries (business_id, transaction_id, account, debit_k, credit_k)
        VALUES (${businessId}::uuid, ${id}::uuid, 'CASH', 6_000_000, 0),
               (${businessId}::uuid, ${id}::uuid, 'SALES_REVENUE', 0, 6_000_000)
      `);
    });

    await runMigration();
    const after = await balances(businessId);
    expect(after['CASH']).toBe(6_000_000);
    expect(after['BANK']).toBeUndefined();
  });

  it('is safe to run twice', async () => {
    const businessId = await seedBusiness('+2348100000005');
    await legacyPosting(businessId, 'chat', 4_000_000);
    await legacyPosting(businessId, 'webhook', 1_000_000);

    await runMigration();
    const once = await balances(businessId);
    await runMigration();
    expect(await balances(businessId)).toEqual(once);
  });

  /**
   * Every business at once, and each on its own merits.
   *
   * Deliberately NOT tenant-scoped: a migration has no pin and is supposed to
   * reach the whole table, which is the reason it disables row-level security
   * to do it. What has to hold instead is that the discriminator decides row
   * by row rather than business by business, so one merchant having a
   * settlement cannot drag another merchant's transfer along with it.
   */
  it('decides row by row, across every business at once', async () => {
    const ada = await seedBusiness('+2348100000006');
    const bola = await seedBusiness('+2348100000007');
    await legacyPosting(ada, 'chat', 4_000_000);
    await legacyPosting(ada, 'webhook', 1_500_000);
    await legacyPosting(bola, 'chat', 7_000_000);

    await runMigration();

    expect(await balances(ada)).toMatchObject({
      BANK: 4_000_000,
      BANK_PAYSTACK: 1_500_000,
    });
    const bolas = await balances(bola);
    expect(bolas['BANK']).toBe(7_000_000);
    expect(bolas['BANK_PAYSTACK']).toBeUndefined();
  });

  /**
   * The production failure this migration is shaped around, demonstrated
   * rather than argued.
   *
   * Development and CI both run migrations as a SUPERUSER, which bypasses
   * row-level security silently, so neither environment can show the bug: the
   * relabel works there whether or not the migration disables RLS. A
   * production migration role that is merely the table owner is subject to
   * FORCE ROW LEVEL SECURITY like anybody else, sets no tenant pin, and
   * matches nothing.
   *
   * So this builds that role on purpose and runs the same statement as it,
   * once without the disable and once with. Without, the UPDATE reports
   * success and moves zero rows. That is the whole reason `applyMigrations`
   * now refuses to run as a role that cannot reach every tenant.
   */
  it('moves nothing at all as a role that cannot bypass row-level security', async () => {
    const businessId = await seedBusiness('+2348100000009');
    await legacyPosting(businessId, 'chat', 4_000_000);

    await owner.unsafe(`
      DROP ROLE IF EXISTS rekoda_migrate_probe;
      CREATE ROLE rekoda_migrate_probe LOGIN PASSWORD 'probe';
      GRANT SELECT, UPDATE ON ledger_entries TO rekoda_migrate_probe;
      GRANT SELECT ON ledger_transactions TO rekoda_migrate_probe;`);

    const probeUrl = urls.owner.replace(/\/\/[^@/]+@/, '//rekoda_migrate_probe:probe@');
    const probe = postgres(probeUrl, { max: 1, onnotice: () => {} });
    try {
      const unrestricted = await probe.unsafe(
        `SELECT (rolsuper OR rolbypassrls) AS u FROM pg_roles WHERE rolname = current_user`,
      );
      expect((unrestricted[0] as unknown as { u: boolean }).u).toBe(false);

      const blind = await probe.unsafe(`
        UPDATE ledger_entries e SET account = 'BANK'
          FROM ledger_transactions t
         WHERE t.id = e.transaction_id AND t.business_id = e.business_id
           AND e.account = 'BANK_PAYSTACK' AND t.source_type <> 'webhook'`);
      /* No error. No rows. Exactly the silence the guard exists to prevent. */
      expect(blind.count).toBe(0);
      expect((await balances(businessId))['BANK_PAYSTACK']).toBe(4_000_000);
    } finally {
      await probe.end();
      await owner.unsafe(`
        REVOKE ALL ON ledger_entries FROM rekoda_migrate_probe;
        REVOKE ALL ON ledger_transactions FROM rekoda_migrate_probe;
        DROP ROLE IF EXISTS rekoda_migrate_probe;`);
    }

    /* And with the disable in place, the same rows move. */
    await runMigration();
    expect((await balances(businessId))['BANK']).toBe(4_000_000);
  });

  /**
   * The guard the migration carries, reached the way it would actually fire.
   * Without disabling row-level security the UPDATE matches nothing under a
   * role that cannot bypass it, and the straggler count is what turns that
   * silence into a failed deploy.
   */
  it('would notice if the relabel had quietly done nothing', async () => {
    const businessId = await seedBusiness('+2348100000008');
    await legacyPosting(businessId, 'chat', 4_000_000);

    const stragglers = async (): Promise<number> => {
      const rows = await owner.unsafe(`
        SELECT count(*)::int AS n
          FROM ledger_entries e
          JOIN ledger_transactions t
            ON t.id = e.transaction_id AND t.business_id = e.business_id
         WHERE e.account = 'BANK_PAYSTACK' AND t.source_type <> 'webhook'`);
      return (rows[0] as unknown as { n: number }).n;
    };

    expect(await stragglers()).toBeGreaterThan(0);
    await runMigration();
    expect(await stragglers()).toBe(0);
  });
});
