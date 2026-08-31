/**
 * The identity of a statement line, after the bank's words left it (R7c).
 *
 * The fingerprint is stored, and a unique index on it is what makes a
 * re-upload a no-op. Changing how it is computed without rewriting what is
 * stored breaks nothing visibly: the next re-upload of an old statement
 * simply computes a different hash, meets no conflict, and inserts a second
 * copy of every line. So the migration rewrites every row, and these cases
 * check the rewrite against the function that will compute the next one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { parseBankStatement } from '@rekoda/core';
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

const SEP = String.fromCharCode(31);

/**
 * The formula as it stood before this migration, narration and all.
 *
 * Written out here rather than imported, because the point of these cases is
 * that rows born under the OLD rule still deduplicate under the new one, and
 * the old rule no longer exists in the codebase to import.
 */
function legacyFingerprint(
  line: { postedOn: string; amountK: number; narration: string; bankRef: string | null },
  occurrence: number,
): string {
  const body = [line.postedOn, String(line.amountK), line.narration, line.bankRef ?? ''].join(SEP);
  return createHash('sha256')
    .update(body + SEP + occurrence, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/** The migration exactly as it ships, run as the owner a deploy runs it as. */
async function runTheMigration(): Promise<void> {
  const file = readFileSync(
    fileURLToPath(new URL('../migrations/0126_bank_fingerprint_identity.sql', import.meta.url)),
    'utf8',
  );
  const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await owner.unsafe(file);
  } finally {
    await owner.end();
  }
}

/** Rows as the old code would have written them: narration, legacy key. */
async function seedLegacyRows(
  businessId: string,
  csv: string,
): Promise<{ postedOn: string; amountK: number; narration: string; bankRef: string | null }[]> {
  const lines = linesOf(csv);
  const seen = new Map<string, number>();
  const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    for (const line of lines) {
      const body = [line.postedOn, String(line.amountK), line.narration, line.bankRef ?? ''].join(
        SEP,
      );
      const occurrence = (seen.get(body) ?? 0) + 1;
      seen.set(body, occurrence);
      /* No narration column to write to any more, and none needed: the
       * legacy key is computed above from the parsed line, which still has
       * the words in memory exactly as the old import did. */
      await owner`
        INSERT INTO bank_statement_lines
          (business_id, posted_on, amount_k, bank_ref, fingerprint, payment_references)
        VALUES (${businessId}::uuid, ${line.postedOn}::date, ${line.amountK},
                ${line.bankRef},
                ${legacyFingerprint(line, occurrence)}, ARRAY[]::text[])
      `;
    }
  } finally {
    await owner.end();
  }
  return [...lines];
}

const AUGUST = `Date,Description,Amount
03/08/2026,TRF FROM ADEBAYO O,150000.00
05/08/2026,POS PURCHASE SHOPRITE,-20000.00
`;

describe('rewriting the identity of lines already stored', () => {
  /**
   * The case the migration exists for.
   *
   * Without the rewrite these three lines keep hashes nothing computes any
   * more, and the merchant's next re-upload doubles their statement. Checked
   * by running the migration and then re-uploading the same file, which is
   * exactly what a merchant does.
   */
  it('leaves a re-upload of an old statement a no-op', async () => {
    const businessId = await seedBusiness('+2348130000001');
    await seedLegacyRows(businessId, AUGUST);
    await runTheMigration();

    expect(await importIt(businessId, AUGUST)).toEqual({ imported: 0, duplicates: 2 });
  });

  /** And the rewrite is the reason: without it, the same re-upload doubles. */
  it('would have doubled the statement had the rewrite not run', async () => {
    const businessId = await seedBusiness('+2348130000002');
    await seedLegacyRows(businessId, AUGUST);

    /* No migration here on purpose. The legacy keys are still in place, the
     * new code computes different ones, and nothing stops the second copy.
     * This is the failure the migration prevents, stated rather than
     * described. */
    expect(await importIt(businessId, AUGUST)).toEqual({ imported: 2, duplicates: 0 });
  });

  it('rewrites every row it finds, leaving none on an old key', async () => {
    const businessId = await seedBusiness('+2348130000003');
    const seeded = await seedLegacyRows(businessId, AUGUST);
    const before = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ fingerprint: string }>(sql`
        SELECT fingerprint FROM bank_statement_lines WHERE business_id = ${businessId}::uuid
      `),
    );
    const legacy = new Set([...before].map((r) => r.fingerprint));
    expect(legacy.size).toBe(seeded.length);

    await runTheMigration();

    const after = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ fingerprint: string }>(sql`
        SELECT fingerprint FROM bank_statement_lines WHERE business_id = ${businessId}::uuid
      `),
    );
    for (const row of after) {
      expect(row.fingerprint).toHaveLength(32);
      expect(legacy.has(row.fingerprint)).toBe(false);
    }
  });
});

describe('what the new identity does and does not separate', () => {
  /**
   * The property R7 is for. The bank rewording a line, or a processor folding
   * its case, cannot mint a new transaction any more, because the words are
   * not part of what makes the line itself.
   */
  it('reads a reworded line as the same line', async () => {
    const businessId = await seedBusiness('+2348130000004');
    await importIt(
      businessId,
      `Date,Description,Reference,Amount
03/08/2026,TRF FROM ADEBAYO O,REF-0001,150000.00
`,
    );
    /* Same day, same amount, same bank reference. Only the words differ. */
    expect(
      await importIt(
        businessId,
        `Date,Description,Reference,Amount
03/08/2026,INWARD TRANSFER FROM A OKAFOR,REF-0001,150000.00
`,
      ),
    ).toEqual({ imported: 0, duplicates: 1 });
  });

  /**
   * And the opposite, which is what `occurrence` protects: two real charges
   * of the same size on the same day are two charges, not one entered twice.
   */
  it('keeps both of two genuine twins in one file', async () => {
    const businessId = await seedBusiness('+2348130000005');
    expect(
      await importIt(
        businessId,
        `Date,Description,Amount
03/08/2026,POS PURCHASE,-500000.00
03/08/2026,POS PURCHASE,-500000.00
`,
      ),
    ).toEqual({ imported: 2, duplicates: 0 });
  });

  /** A Rekoda reference separates two lines a bare amount would not. */
  it('separates two same-day amounts that quoted different invoices', async () => {
    const businessId = await seedBusiness('+2348130000006');
    expect(
      await importIt(
        businessId,
        `Date,Description,Amount
03/08/2026,TRF RKD-PAY-20260803-7H3K9M,150000.00
03/08/2026,TRF RKD-PAY-20260803-ABCDEF,150000.00
`,
      ),
    ).toEqual({ imported: 2, duplicates: 0 });
  });

  /**
   * No derivative of the bank's words survives anywhere.
   *
   * Checked the only way that means anything now that the text itself is
   * gone from the row: two lines alike in everything but the words they
   * arrived with get the same fingerprint. A hash that still had those
   * words in it could not.
   */
  it('stores no fingerprint that depends on what the bank wrote', async () => {
    const businessId = await seedBusiness('+2348130000007');
    await importIt(
      businessId,
      `Date,Description,Reference,Amount
03/08/2026,ONE FORM OF WORDS,REF-9,90000.00
`,
    );
    const first = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ fingerprint: string }>(sql`
        SELECT fingerprint FROM bank_statement_lines WHERE business_id = ${businessId}::uuid
      `),
    );

    const other = await seedBusiness('+2348130000008');
    await importIt(
      other,
      `Date,Description,Reference,Amount
03/08/2026,QUITE ANOTHER FORM OF WORDS,REF-9,90000.00
`,
    );
    const second = await withBusiness(db, other, (tx) =>
      tx.execute<{ fingerprint: string }>(sql`
        SELECT fingerprint FROM bank_statement_lines WHERE business_id = ${other}::uuid
      `),
    );

    expect([...first][0]!.fingerprint).toBe([...second][0]!.fingerprint);
  });
});
