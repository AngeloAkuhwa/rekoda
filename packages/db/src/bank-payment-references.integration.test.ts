/**
 * What reconciliation keeps from the bank's words, and what it does not
 * (R7a; §22.1).
 *
 * Matching has never read a narration. `reconcile` extracted the Rekoda
 * references the text carried and handed the matcher those, throwing the
 * text away in the same expression. Running that extraction once, at the
 * one door every line comes through, is what lets the text stop being
 * stored at all — so these cases pin the extraction itself, at ingest,
 * before any reader depends on it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { parseBankStatement, paymentReferencesIn } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { bankRepo, identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await close?.();
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

function linesOf(csv: string) {
  const parsed = parseBankStatement(csv);
  if (!parsed.ok) throw new Error(`expected a parse, got ${parsed.reason}`);
  return parsed.lines;
}

const importIt = (businessId: string, csv: string) =>
  withBusiness(db, businessId, (tx) =>
    bankRepo.importStatementLines(tx, { businessId, lines: linesOf(csv), actor: 'user:1' }),
  );

/** What actually landed on the row, in the order the bank's text had it. */
async function referencesFor(businessId: string): Promise<string[][]> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ payment_references: string[] }>(sql`
      SELECT payment_references FROM bank_statement_lines
      WHERE business_id = ${businessId}::uuid
      ORDER BY posted_on
    `),
  );
  return [...rows].map((r) => r.payment_references);
}

describe('extracting Rekoda references at ingest', () => {
  it('keeps the reference a credit quoted, and not the words around it', async () => {
    const businessId = await seedBusiness('+2348120000001');
    await importIt(
      businessId,
      `Date,Description,Amount
12/08/2026,TRF FROM ADA OKAFOR RKD-PAY-20260812-7H3K9M,24500.00
`,
    );
    expect(await referencesFor(businessId)).toEqual([['RKD-PAY-20260812-7H3K9M']]);
  });

  /**
   * The reason the column is an array. One transfer can settle two invoices,
   * and `matchStatement` tries every reference a line carries before it
   * gives up on tier 1. Keeping only the first would leave the second
   * invoice unreconciled with nothing left on the row to explain why.
   */
  it('keeps both references when one payment settles two invoices', async () => {
    const businessId = await seedBusiness('+2348120000002');
    await importIt(
      businessId,
      `Date,Description,Amount
12/08/2026,TRF RKD-PAY-20260812-7H3K9M AND RKD-PAY-20260901-ABCDEF,50000.00
`,
    );
    expect(await referencesFor(businessId)).toEqual([
      ['RKD-PAY-20260812-7H3K9M', 'RKD-PAY-20260901-ABCDEF'],
    ]);
  });

  /**
   * A debit is a movement like any other. Rekoda's reconciliation is built
   * on signed amounts, and a refund the merchant sent out quoting a Rekoda
   * reference has to reconcile exactly as the money coming in does.
   */
  it('keeps the reference a debit quoted, with the amount still negative', async () => {
    const businessId = await seedBusiness('+2348120000003');
    await importIt(
      businessId,
      `Date,Description,Amount
14/08/2026,REFUND RKD-PAY-20260814-K7M2P9,-12000.00
`,
    );
    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    expect(lines[0]).toMatchObject({ amountK: -1_200_000 });
    expect(await referencesFor(businessId)).toEqual([['RKD-PAY-20260814-K7M2P9']]);
  });

  /**
   * Banks fold case in their narration processors. The minted alphabet has
   * no I, L, O or U so a reference read over a phone still scans, and the
   * stored form is the minted one however the bank spelled it.
   */
  it('normalises a bank that lower-cased the reference', async () => {
    const businessId = await seedBusiness('+2348120000004');
    await importIt(
      businessId,
      `Date,Description,Amount
15/08/2026,transfer rkd-pay-20260815-3n8q4w received,9000.00
`,
    );
    expect(await referencesFor(businessId)).toEqual([['RKD-PAY-20260815-3N8Q4W']]);
  });

  /**
   * Some banks put the reference in their own reference column rather than
   * the description. The reader joined the two before extracting, so ingest
   * joins them the same way: a bank that files the reference tidily must not
   * be the bank that stops reconciling.
   */
  it('finds a reference the bank filed in its reference column', async () => {
    const businessId = await seedBusiness('+2348120000005');
    await importIt(
      businessId,
      `Date,Description,Reference,Amount
16/08/2026,INWARD TRANSFER,RKD-PAY-20260816-9V2T5H,31000.00
`,
    );
    expect(await referencesFor(businessId)).toEqual([['RKD-PAY-20260816-9V2T5H']]);
  });

  it('leaves an empty array, never a null, on the ordinary line that quotes none', async () => {
    const businessId = await seedBusiness('+2348120000006');
    await importIt(
      businessId,
      `Date,Description,Amount
17/08/2026,POS PURCHASE SHOPRITE,-20000.00
`,
    );
    expect(await referencesFor(businessId)).toEqual([[]]);
  });

  /**
   * The one that guards the backfill.
   *
   * The migration extracts in SQL and the ingest extracts in TypeScript, and
   * the two must agree exactly or a line that matched before the deploy
   * stops matching after it, with the text it came from about to be deleted
   * and no way left to recover. Two regular expressions that look equivalent
   * in two dialects are not evidence, so this runs the migration's OWN
   * statement — read from the file that ships, not retyped here — over rows
   * inserted with no references, and compares every answer against
   * `paymentReferencesIn`.
   */
  it('backfills exactly what the ingest would have extracted', async () => {
    const businessId = await seedBusiness('+2348120000007');
    const awkward = [
      'TRF FROM ADA OKAFOR RKD-PAY-20260812-7H3K9M THANKS',
      'rkd-pay-20260812-7h3k9m lower cased by the bank',
      'two RKD-PAY-20260812-7H3K9M and RKD-PAY-20260901-ABCDEF in one line',
      'repeated RKD-PAY-20260812-7H3K9M RKD-PAY-20260812-7H3K9M',
      'nothing to find here at all',
      'excluded alphabet RKD-PAY-20260812-7H3K9I',
      'too few digits RKD-PAY-2026081-7H3K9M',
      'gluedRKD-PAY-20260812-7H3K9Mtext',
    ];

    /* Straight to the table, so the rows look like history: narration
     * present, references never computed. */
    await withBusiness(db, businessId, async (tx) => {
      for (const [at, narration] of awkward.entries()) {
        await tx.execute(sql`
          INSERT INTO bank_statement_lines
            (business_id, posted_on, amount_k, narration, bank_ref, fingerprint,
             payment_references)
          VALUES (${businessId}::uuid, ${`2026-08-${String(at + 1).padStart(2, '0')}`}::date,
                  100000, ${narration}, NULL, ${`seed-${at}`}, NULL)
        `);
      }
    });

    const migrationSql = readFileSync(
      fileURLToPath(new URL('../migrations/0125_bank_payment_references.sql', import.meta.url)),
      'utf8',
    );
    const update = migrationSql.slice(
      migrationSql.indexOf('UPDATE bank_statement_lines'),
      migrationSql.indexOf('/* ── the gate'),
    );
    expect(update).toContain('regexp_matches');

    /* As the owner, because the table is append-only by grant and the
     * application role has no UPDATE on it. A backfill is migration work,
     * and running it through the application's credentials here would prove
     * something the deploy never does. */
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      await owner.unsafe(update);
    } finally {
      await owner.end();
    }

    const stored = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ narration: string; payment_references: string[] }>(sql`
        SELECT narration, payment_references FROM bank_statement_lines
        WHERE business_id = ${businessId}::uuid ORDER BY posted_on
      `),
    );
    expect([...stored]).toHaveLength(awkward.length);
    for (const row of stored) {
      expect(row.payment_references).toEqual(paymentReferencesIn(`${row.narration} `));
    }
  });
});
