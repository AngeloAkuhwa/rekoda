/**
 * A queue whose "due now" is reliably due now (migration 0139).
 *
 * Two queues are read by a query that compares a stored timestamp against a
 * JavaScript `Date`. A Date holds MILLISECONDS and `toISOString()` truncates,
 * so a column stamped by PostgreSQL's `now()` at microsecond precision could
 * hold a value its own reader could not express, and a row enqueued "now" was
 * invisible for the rest of that millisecond.
 *
 * Nothing was ever lost in production, where an enqueue and a drain are
 * minutes apart: the row is picked up on the next pass. It surfaced in the
 * test suite, where the two happen close enough together to fail a run at
 * random. These tests are the statement that they no longer can.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

/**
 * Both columns read against a JavaScript Date, so both must be truncated.
 * `column` is spelled into `label` because vitest reads `$table.$column` in a
 * title as a nested property path and renders it undefined.
 */
const TRUNCATED = [
  {
    label: 'pending_object_deletions.next_attempt_at',
    table: 'pending_object_deletions',
    column: 'next_attempt_at',
  },
  {
    label: 'webhook_deliveries.next_attempt_at',
    table: 'webhook_deliveries',
    column: 'next_attempt_at',
  },
] as const;

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

describe('due-times are stored at the precision their reader can express', () => {
  it.each(TRUNCATED)('$label defaults to a truncated now()', async ({ table, column }) => {
    const rows = await owner.execute<{ expr: string }>(sql`
      SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid AND c.relname = ${table}
        JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE a.attname = ${column}
    `);
    expect([...rows][0]?.expr).toBe(`date_trunc('milliseconds'::text, now())`);
  });

  it('jobs.run_at keeps the plain now(), because it is never read from JavaScript', async () => {
    const rows = await owner.execute<{ expr: string }>(sql`
      SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid AND c.relname = 'jobs'
        JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE a.attname = 'run_at'
    `);

    /* The counter-example that shows the rule is about the READER, not about
     * timestamps in general. The job runner claims with `run_at <= now()`,
     * database to database, so microseconds on both sides compare correctly
     * and truncating here would buy nothing. */
    expect([...rows][0]?.expr).toBe('now()');
  });

  it('a row taking the default carries no sub-millisecond remainder', async () => {
    const rows = await owner.execute<{ exact: boolean; stamp: string }>(sql`
      INSERT INTO pending_object_deletions (business_id, storage_key, reason)
      VALUES (NULL, 'documents/precision/probe.pdf', 'upload_orphaned')
      RETURNING next_attempt_at = date_trunc('milliseconds', next_attempt_at) AS exact,
                next_attempt_at::text AS stamp
    `);
    const row = [...rows][0];
    expect(row?.exact, `stored ${row?.stamp}, which a JavaScript Date cannot express`).toBe(true);
  });

  it('so a row queued now is due now, read the way the drain reads it', async () => {
    /* The whole point, stated as the drain states it. `toISOString()` is what
     * `dueObjectDeletions` sends; before 0139 the microseconds the default
     * left behind made this comparison false for up to a millisecond. */
    const rows = await owner.execute<{ due: boolean }>(sql`
      WITH queued AS (
        INSERT INTO pending_object_deletions (business_id, storage_key, reason)
        VALUES (NULL, 'documents/precision/due.pdf', 'upload_orphaned')
        RETURNING next_attempt_at
      )
      SELECT q.next_attempt_at <= date_trunc('milliseconds', clock_timestamp()) AS due
        FROM queued q
    `);
    expect([...rows][0]?.due).toBe(true);
  });

  it('the hazard the default used to create, spelled out', async () => {
    /* Kept as an executable statement of WHY, so the migration's reasoning is
     * checkable rather than a claim in a comment: a stored microsecond
     * remainder really is invisible to a reader that only has milliseconds. */
    const rows = await owner.execute<{ visible: boolean }>(sql`
      SELECT timestamptz '2026-09-01 20:40:35.739632+00'
          <= '2026-09-01T20:40:35.739Z'::timestamptz AS visible
    `);
    expect([...rows][0]?.visible).toBe(false);
  });
});
