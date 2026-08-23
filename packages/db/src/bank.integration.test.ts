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

describe('pairing the two sides', () => {
  /** A posting on the merchant's own bank, dated. */
  const bankPosting = (businessId: string, day: string, amountK: number, ref: string) =>
    withBusiness(db, businessId, (tx) =>
      issueRepo.writePosting(
        tx,
        businessId,
        postJournal({
          memo: `Money ${amountK > 0 ? 'in' : 'out'}`,
          amountK: Math.abs(amountK),
          intoAccount: amountK > 0 ? 'BANK' : 'OWNERS_EQUITY',
          outOfAccount: amountK > 0 ? 'OWNERS_EQUITY' : 'BANK',
        }),
        'journal',
        ref,
        { occurredAt: new Date(`${day}T12:00:00+01:00`) },
      ),
    );

  const reconcile = (businessId: string, commit = true) =>
    withBusiness(db, businessId, (tx) => bankRepo.reconcile(tx, { businessId, commit }));

  it('pairs a line with the posting that explains it', async () => {
    const businessId = await seedBusiness('+2348110000040');
    await importIt(businessId, AUGUST);
    await bankPosting(businessId, '2026-08-03', 15_000_000, 'J1');

    expect(await reconcile(businessId)).toMatchObject({
      matched: 1,
      ambiguous: 0,
      unmatchedLines: 1,
      unmatchedMovements: 0,
      /* The POS purchase nobody recorded, which is the point of the exercise. */
      unmatchedLinesK: -2_000_000,
    });
  });

  /* Running it again must not re-decide anything, or double-count. */
  it('leaves a decision it already made alone', async () => {
    const businessId = await seedBusiness('+2348110000041');
    await importIt(businessId, AUGUST);
    await bankPosting(businessId, '2026-08-03', 15_000_000, 'J1');

    await reconcile(businessId);
    expect(await reconcile(businessId)).toMatchObject({ matched: 1, unmatchedLines: 1 });
  });

  it('changes nothing when asked not to commit', async () => {
    const businessId = await seedBusiness('+2348110000042');
    await importIt(businessId, AUGUST);
    await bankPosting(businessId, '2026-08-03', 15_000_000, 'J1');

    /* Reports one it COULD pair, and stores nothing. `pairable` is the whole
     * point of the read: it is what the button on the page counts, and if it
     * counted the unmatched lines instead it would offer to pair the one
     * line that provably cannot be paired. */
    expect(await reconcile(businessId, false)).toMatchObject({
      matched: 0,
      pairable: 1,
      unmatchedLines: 1,
    });
    expect(await reconcile(businessId, false)).toMatchObject({ matched: 0, pairable: 1 });

    /* And once accepted, the offer is spent rather than repeated. */
    expect(await reconcile(businessId)).toMatchObject({ matched: 1, pairable: 0 });
    expect(await reconcile(businessId, false)).toMatchObject({ matched: 1, pairable: 0 });
  });

  /**
   * The refusal that matters, reached through the database. Two postings of
   * the same amount in the same week is where a confident matcher invents a
   * reconciliation, so nothing is paired and both stay outstanding.
   */
  it('refuses to choose between two postings that both fit', async () => {
    const businessId = await seedBusiness('+2348110000043');
    await importIt(businessId, AUGUST);
    await bankPosting(businessId, '2026-08-02', 15_000_000, 'J1');
    await bankPosting(businessId, '2026-08-04', 15_000_000, 'J2');

    expect(await reconcile(businessId)).toMatchObject({ matched: 0, ambiguous: 1 });
  });

  /* One line, one posting, both ways: the indexes are the guarantee. */
  it('will not let two lines claim the same posting', async () => {
    const businessId = await seedBusiness('+2348110000044');
    await importIt(businessId, AUGUST);
    const txId = await bankPosting(businessId, '2026-08-03', 15_000_000, 'J1');
    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));

    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO bank_line_matches (business_id, line_id, transaction_id, decided_by)
        VALUES (${businessId}::uuid, ${lines[0]!.id}::uuid, ${txId}::uuid, 'manual')
      `),
    );

    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO bank_line_matches (business_id, line_id, transaction_id, decided_by)
          VALUES (${businessId}::uuid, ${lines[1]!.id}::uuid, ${txId}::uuid, 'manual')
        `),
      ),
    ).rejects.toBeTruthy();
  });

  /* A posting on the settlement account is a different statement's business
   * entirely (ADR 0025), so it must never appear as an unexplained movement. */
  it('never counts a settlement as money the bank has not seen', async () => {
    const businessId = await seedBusiness('+2348110000045');
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
        'J9',
      ),
    );
    expect(await reconcile(businessId)).toMatchObject({ unmatchedMovements: 0 });
  });

  it('forgetting a line takes its match with it', async () => {
    const businessId = await seedBusiness('+2348110000046');
    await importIt(businessId, AUGUST);
    await bankPosting(businessId, '2026-08-03', 15_000_000, 'J1');
    await reconcile(businessId);

    await withBusiness(db, businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:1' }),
    );
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(sql`
        SELECT COUNT(*)::bigint AS n FROM bank_line_matches
        WHERE business_id = ${businessId}::uuid
      `),
    );
    /* ON DELETE CASCADE: a match to a line that no longer exists is not a
     * fact about anything. */
    expect(Number([...rows][0]!.n)).toBe(0);
  });

  /**
   * The promise the page makes: when two entries both fit, Rekoda "leaves the
   * line for you". This is the merchant taking it.
   */
  it('lets a merchant decide what the rule would not', async () => {
    const businessId = await seedBusiness('+2348110000050');
    await importIt(businessId, AUGUST);
    const one = await bankPosting(businessId, '2026-08-02', 15_000_000, 'J1');
    await bankPosting(businessId, '2026-08-04', 15_000_000, 'J2');
    expect(await reconcile(businessId)).toMatchObject({ matched: 0, ambiguous: 1 });

    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    const line = lines.find((l) => l.amountK === 15_000_000)!;
    expect(
      await withBusiness(db, businessId, (tx) =>
        bankRepo.matchByHand(tx, {
          businessId,
          lineId: line.id,
          transactionId: one,
          actor: 'user:1',
        }),
      ),
    ).toEqual({ outcome: 'matched' });

    /* And the decision is recorded as the merchant's, not the rule's. */
    const matches = await withBusiness(db, businessId, (tx) => bankRepo.matchesFor(tx, businessId));
    expect(matches).toMatchObject([{ lineId: line.id, transactionId: one, decidedBy: 'manual' }]);
    /* The other posting is now the only one left over, not both. */
    expect(await reconcile(businessId)).toMatchObject({ matched: 1, unmatchedMovements: 1 });
  });

  /**
   * The one condition a person does NOT get to lift. Two figures a bank
   * charge apart are two facts, and a match spanning them buries the charge
   * inside a reconciliation that reports agreement.
   */
  it('refuses a hand-made match between two different amounts', async () => {
    const businessId = await seedBusiness('+2348110000051');
    await importIt(businessId, AUGUST);
    const posting = await bankPosting(businessId, '2026-08-03', 14_995_000, 'J1');
    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    const line = lines.find((l) => l.amountK === 15_000_000)!;

    expect(
      await withBusiness(db, businessId, (tx) =>
        bankRepo.matchByHand(tx, {
          businessId,
          lineId: line.id,
          transactionId: posting,
          actor: 'user:1',
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'amounts_differ' });
    expect(await withBusiness(db, businessId, (tx) => bankRepo.matchesFor(tx, businessId))).toEqual(
      [],
    );
  });

  /* The date, by contrast, IS lifted: a transfer recorded a month late is
   * still the same money, and only a person can know that. */
  it('lets a merchant pair across a gap the rule would refuse', async () => {
    const businessId = await seedBusiness('+2348110000052');
    await importIt(businessId, AUGUST);
    const posting = await bankPosting(businessId, '2026-06-01', 15_000_000, 'J1');
    /* Two months apart: the rule found nothing. */
    expect(await reconcile(businessId)).toMatchObject({ matched: 0, unmatchedLines: 2 });

    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    const line = lines.find((l) => l.amountK === 15_000_000)!;
    expect(
      await withBusiness(db, businessId, (tx) =>
        bankRepo.matchByHand(tx, {
          businessId,
          lineId: line.id,
          transactionId: posting,
          actor: 'user:1',
        }),
      ),
    ).toEqual({ outcome: 'matched' });
  });

  it('refuses a second claim on a line, and on a posting', async () => {
    const businessId = await seedBusiness('+2348110000053');
    await importIt(businessId, AUGUST);
    const posting = await bankPosting(businessId, '2026-08-03', 15_000_000, 'J1');
    const other = await bankPosting(businessId, '2026-08-03', 15_000_000, 'J2');
    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    const line = lines.find((l) => l.amountK === 15_000_000)!;
    const by = (lineId: string, transactionId: string) =>
      withBusiness(db, businessId, (tx) =>
        bankRepo.matchByHand(tx, { businessId, lineId, transactionId, actor: 'user:1' }),
      );

    expect(await by(line.id, posting)).toEqual({ outcome: 'matched' });
    /* Same line, different posting: the line is spoken for. */
    expect(await by(line.id, other)).toEqual({
      outcome: 'refused',
      reason: 'line_already_matched',
    });
    /* Different line, same posting: the posting is spoken for. */
    const otherLine = lines.find((l) => l.amountK !== 15_000_000)!;
    expect(await by(otherLine.id, posting)).toEqual({
      outcome: 'refused',
      reason: 'movement_already_matched',
    });
  });

  /**
   * Releasing is what makes an automatic match safe to offer. Without it the
   * rule's timidity is a merchant's only protection against a wrong pairing.
   */
  it('releases a match without touching either side', async () => {
    const businessId = await seedBusiness('+2348110000054');
    await importIt(businessId, AUGUST);
    await bankPosting(businessId, '2026-08-03', 15_000_000, 'J1');
    await reconcile(businessId);
    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    const line = lines.find((l) => l.amountK === 15_000_000)!;

    expect(
      await withBusiness(db, businessId, (tx) =>
        bankRepo.unmatchLine(tx, { businessId, lineId: line.id, actor: 'user:1' }),
      ),
    ).toBe(1);

    /* The line is still exactly what the bank said, and the posting is still
     * in the books: neither was ever altered by being matched. */
    const after = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    expect(after.find((l) => l.id === line.id)).toMatchObject({
      amountK: 15_000_000,
      narration: line.narration,
    });
    expect(await reconcile(businessId, false)).toMatchObject({ matched: 0, pairable: 1 });

    /* Releasing what is not matched is not an error, it is a no-op. */
    expect(
      await withBusiness(db, businessId, (tx) =>
        bankRepo.unmatchLine(tx, { businessId, lineId: line.id, actor: 'user:1' }),
      ),
    ).toBe(0);
  });

  /* A merchant of one business must not be able to name another's posting,
   * even with a valid uuid in hand. */
  it('will not pair across businesses', async () => {
    const ada = await seedBusiness('+2348110000055');
    const bola = await seedBusiness('+2348110000056');
    await importIt(ada, AUGUST);
    const bolasPosting = await bankPosting(bola, '2026-08-03', 15_000_000, 'J1');
    const lines = await withBusiness(db, ada, (tx) => bankRepo.bankLinesFor(tx, ada));
    const line = lines.find((l) => l.amountK === 15_000_000)!;

    expect(
      await withBusiness(db, ada, (tx) =>
        bankRepo.matchByHand(tx, {
          businessId: ada,
          lineId: line.id,
          transactionId: bolasPosting,
          actor: 'user:1',
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'no_such_movement' });
  });

  it('is one business at a time', async () => {
    const ada = await seedBusiness('+2348110000047');
    const bola = await seedBusiness('+2348110000048');
    await importIt(ada, AUGUST);
    await bankPosting(ada, '2026-08-03', 15_000_000, 'J1');
    await reconcile(ada);

    expect(await reconcile(bola)).toMatchObject({
      matched: 0,
      unmatchedLines: 0,
      unmatchedMovements: 0,
    });
  });
});

/**
 * The candidate pool a merchant picks from when matching by hand.
 *
 * It used to be a page: two hundred open movements newest first, filtered to
 * a line's amount on the way to the screen. A merchant reconciling for the
 * first time after months has more open entries than that, and the ones the
 * page dropped were the OLDEST, which is exactly where an unreconciled
 * statement line points. Their line offered no candidate at all, for an
 * entry sitting in their own books.
 */
describe('the entries offered against a statement line', () => {
  async function post(businessId: string, memo: string, amountK: number, ref: string) {
    await withBusiness(db, businessId, (tx) =>
      issueRepo.writePosting(
        tx,
        businessId,
        postJournal({ memo, amountK, intoAccount: 'BANK', outOfAccount: 'OWNERS_EQUITY' }),
        'journal',
        ref,
      ),
    );
  }

  it('finds ones a page of the same movements does not contain', async () => {
    const businessId = await seedBusiness('+2348110000031');
    const amounts = [4_242_000, 5_353_000, 6_464_000, 7_575_000, 8_686_000];
    for (const [i, amountK] of amounts.entries()) {
      await post(businessId, `Entry ${i + 1}`, amountK, `JNL-N${i}`);
    }

    /* A small page here rather than two hundred and thirty seeded rows: the
     * property is that an amounts query is not bounded by the page, and the
     * page size is not what makes that true. In production the page is two
     * hundred and the merchant who reaches it is the one reconciling for the
     * first time in months. */
    const page = await withBusiness(db, businessId, (tx) =>
      bankRepo.openMovements(tx, businessId, { limit: 2 }),
    );
    expect(page).toHaveLength(2);

    /* Which two the page holds is not the claim, so the test does not assume
     * it: every amount the page left out has to be reachable by asking. */
    const leftOut = amounts.filter((a) => !page.some((m) => m.amountK === a));
    expect(leftOut).toHaveLength(3);
    for (const amountK of leftOut) {
      const asked = await withBusiness(db, businessId, (tx) =>
        bankRepo.openMovements(tx, businessId, { amounts: [amountK] }),
      );
      expect(asked.map((m) => m.amountK)).toEqual([amountK]);
    }
  });

  it('finds one by id however many are open', async () => {
    const businessId = await seedBusiness('+2348110000034');
    await post(businessId, 'Wanted', 5_000_000, 'JNL-ID1');
    await post(businessId, 'Another', 6_000_000, 'JNL-ID2');

    const all = await withBusiness(db, businessId, (tx) => bankRepo.openMovements(tx, businessId));
    const wanted = all.find((m) => m.memo === 'Wanted')!;

    /* What `matchByHand` does: it has an id and wants to know whether that
     * one movement is open. Reading a page to answer it is a wrong refusal
     * waiting for the business whose page is full. */
    const byId = await withBusiness(db, businessId, (tx) =>
      bankRepo.openMovements(tx, businessId, { ids: [wanted.transactionId] }),
    );
    expect(byId).toHaveLength(1);
    expect(byId[0]).toMatchObject({ transactionId: wanted.transactionId, memo: 'Wanted' });
  });

  it('offers nothing at all when the lines name no amounts', async () => {
    const businessId = await seedBusiness('+2348110000032');
    await post(businessId, 'Money in', 15_000_000, 'JNL-E1');
    /* A statement with no lines has nothing to pair, and an empty IN list is
     * a syntax error in Postgres. Returning everything would be worse than
     * either. */
    expect(
      await withBusiness(db, businessId, (tx) =>
        bankRepo.openMovements(tx, businessId, { amounts: [] }),
      ),
    ).toEqual([]);
  });

  it('leaves out amounts nobody asked about', async () => {
    const businessId = await seedBusiness('+2348110000033');
    await post(businessId, 'Wanted', 5_000_000, 'JNL-W');
    await post(businessId, 'Not wanted', 7_000_000, 'JNL-X');

    const asked = await withBusiness(db, businessId, (tx) =>
      bankRepo.openMovements(tx, businessId, { amounts: [5_000_000] }),
    );
    expect(asked.map((m) => m.memo)).toEqual(['Wanted']);
  });
});

/**
 * Which lines a page keeps when it cannot keep them all.
 *
 * The page is where a merchant pairs by hand, out of the rows in front of
 * them. A line that is not on the page cannot be paired at all, so what the
 * page drops has to be settled history rather than work. By date alone it
 * dropped the OLDEST, which is exactly where an unreconciled line lives.
 */
describe('the statement page a merchant works from', () => {
  it('keeps the lines still needing a decision when it has to choose', async () => {
    const businessId = await seedBusiness('+2348110000041');
    await importIt(
      businessId,
      `Date,Description,Amount
02/01/2026,THE ONE STILL OPEN,111000.00
03/06/2026,SETTLED A,222000.00
04/06/2026,SETTLED B,333000.00
`,
    );
    for (const [amountK, ref] of [
      [22_200_000, 'JNL-SA'],
      [33_300_000, 'JNL-SB'],
    ] as const) {
      await withBusiness(db, businessId, (tx) =>
        issueRepo.writePosting(
          tx,
          businessId,
          postJournal({
            memo: `Explains ${ref}`,
            amountK,
            intoAccount: 'BANK',
            outOfAccount: 'OWNERS_EQUITY',
          }),
          'journal',
          ref,
        ),
      );
    }
    /* Settled by hand rather than by the rule: `matchStatement` is timid
     * about dates on purpose, and a seed that posts its entries today would
     * not pair them with June. What this test is about is which lines the
     * page keeps, not what the rule agrees to. */
    await withBusiness(db, businessId, async (tx) => {
      const all = await bankRepo.bankLinesFor(tx, businessId, 5_000);
      const open = await bankRepo.openMovements(tx, businessId);
      for (const line of all.filter((l) => l.narration.startsWith('SETTLED'))) {
        const movement = open.find((m) => m.amountK === line.amountK)!;
        await bankRepo.matchByHand(tx, {
          businessId,
          lineId: line.id,
          transactionId: movement.transactionId,
          actor: 'user:1',
        });
      }
    });

    const page = await withBusiness(db, businessId, (tx) =>
      bankRepo.bankLinesFor(tx, businessId, 1, { unmatchedFirst: true }),
    );
    expect(page).toHaveLength(1);
    expect(page[0]!.narration).toBe('THE ONE STILL OPEN');
  });

  it('leaves the rule its own order', async () => {
    const businessId = await seedBusiness('+2348110000042');
    await importIt(
      businessId,
      `Date,Description,Amount
02/01/2026,OLDEST,111000.00
04/06/2026,NEWEST,333000.00
`,
    );
    /* Without the flag it is the statement in statement order, which is what
     * `matchStatement` is handed: reordering a list it pairs against another
     * list changes which pairing wins when two are equally good. */
    const plain = await withBusiness(db, businessId, (tx) =>
      bankRepo.bankLinesFor(tx, businessId, 5_000),
    );
    expect(plain.map((l) => l.narration)).toEqual(['NEWEST', 'OLDEST']);
  });
});
