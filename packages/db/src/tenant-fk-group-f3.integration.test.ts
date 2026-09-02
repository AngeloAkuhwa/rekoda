/**
 * The tenant-composite foreign keys, group F part three: reversal chains.
 *
 * Two self-referential edges, where a correction points at what it corrects.
 * Unlike parts one and two this is HARDENING, not the closing of a reachable
 * hole, and the tests are written to show exactly which gap the key fills
 * rather than to re-prove what was already true.
 *
 * What already held before 0143:
 *   - the `*_reversal_shape` trigger (0078) looks the original up with
 *     `AND business_id = NEW.business_id`, so a cross-tenant INSERT was
 *     already refused; and
 *   - both tables are append-only: the application roles hold INSERT and
 *     SELECT and nothing else, so no app role can UPDATE the column.
 *
 * What did not hold, and is what these tests attack: the trigger is BEFORE
 * INSERT only. It never fires on UPDATE, and it never validated the rows that
 * existed before it. The composite key covers both.
 *
 * Run on the OWNER credential, which is the point here rather than an aside:
 * the owner is precisely the credential that can UPDATE these tables, so it is
 * the path the trigger leaves open.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let owner: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const created = createDb(urls.owner, { max: 2 });
  owner = created.db;
  close = created.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(urls);
});

interface Edge {
  readonly edge: string;
  readonly table: string;
  readonly constraint: string;
  readonly unique: string;
}

const GROUP_F3: readonly Edge[] = [
  {
    edge: 'payment_allocations.reversal_of_id',
    table: 'payment_allocations',
    constraint: 'payment_allocations_reversal_business_fk',
    unique: 'payment_allocations_business_id_ux',
  },
  {
    edge: 'customer_credit_applications.reversal_of_id',
    table: 'customer_credit_applications',
    constraint: 'customer_credit_applications_reversal_business_fk',
    unique: 'customer_credit_applications_business_id_ux',
  },
];

describe('group F3: the keys are declared as ruling 1 asked', () => {
  it.each(GROUP_F3)(
    '$edge: a validated self-referential composite key',
    async ({ table, constraint }) => {
      const rows = await owner.execute<{ def: string; validated: boolean }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = ${table} AND con.conname = ${constraint}
    `);
      const row = [...rows][0];
      expect(row?.def).toBe(
        `FOREIGN KEY (business_id, reversal_of_id) REFERENCES ${table}(business_id, id)`,
      );
      expect(row?.validated).toBe(true);
    },
  );

  it.each(GROUP_F3)('$edge: the weaker single-column key is gone', async ({ table }) => {
    const rows = await owner.execute<{ conname: string }>(sql`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
         AND c.relname = ${table} AND a.attname = 'reversal_of_id'
    `);
    expect([...rows].map((r) => r.conname)).toEqual([]);
  });

  it.each(GROUP_F3)(
    '$edge: the table gains the tenant key it points at',
    async ({ table, unique }) => {
      const rows = await owner.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = ${table} AND con.conname = ${unique}
    `);
      expect([...rows][0]?.def).toBe('UNIQUE (business_id, id)');
    },
  );

  it.each(GROUP_F3)('$edge: the 0078 trigger still guards INSERT only', async ({ table }) => {
    const rows = await owner.execute<{
      tgname: string;
      on_insert: boolean;
      on_update: boolean;
    }>(sql`
      SELECT t.tgname,
             (t.tgtype::int & 4) > 0 AS on_insert,
             (t.tgtype::int & 16) > 0 AS on_update
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND c.relname = ${table}
    `);
    const row = [...rows][0];

    /* This is the whole justification for 0143, asserted rather than argued.
     * The trigger's tenant check runs on INSERT and nowhere else, so UPDATE
     * was never covered by it and the rows predating it were never validated.
     * If someone later widens the trigger to UPDATE, this fails and the
     * migration's reasoning gets re-read rather than silently outliving its
     * premise. */
    expect(row?.on_insert).toBe(true);
    expect(row?.on_update).toBe(false);
  });

  it('both tables stay append-only for the application roles', async () => {
    const rows = await owner.execute<{ grantee: string; privs: string }>(sql`
      SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
        FROM information_schema.role_table_grants
       WHERE table_name = 'payment_allocations'
         AND grantee IN ('rekoda_app', 'rekoda_worker')
       GROUP BY grantee ORDER BY grantee
    `);

    /* The other half of why no application path could reach the gap. Asserted
     * so that granting UPDATE later is a decision someone makes with this
     * test in front of them. */
    expect([...rows]).toEqual([
      { grantee: 'rekoda_app', privs: 'INSERT,SELECT' },
      { grantee: 'rekoda_worker', privs: 'INSERT,SELECT' },
    ]);
  });
});

/** One merchant with an allocation and a credit application to reverse. */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23489${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Reversal ${tag}`,
    businessType: null,
    ownerUserId: user.id,
  });
  const b = business.id;

  const one = async (statement: ReturnType<typeof sql>): Promise<string> => {
    const rows = await owner.execute<{ id: string }>(statement);
    const id = [...rows][0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    return id;
  };

  const customer = await one(sql`
    INSERT INTO customers (business_id, token) VALUES (${b}::uuid, ${`tok-r-${tag}`}) RETURNING id`);
  const invoice = await one(sql`
    INSERT INTO invoices (business_id, invoice_number, subtotal_k, total_k, balance_due_k,
                          source_type, customer_id)
    VALUES (${b}::uuid, ${`INV-R-${tag}`}, 1000, 1000, 1000, 'chat', ${customer}::uuid) RETURNING id`);
  const payment = await one(sql`
    INSERT INTO payments (business_id, amount_k, method, source_type)
    VALUES (${b}::uuid, 1000, 'transfer', 'chat') RETURNING id`);
  const allocation = await one(sql`
    INSERT INTO payment_allocations (business_id, payment_id, invoice_id, amount_k, currency)
    VALUES (${b}::uuid, ${payment}::uuid, ${invoice}::uuid, 1000, 'NGN') RETURNING id`);
  const credit = await one(sql`
    INSERT INTO customer_credits (business_id, customer_id, amount_minor, source_type, source_id)
    VALUES (${b}::uuid, ${customer}::uuid, 1000, 'chat', ${`cr-${tag}`}) RETURNING id`);
  const application = await one(sql`
    INSERT INTO customer_credit_applications (business_id, customer_credit_id, invoice_id,
                                              amount_minor, currency, source_type, source_id)
    VALUES (${b}::uuid, ${credit}::uuid, ${invoice}::uuid, 1000, 'NGN', 'chat', ${`ap-${tag}`})
    RETURNING id`);

  return { payment_allocations: allocation, customer_credit_applications: application };
}

describe('group F3: the key covers the path the trigger does not', () => {
  it.each(GROUP_F3)(
    '$edge: an UPDATE cannot point a correction at another tenant’s row',
    async ({ table, constraint }) => {
      const mine = await seedCast('1');
      const theirs = await seedCast('2');

      /* UPDATE, deliberately. The 0078 trigger is BEFORE INSERT, so it does
       * not run here at all: before 0143 this statement succeeded and left a
       * correction citing another merchant's record. Same tenant first, so
       * the refusal below is about the tenant and not about the shape. */
      await expect(
        owner.execute(
          sql.raw(`UPDATE ${table} SET reversal_of_id = '${mine[table]}'
                    WHERE id = '${mine[table]}'`),
        ),
      ).resolves.toBeDefined();

      const refusal = await owner
        .execute(
          sql.raw(`UPDATE ${table} SET reversal_of_id = '${theirs[table]}'
                    WHERE id = '${mine[table]}'`),
        )
        .then(
          () => null,
          (error: Error & { cause?: unknown }) => error,
        );

      expect(refusal, `${table} accepted another tenant's row as its original`).not.toBeNull();
      expect(String(refusal?.cause)).toContain(constraint);
    },
  );

  it.each(GROUP_F3)('$edge: a row that is not a reversal is untouched', async ({ table }) => {
    const mine = await seedCast('3');

    /* The nullable half. Most rows are not reversals, and MATCH SIMPLE skips
     * the constraint entirely for them; that must keep working. */
    await expect(
      owner.execute(
        sql.raw(`UPDATE ${table} SET reversal_of_id = NULL WHERE id = '${mine[table]}'`),
      ),
    ).resolves.toBeDefined();
  });
});
