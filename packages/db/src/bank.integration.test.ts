/**
 * The bank's half of a reconciliation, against real PostgreSQL.
 *
 * The claim that matters is the dedupe. Merchants re-upload statements
 * constantly, usually overlapping the last one by a week or two, and a
 * reconciliation that doubled its lines with every upload would be further
 * from the truth each time somebody tried to improve it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { parseBankStatement, postJournal } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { bankRepo, identity, issueRepo } from './index.js';
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

const AUGUST = `Date,Description,Amount
03/08/2026,TRF FROM ADEBAYO O,150000.00
05/08/2026,POS PURCHASE SHOPRITE,-20000.00
`;

/* Overlaps August by one day and adds two more, which is what a merchant's
 * second upload actually looks like. */
const AUGUST_AND_SEPTEMBER = `Date,Description,Amount
05/08/2026,POS PURCHASE SHOPRITE,-20000.00
02/09/2026,TRF FROM NGOZI,80000.00
04/09/2026,SMS ALERT CHARGE,-52.50
`;

function linesOf(csv: string) {
  const parsed = parseBankStatement(csv);
  if (!parsed.ok) throw new Error(`expected a parse, got ${parsed.reason}`);
  return parsed.lines;
}

const importIt = (businessId: string, csv: string) =>
  withBusiness(db, businessId, (tx) =>
    bankRepo.importStatementLines(tx, { businessId, lines: linesOf(csv), actor: 'user:1' }),
  );

const position = (businessId: string) =>
  withBusiness(db, businessId, (tx) => bankRepo.bankPositionFor(tx, businessId));

describe('importing what the bank said', () => {
  it('stores each line once, with the bank`s own words kept', async () => {
    const businessId = await seedBusiness('+2348110000001');
    expect(await importIt(businessId, AUGUST)).toEqual({ imported: 2, duplicates: 0 });

    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      postedOn: '2026-08-05',
      amountK: -2_000_000,
      narration: 'POS PURCHASE SHOPRITE',
    });
  });

  /**
   * The whole reason a fingerprint exists. Without it the second upload
   * doubles August and the merchant's statement total is twice what their
   * bank says.
   */
  it('imports the same file twice without importing anything twice', async () => {
    const businessId = await seedBusiness('+2348110000002');
    await importIt(businessId, AUGUST);
    expect(await importIt(businessId, AUGUST)).toEqual({ imported: 0, duplicates: 2 });

    const seen = await position(businessId);
    expect(seen.lines).toBe(2);
    expect(seen.statementK).toBe(13_000_000);
  });

  it('takes only the new lines from an overlapping statement', async () => {
    const businessId = await seedBusiness('+2348110000003');
    await importIt(businessId, AUGUST);
    expect(await importIt(businessId, AUGUST_AND_SEPTEMBER)).toEqual({
      imported: 2,
      duplicates: 1,
    });
    expect((await position(businessId)).lines).toBe(4);
  });

  /* Two real charges, not one charge imported twice. */
  it('keeps both of two identical charges on one day', async () => {
    const businessId = await seedBusiness('+2348110000004');
    const twins = `Date,Description,Amount
20/08/2026,SMS ALERT CHARGE,-52.50
20/08/2026,SMS ALERT CHARGE,-52.50
`;
    expect(await importIt(businessId, twins)).toEqual({ imported: 2, duplicates: 0 });
    expect((await position(businessId)).statementK).toBe(-10_500);
  });

  it('records an import that landed, and stays quiet about one that did not', async () => {
    const businessId = await seedBusiness('+2348110000005');
    await importIt(businessId, AUGUST);
    await importIt(businessId, AUGUST);

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ action: string }>(sql`
        SELECT action FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'bank_statement'
      `),
    );
    /* One event, not two: a re-upload that changed nothing is not news. */
    expect([...rows]).toHaveLength(1);
  });
});

describe('the two figures side by side', () => {
  it('reads nothing on both sides for a business that has imported none', async () => {
    const businessId = await seedBusiness('+2348110000010');
    expect(await position(businessId)).toEqual({
      ledgerK: 0,
      statementK: 0,
      differenceK: 0,
      lines: 0,
      latestOn: null,
    });
  });

  /**
   * The difference is the point. A merchant whose books say one thing and
   * whose bank says another has something to find, and until now Rekoda
   * could not even tell them the two disagreed.
   */
  it('shows the gap between what the books say and what the bank says', async () => {
    const businessId = await seedBusiness('+2348110000011');
    /* The books know about the money in, but not the card purchase. */
    await withBusiness(db, businessId, (tx) =>
      issueRepo.writePosting(
        tx,
        businessId,
        postJournal({
          memo: 'Money in',
          amountK: 15_000_000,
          intoAccount: 'BANK',
          outOfAccount: 'OWNERS_EQUITY',
        }),
        'journal',
        'JNL-1',
      ),
    );
    await importIt(businessId, AUGUST);

    expect(await position(businessId)).toMatchObject({
      ledgerK: 15_000_000,
      statementK: 13_000_000,
      differenceK: -2_000_000,
      latestOn: '2026-08-05',
    });
  });

  /* The settlement account is a different account with a different statement
   * behind it, so it must not land in this comparison (ADR 0025). */
  it('ignores the settlement account entirely', async () => {
    const businessId = await seedBusiness('+2348110000012');
    await withBusiness(db, businessId, (tx) =>
      issueRepo.writePosting(
        tx,
        businessId,
        postJournal({
          memo: 'Settled',
          amountK: 9_000_000,
          intoAccount: 'BANK_PAYSTACK',
          outOfAccount: 'OWNERS_EQUITY',
        }),
        'journal',
        'JNL-2',
      ),
    );
    expect((await position(businessId)).ledgerK).toBe(0);
  });

  it('is one business at a time', async () => {
    const ada = await seedBusiness('+2348110000013');
    const bola = await seedBusiness('+2348110000014');
    await importIt(ada, AUGUST);
    expect((await position(bola)).lines).toBe(0);
    /* And Bola importing the identical file is not a duplicate of Ada's. */
    expect(await importIt(bola, AUGUST)).toEqual({ imported: 2, duplicates: 0 });
  });
});

describe('taking an import back out', () => {
  it('forgets a day, and lets it be imported again afterwards', async () => {
    const businessId = await seedBusiness('+2348110000020');
    await importIt(businessId, AUGUST);

    const removed = await withBusiness(db, businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-05', actor: 'user:1' }),
    );
    expect(removed).toBe(1);
    expect((await position(businessId)).lines).toBe(1);

    /* Forgotten means forgotten: the fingerprint is gone with the row, so the
     * same file brings it back rather than being refused as a duplicate. */
    expect(await importIt(businessId, AUGUST)).toEqual({ imported: 1, duplicates: 1 });
  });

  it('says nothing was there rather than failing', async () => {
    const businessId = await seedBusiness('+2348110000021');
    expect(
      await withBusiness(db, businessId, (tx) =>
        bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-05', actor: 'user:1' }),
      ),
    ).toBe(0);
  });
});

describe('what the application may not do', () => {
  /**
   * Append-only by grant, like the ledger. A statement line edited to agree
   * with the books is no longer evidence of anything, and the point of
   * holding the bank's version is that it disagrees when the books are wrong.
   */
  it('cannot update a line the bank reported', async () => {
    const businessId = await seedBusiness('+2348110000030');
    await importIt(businessId, AUGUST);

    /* The driver wraps a server error, so the refusal is on the cause chain
     * rather than on the message. 42501 is insufficient_privilege. */
    const refused = await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE bank_statement_lines SET amount_k = 1
        WHERE business_id = ${businessId}::uuid
      `),
    ).catch((error: unknown) => {
      for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
        const candidate = e as { code?: string; message?: string; cause?: unknown };
        if (candidate.code === '42501') return candidate;
        e = candidate.cause;
      }
      return {};
    });
    expect(refused).toMatchObject({
      code: '42501',
      message: expect.stringContaining('permission denied'),
    });

    /* And the line is untouched. */
    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    expect(lines.every((l) => l.amountK !== 1)).toBe(true);
  });
});
