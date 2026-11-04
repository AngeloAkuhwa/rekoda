/**
 * The bank surface, end to end.
 *
 * The parsing is proven in packages/core/src/bank-statement.test.ts and the
 * storage in packages/db/src/bank/bank.integration.test.ts. What this pins is the
 * border: that a stranger is refused, that an unreadable file arrives as an
 * outcome the page can explain rather than a status code, and that a
 * merchant's lines reach that merchant and nobody else.
 */
// The bank surface, end to end. Split by concern across bank*.integration.test.ts; the shared setup is in
// bank.fixtures.ts.
import { describe, expect, it } from 'vitest';
import { importStatementResponse } from '@rekoda/contracts';
import { lagosDay, postJournal } from '@rekoda/core';
import { bankRepo, createDb, issueRepo, sql, withBusiness } from '@rekoda/db';
import { CLASSIFICATIONS } from '../commands/bank-commands.js';
import {
  CREDIT_AND_DEBIT,
  ONE_CREDIT,
  classify,
  db,
  matchedTo,
  nets,
  onboard,
  position,
  post,
  postings,
  release,
  setUp,
  urls,
  useBankHarness,
} from './bank.fixtures.js';

useBankHarness();

/**
 * Forgetting a statement day that holds a classification (G-97).
 *
 * Forgetting deletes the day's lines and their matches go with them. A
 * classification's journal exists only because a line was classified, so it
 * used to outlive the evidence that created it: re-import the same day,
 * classify the fresh line, and one physical movement was booked twice.
 */
describe('forgetting a statement day (G-97)', () => {
  // Kept identical to the copy in bank-forget-2.integration.test.ts. It belongs to this
  // describe block's own setup, which each part keeps as it was. Change them together.
  const forget = async (auth: Record<string, string>, postedOn: string) =>
    (await post('/v1/bank/statement/forget', { postedOn }, auth)).json() as Record<string, unknown>;

  it('books one bank credit once after it is classified, forgotten, re-imported and classified again', async () => {
    const { businessId, auth, line } = await setUp('+2348177000401');
    expect(await classify(auth, line.id)).toMatchObject({ outcome: 'classified' });
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });

    expect(await forget(auth, '2026-08-03')).toMatchObject({ removed: 1 });

    expect(
      importStatementResponse.parse(
        (await post('/v1/bank/statement', { csv: ONE_CREDIT }, auth)).json(),
      ),
    ).toMatchObject({ imported: 1, duplicates: 0 });
    const again = (await position(auth)).lines.find((l) => l.amountK === 15_000_000)!;
    expect(again.id).not.toBe(line.id);
    expect(await classify(auth, again.id)).toMatchObject({ outcome: 'classified' });

    /* One ₦150,000 credit, one owner contribution. Not ₦300,000 of either. */
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });

    /* Structurally: the first classification, its reversal under the
     * forgotten line's id, and the current one under the fresh line's. */
    const rows = await postings(businessId);
    expect(rows).toHaveLength(3);
    /* Found by structure: both classifications carry their line's day, so
     * the order of creation says nothing here. */
    const first = rows.find((r) => r.source_id === line.id && r.reverses_id === null);
    const reversalOfFirst = rows.find((r) => r.reverses_id !== null);
    const current = rows.find((r) => r.source_id === again.id);
    expect(first).toMatchObject({ source_type: 'bank_classification', source_id: line.id });
    expect(reversalOfFirst).toMatchObject({
      source_type: 'bank_classification',
      source_id: line.id,
      reverses_id: first!.id,
    });
    expect(current).toMatchObject({ source_id: again.id, reverses_id: null });
    expect((await matchedTo(auth, again.id))!.transactionId).toBe(current!.id);
    /* The forgotten pair is off the reconciliation: nothing left to explain. */
    expect((await position(auth)).reconciliation).toMatchObject({
      unmatchedMovements: 0,
      unmatchedLines: 0,
    });
  });

  /**
   * The day's lines, as the database holds them.
   *
   * Kept identical to the copy in bank-forget-2.integration.test.ts. It belongs to this
   * describe block's own setup, which each part keeps as it was. Change them together.
   */
  async function linesOn(businessId: string, postedOn: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT id FROM bank_statement_lines
        WHERE business_id = ${businessId}::uuid AND posted_on = ${postedOn}::date ORDER BY id
      `),
    );
    return [...rows].map((r) => r.id);
  }

  // Kept identical to the copy in bank-forget-2.integration.test.ts. It belongs to this
  // describe block's own setup, which each part keeps as it was. Change them together.
  async function matchCount(businessId: string) {
    const [row] = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM bank_line_matches WHERE business_id = ${businessId}::uuid
      `),
    );
    return row!.n;
  }

  /**
   * The forget audit rows, stored values as written.
   *
   * Kept identical to the copy in bank-forget-2.integration.test.ts. It belongs to this
   * describe block's own setup, which each part keeps as it was. Change them together.
   */
  async function forgetAudits(businessId: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ entity_id: string; new_value: Record<string, unknown> }>(sql`
        SELECT entity_id, new_value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'bank_statement'
          AND action = 'forgotten'
        ORDER BY created_at, id
      `),
    );
    return [...rows];
  }

  /* A */
  it('forgets an unmatched day and touches no posting', async () => {
    const { businessId, auth } = await setUp('+2348177000402');
    expect(await forget(auth, '2026-08-03')).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect(await linesOn(businessId, '2026-08-03')).toEqual([]);
    expect(await postings(businessId)).toEqual([]);
    expect(await forgetAudits(businessId)).toEqual([
      { entity_id: '2026-08-03', new_value: { removed: 1, reversedClassifications: 0 } },
    ]);
  });

  /* B, P: an entry that existed apart from the statement is never reversed,
   * even a hand-written journal that reads exactly like a classification
   * (the same shape a pre-G-95 classification has: `journal`, no line). */
  it('leaves an ordinarily matched posting untouched, even one worded like a classification', async () => {
    const { businessId, auth, line } = await setUp('+2348177000403');
    await post(
      '/v1/reports/journal',
      {
        memo: 'Owner capital',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const [entry] = await postings(businessId);
    expect(entry).toMatchObject({ source_type: 'journal' });
    await post('/v1/bank/match', { lineId: line.id, transactionId: entry!.id }, auth);
    const before = await nets(businessId);

    expect(await forget(auth, '2026-08-03')).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect(await matchCount(businessId)).toBe(0);
    expect(await nets(businessId)).toEqual(before);
    expect(await postings(businessId)).toEqual([entry]);
    /* Still a real entry, so it is an open movement again, waiting for a line. */
    const open = await withBusiness(db, businessId, (tx) => bankRepo.openMovements(tx, businessId));
    expect(open.map((m) => m.transactionId)).toContain(entry!.id);
  });

  /* C, D, E: each classification, both directions, reversed from its stored
   * entries; the expected journal is the classify door's own. */
  it.each([
    ['OWNER_CAPITAL', 15_000_000, '2026-08-03'],
    ['SUPPLIER_REFUND', 15_000_000, '2026-08-03'],
    ['INTERNAL_TRANSFER', 15_000_000, '2026-08-03'],
    ['OWNER_CAPITAL', -2_000_000, '2026-08-05'],
    ['SUPPLIER_REFUND', -2_000_000, '2026-08-05'],
    ['INTERNAL_TRANSFER', -2_000_000, '2026-08-05'],
  ] as const)(
    'reverses a %s classification of a %i kobo line when its day is forgotten',
    async (classification, amountK, day) => {
      const phone = `+23481770005${String(Object.keys(CLASSIFICATIONS).indexOf(classification))}${amountK > 0 ? 1 : 2}`;
      const { businessId, auth, line } = await setUp(phone, CREDIT_AND_DEBIT, amountK);
      expect(await classify(auth, line.id, classification)).toMatchObject({
        outcome: 'classified',
      });
      const original = (await matchedTo(auth, line.id))!;
      expect((await nets(businessId))['BANK']).toBe(amountK);

      expect(await forget(auth, day)).toEqual({
        outcome: 'forgotten',
        removed: 1,
        reversedClassifications: 1,
      });
      expect(await nets(businessId)).toEqual({});
      expect(await linesOn(businessId, day)).toEqual([]);
      expect(await matchCount(businessId)).toBe(0);

      const rows = await postings(businessId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: original.transactionId, reverses_id: null });
      expect(rows[1]).toMatchObject({
        source_type: 'bank_classification',
        source_id: line.id,
        reverses_id: original.transactionId,
        month: lagosDay(new Date()).slice(0, 7),
      });
      expect(await forgetAudits(businessId)).toEqual([
        {
          entity_id: day,
          new_value: {
            removed: 1,
            reversedClassifications: 1,
            classificationReversals: [
              {
                lineId: line.id,
                originalLedgerTransactionId: original.transactionId,
                reversalLedgerTransactionId: rows[1]!.id,
              },
            ],
          },
        },
      ]);
    },
  );

  /* F, G: a mixed day. Only the classifications move the books. */
  it('reverses only the classifications on a mixed day, and leaves every other entry and day alone', async () => {
    const MIXED = `Date,Description,Amount
03/08/2026,TRF FROM UNKNOWN,10000.00
03/08/2026,TRF FROM CUSTOMER,150000.00
03/08/2026,POS GENERATOR FUEL,-5000.00
03/08/2026,TRF FROM OWNER,30000.00
03/08/2026,TRF FROM SUPPLIER,20000.00
04/08/2026,TRF FROM NEXT DAY,70000.00
`;
    const { businessId, auth } = await onboard('+2348177000410');
    await post('/v1/bank/statement', { csv: MIXED }, auth);
    const lineOf = async (amountK: number) =>
      (await position(auth)).lines.find((l) => l.amountK === amountK)!;

    /* B: a real sale, paid by transfer from the dashboard. */
    const invoiceNumber = await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_9X1',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 15_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'g97-mixed',
        actor: 'system',
      });
      return sale.invoiceNumber;
    });
    await post(
      '/v1/reports/payments/record',
      { invoiceNumber, amountK: 15_000_000, method: 'transfer' },
      auth,
    );
    /* C: an expense paid from the bank. */
    await withBusiness(db, businessId, (tx) =>
      issueRepo.writePosting(
        tx,
        businessId,
        postJournal({
          memo: 'Expense: generator fuel',
          amountK: 500_000,
          intoAccount: 'EXPENSES',
          outOfAccount: 'BANK',
        }),
        'dashboard',
        'expense-g97',
      ),
    );
    const open = (await position(auth)).openMovements;
    const payment = open.find((m) => m.amountK === 15_000_000)!;
    const expense = open.find((m) => m.amountK === -500_000)!;
    for (const [amountK, transactionId] of [
      [15_000_000, payment.transactionId],
      [-500_000, expense.transactionId],
    ] as const) {
      expect(
        (
          await post('/v1/bank/match', { lineId: (await lineOf(amountK)).id, transactionId }, auth)
        ).json(),
      ).toEqual({ outcome: 'matched' });
    }
    const ordinary = await postings(businessId);
    const beforeClassifying = await nets(businessId);

    /* D, E: two classifications on the same day; the next day's line too. */
    await classify(auth, (await lineOf(3_000_000)).id, 'OWNER_CAPITAL');
    await classify(auth, (await lineOf(2_000_000)).id, 'SUPPLIER_REFUND');
    const nextDay = await lineOf(7_000_000);
    await classify(auth, nextDay.id, 'OWNER_CAPITAL');
    const classifications = (await postings(businessId)).filter(
      (p) => p.source_type === 'bank_classification',
    );
    expect(classifications).toHaveLength(3);

    expect(await forget(auth, '2026-08-03')).toEqual({
      outcome: 'forgotten',
      removed: 5,
      reversedClassifications: 2,
    });
    expect(await linesOn(businessId, '2026-08-03')).toEqual([]);

    /* The sale, the payment and the expense: still there, never reversed. */
    const after = await postings(businessId);
    for (const p of ordinary) {
      expect(after).toContainEqual(p);
      expect(after.some((r) => r.reverses_id === p.id)).toBe(false);
    }
    /* Exactly the day's two classifications reversed, once each. */
    const reversals = after.filter((p) => p.reverses_id !== null);
    expect(reversals.map((r) => r.reverses_id).sort()).toEqual(
      classifications
        .filter((c) => c.source_id !== nextDay.id)
        .map((c) => c.id)
        .sort(),
    );
    /* The books are what they were before the day's classifications, plus
     * the next day's classification, which is still matched and standing. */
    expect(await nets(businessId)).toEqual({
      ...beforeClassifying,
      BANK: (beforeClassifying['BANK'] ?? 0) + 7_000_000,
      OWNERS_EQUITY: (beforeClassifying['OWNERS_EQUITY'] ?? 0) - 7_000_000,
    });
    expect((await matchedTo(auth, nextDay.id))!.transactionId).toBe(
      classifications.find((c) => c.source_id === nextDay.id)!.id,
    );
    expect(await matchCount(businessId)).toBe(1);
    const [audit] = await forgetAudits(businessId);
    expect(audit!.new_value).toMatchObject({ removed: 5, reversedClassifications: 2 });
    expect(audit!.new_value['classificationReversals']).toHaveLength(2);
  });

  /* H: a classification already released is not reversed a second time. */
  it('does not reverse a classification that was already released', async () => {
    const { businessId, auth, line } = await setUp('+2348177000411');
    await classify(auth, line.id);
    expect(await release(auth, line.id)).toMatchObject({ outcome: 'released_classification' });

    expect(await forget(auth, '2026-08-03')).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
  });

  it('reverses only the standing classification after a release and a second classification', async () => {
    const { businessId, auth, line } = await setUp('+2348177000412');
    await classify(auth, line.id);
    const first = (await matchedTo(auth, line.id))!;
    await release(auth, line.id);
    await classify(auth, line.id);
    const second = (await matchedTo(auth, line.id))!;

    expect(await forget(auth, '2026-08-03')).toMatchObject({ reversedClassifications: 1 });
    const reversed = (await postings(businessId))
      .filter((p) => p.reverses_id !== null)
      .map((p) => p.reverses_id)
      .sort();
    expect(reversed).toEqual([first.transactionId, second.transactionId].sort());
    expect(await nets(businessId)).toEqual({});
  });

  /* J: the second of two reversals fails. Nothing of the day is changed. */
  it('rolls the whole day back when one reversal fails', async () => {
    const TWO = `Date,Description,Amount
03/08/2026,TRF FROM OWNER,30000.00
03/08/2026,TRF FROM SUPPLIER,20000.00
`;
    const { businessId, auth } = await onboard('+2348177000413');
    await post('/v1/bank/statement', { csv: TWO }, auth);
    const ids = await linesOn(businessId, '2026-08-03');
    for (const id of ids) await classify(auth, id);
    const before = await nets(businessId);
    const beforePostings = await postings(businessId);
    /* Reversals run in line order: fail the second line's. */
    const second = ids[1]!;
    expect(second).toMatch(/^[0-9a-f-]{36}$/);

    const { db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 1 });
    await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g97_fail_second ON ledger_transactions`);
    await ownerDb.execute(sql`
      CREATE OR REPLACE FUNCTION g97_fail_second() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.reverses_id IS NOT NULL AND NEW.source_id = '${sql.raw(second)}' THEN
          RAISE EXCEPTION 'g97: forced failure on the second reversal';
        END IF;
        RETURN NEW;
      END $$`);
    await ownerDb.execute(sql`
      CREATE TRIGGER g97_fail_second BEFORE INSERT ON ledger_transactions
      FOR EACH ROW EXECUTE FUNCTION g97_fail_second()`);
    try {
      expect(
        (await post('/v1/bank/statement/forget', { postedOn: '2026-08-03' }, auth)).statusCode,
      ).toBe(500);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g97_fail_second ON ledger_transactions`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g97_fail_second()`);
      await closeOwner();
    }

    expect(await linesOn(businessId, '2026-08-03')).toEqual(ids);
    expect(await matchCount(businessId)).toBe(2);
    expect(await postings(businessId)).toEqual(beforePostings);
    expect(await nets(businessId)).toEqual(before);
    expect(await forgetAudits(businessId)).toEqual([]);

    /* With nothing in the way, the same forget goes through whole. */
    expect(await forget(auth, '2026-08-03')).toMatchObject({
      removed: 2,
      reversedClassifications: 2,
    });
    expect(await nets(businessId)).toEqual({});
  });
});
