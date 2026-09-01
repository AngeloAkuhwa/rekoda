/**
 * The status sets, held in agreement between the code and the database.
 *
 * Migration 0131 closed four `text` status columns with CHECK constraints.
 * A constraint alone decays in one direction only: it stops a writer from
 * inventing a value, and says nothing when a value is retired in code and
 * left in the constraint forever, or when somebody widens the constraint to
 * make a failing write pass.
 *
 * So the sets live here as well, and this suite proves BOTH directions:
 *
 *   database -> code   the constraint contains nothing this file does not
 *   code -> database   every value this file names is actually accepted
 *
 * The second half is the one that matters, and it is not a string comparison:
 * each value is really written to a real row, and one made-up value is really
 * refused. A set derived by reading `pg_constraint` back and asserting it
 * equals itself would pass no matter how wrong it was.
 *
 * The derivation is in docs/audits/status-enum-evidence-2026-09-01.md. It came
 * from the writers, not from the column comments — three of the four comments
 * were wrong, which is the reason the ruling asked for evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { migrate, requireUrls, type Urls } from './testing.js';

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

interface StatusSet {
  readonly table: string;
  readonly constraint: string;
  readonly values: readonly string[];
  /** A value that reads as plausible and is not in the set. */
  readonly notAValue: string;
}

const SETS: readonly StatusSet[] = [
  {
    table: 'invoices',
    constraint: 'invoices_status_ck',
    values: ['issued', 'partially_paid', 'paid', 'voided', 'credited'],
    /* The shape of the bug this guards: a reader that filters on
     * ('issued', 'partially_paid') silently drops a debt it does not know. */
    notAValue: 'part_paid',
  },
  {
    table: 'orders',
    constraint: 'orders_status_ck',
    values: ['placed', 'quoted', 'open', 'confirmed', 'cancelled', 'received', 'validated'],
    /* `paid` is what the column comment claimed for years. Nothing writes it,
     * and after 0131 nothing can. */
    notAValue: 'paid',
  },
  {
    table: 'expenses',
    constraint: 'expenses_status_ck',
    values: ['recorded', 'voided'],
    notAValue: 'void',
  },
  {
    table: 'reconciliations',
    constraint: 'reconciliations_status_ck',
    values: ['MATCHED', 'PARTIAL', 'EXCEPTION'],
    /* Named by the core's own comment as an outcome, never stored as one. */
    notAValue: 'UNMATCHED',
  },
];

describe('the status sets do not drift from the constraints that hold them', () => {
  it.each(SETS)('$table: the constraint names exactly the values above', async (set) => {
    const rows = await owner.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = ${set.table} AND con.conname = ${set.constraint}
    `);
    const def = [...rows][0]?.def;

    /* Not a substring check each way, which would pass a constraint that
     * merely CONTAINS the set. Every quoted literal in the definition is
     * pulled out and compared as a set, so an extra value fails too. */
    expect(def, `${set.constraint} is missing`).toBeDefined();
    const inConstraint = [...(def ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(inConstraint).toEqual([...set.values].sort());
  });

  it.each(SETS)('$table: the database really accepts every value, and only those', async (set) => {
    /* A temporary copy, so this exercises the CONSTRAINT without needing a
     * valid row of the real table: invoices alone wants a business, a
     * customer, an invoice number and five money columns to balance. The
     * constraint definition is copied verbatim from the catalogue, so what is
     * exercised here is the one shipped, not a restatement of it. */
    const probe = `status_probe_${set.table}`;
    await owner.execute(
      sql.raw(`
        CREATE TEMP TABLE ${probe} (status text NOT NULL);
        ALTER TABLE ${probe} ADD CONSTRAINT ${probe}_ck
          ${await constraintBody(set)};
      `),
    );

    for (const value of set.values) {
      await expect(
        owner.execute(sql.raw(`INSERT INTO ${probe} (status) VALUES ('${value}')`)),
        `${set.table}.status should accept ${value}`,
      ).resolves.toBeDefined();
    }

    await expect(
      owner.execute(sql.raw(`INSERT INTO ${probe} (status) VALUES ('${set.notAValue}')`)),
      `${set.table}.status should refuse ${set.notAValue}`,
    ).rejects.toThrow();

    await owner.execute(sql.raw(`DROP TABLE ${probe}`));
  });
});

/** The shipped constraint's body, read from the catalogue rather than retyped. */
async function constraintBody(set: StatusSet): Promise<string> {
  const rows = await owner.execute<{ def: string }>(sql`
    SELECT pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = ${set.table} AND con.conname = ${set.constraint}
  `);
  const def = [...rows][0]?.def;
  if (!def) throw new Error(`${set.constraint} is missing`);
  return def;
}
