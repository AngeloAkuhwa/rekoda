/**
 * The indexes the customer merge depends on (ruling 4).
 *
 * Deliberately NOT a timing test. The measurements that justified these four
 * are in migration 0136 and were taken on 20,000 rows per table; asserting
 * milliseconds in CI would be flaky, and asserting a query PLAN would be
 * worse — on an empty test table PostgreSQL correctly prefers a sequential
 * scan, so a plan assertion would fail for a reason that has nothing to do
 * with whether the index exists.
 *
 * What this guards is the thing that would actually go wrong: somebody drops
 * one, or adds a fifth table to the merge path without the index its
 * neighbours have.
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

/**
 * Every table `mergeCustomers` touches by (business_id, customer_id): the four
 * its history check counts, plus the children whose referential-integrity
 * check the DELETE fires and which measured slow without one.
 */
const MERGE_PATH = ['invoices', 'orders', 'payments', 'payment_intents', 'receipts'] as const;

describe('the customer merge path keeps its indexes', () => {
  it.each(MERGE_PATH)('%s has an index leading on (business_id, customer_id)', async (table) => {
    const rows = await owner.execute<{ indexdef: string }>(sql`
      SELECT pg_get_indexdef(i.indexrelid) AS indexdef
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_attribute a0 ON a0.attrelid = c.oid AND a0.attnum = i.indkey[0]
        JOIN pg_attribute a1 ON a1.attrelid = c.oid AND a1.attnum = i.indkey[1]
       WHERE c.relname = ${table}
         AND a0.attname = 'business_id' AND a1.attname = 'customer_id'
    `);

    /* `invoices` is in this list because it already had one before 0136, and
     * is what the other four were shaped to match. If it ever loses it, this
     * fails for the same reason as the rest. */
    expect([...rows].length, `${table} lost its (business_id, customer_id) index`).toBeGreaterThan(
      0,
    );
  });
});
