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
import { lagosDay } from '@rekoda/core';
import { bankRepo, closeRepo, withBusiness, type TenantDb } from '@rekoda/db';
import { confirmReconciliationWork, prepareClassification } from '../commands/bank-commands.js';
import { postJournalWork } from '../commands/ledger-commands.js';
import {
  ONE_CREDIT,
  classify,
  db,
  held,
  holdOpen,
  matchedTo,
  nets,
  position,
  post,
  postings,
  release,
  setUp,
  stillWaiting,
  useBankHarness,
} from './bank.fixtures.js';
import { forget, linesOn, matchCount, forgetAudits } from './bank-forget.fixtures.js';

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
  /** The classify door's own work, in a transaction the test holds open. */
  async function classifyIn(tx: TenantDb, businessId: string, lineId: string) {
    const prepared = await prepareClassification(tx, {
      businessId,
      lineId,
      classification: 'OWNER_CAPITAL',
      actor: 'user:held',
    });
    if (prepared.outcome !== 'ready') throw new Error(prepared.reason);
    const posted = await postJournalWork(tx, prepared.journal);
    return confirmReconciliationWork(tx, {
      businessId,
      lineId,
      transactionId: posted.ledgerTransactionId,
      actor: 'user:held',
      reason: prepared.reason,
    });
  }

  /* K: today's month closed, so no reversal can be dated. Nothing goes. */
  it('refuses, and removes nothing, when the reversal would fall in a closed month', async () => {
    const { businessId, auth, line } = await setUp('+2348177000414');
    await classify(auth, line.id);
    const original = (await matchedTo(auth, line.id))!;
    const before = await nets(businessId);
    const thisMonth = lagosDay(new Date()).slice(0, 7);
    await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, {
        businessId,
        through: thisMonth,
        actor: 'user:test',
        now: new Date('2099-01-15T12:00:00Z'),
      }),
    );

    expect(await forget(auth, '2026-08-03')).toEqual({
      outcome: 'period_closed',
      removed: 0,
      reversedClassifications: 0,
      closedThrough: thisMonth,
    });
    expect(await linesOn(businessId, '2026-08-03')).toEqual([line.id]);
    expect((await matchedTo(auth, line.id))!.transactionId).toBe(original.transactionId);
    expect(await nets(businessId)).toEqual(before);
    expect(await postings(businessId)).toHaveLength(1);
    expect(await forgetAudits(businessId)).toEqual([]);
  });

  /* An unclassified day forgets normally even with today's month closed:
   * nothing has to be reversed, so nothing is refused. */
  it('still forgets a day with no classification while the month is closed', async () => {
    const { businessId, auth } = await setUp('+2348177000415');
    const thisMonth = lagosDay(new Date()).slice(0, 7);
    await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, {
        businessId,
        through: thisMonth,
        actor: 'user:test',
        now: new Date('2099-01-15T12:00:00Z'),
      }),
    );
    expect(await forget(auth, '2026-08-03')).toMatchObject({ outcome: 'forgotten', removed: 1 });
  });

  /* L */
  it('forgets one business`s day and nobody else`s', async () => {
    const mine = await setUp('+2348177000416');
    const theirs = await setUp('+2348177000417');
    await classify(mine.auth, mine.line.id);

    expect(await forget(theirs.auth, '2026-08-03')).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect(await linesOn(mine.businessId, '2026-08-03')).toEqual([mine.line.id]);
    expect(await nets(mine.businessId)).toEqual({
      BANK: 15_000_000,
      OWNERS_EQUITY: -15_000_000,
    });
    expect(await postings(theirs.businessId)).toEqual([]);
    /* Naming the other business at the repo changes nothing: RLS decides. */
    expect(
      await withBusiness(db, theirs.businessId, (tx) =>
        bankRepo.forgetStatementDay(tx, {
          businessId: mine.businessId,
          postedOn: '2026-08-03',
          actor: 'user:theirs',
        }),
      ),
    ).toEqual({ removed: 0, reversed: [] });
    expect(await linesOn(mine.businessId, '2026-08-03')).toEqual([mine.line.id]);
  });

  /* M: a classification in flight commits first, and the forget reverses it. */
  it('reverses a classification that commits while the forget waits', async () => {
    const { businessId, auth, line } = await setUp('+2348177000418');
    const classifying = holdOpen(businessId, (tx) => classifyIn(tx, businessId, line.id));
    expect(await classifying.ready).toEqual({ outcome: 'matched' });

    const forgetting = forget(auth, '2026-08-03');
    expect(await stillWaiting(forgetting)).toBe(true);
    await classifying.commit();

    expect(await forgetting).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 1,
    });
    expect(await nets(businessId)).toEqual({});
    expect(await matchCount(businessId)).toBe(0);
  });

  /* M, the other order: the forget goes first, the classification finds no
   * line and posts nothing. */
  it('refuses a classification that arrives while the forget is committing', async () => {
    const { businessId, auth, line } = await setUp('+2348177000419');
    const forgetting = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:held' }),
    );
    expect(await forgetting.ready).toEqual({ removed: 1, reversed: [] });

    const classifying = classify(auth, line.id);
    expect(await stillWaiting(classifying)).toBe(true);
    await forgetting.commit();

    expect(await classifying).toEqual({ outcome: 'refused', reason: 'no_such_line' });
    expect(await postings(businessId)).toEqual([]);
    expect(await nets(businessId)).toEqual({});
  });

  /* B under a race: a hand match arriving behind the forget finds no line. */
  it('refuses a hand match that arrives while the forget is committing', async () => {
    const { businessId, auth, line } = await setUp('+2348177000420');
    await post(
      '/v1/reports/journal',
      {
        memo: 'Capital',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const [entry] = await postings(businessId);
    const forgetting = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:held' }),
    );
    await forgetting.ready;
    const matching = post('/v1/bank/match', { lineId: line.id, transactionId: entry!.id }, auth);
    expect(await stillWaiting(matching)).toBe(true);
    await forgetting.commit();

    expect((await matching).json()).toEqual({ outcome: 'refused', reason: 'no_such_line' });
    expect(await matchCount(businessId)).toBe(0);
    expect(await postings(businessId)).toEqual([entry]);
  });

  /* N: a committing reconcile and a forget take turns. */
  it('takes turns with a reconcile, and leaves the reconciled posting alone', async () => {
    const { businessId, auth } = await setUp('+2348177000421');
    await post(
      '/v1/reports/journal',
      {
        memo: 'Capital',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const [entry] = await postings(businessId);
    const reconciling = holdOpen(businessId, (tx) =>
      bankRepo.reconcile(tx, { businessId, commit: true }),
    );
    expect(await reconciling.ready).toMatchObject({ matched: 1 });

    const forgetting = forget(auth, '2026-08-03');
    expect(await stillWaiting(forgetting)).toBe(true);
    await reconciling.commit();

    expect(await forgetting).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect(await matchCount(businessId)).toBe(0);
    expect(await postings(businessId)).toEqual([entry]);
    expect(await linesOn(businessId, '2026-08-03')).toEqual([]);
  });

  it('makes a reconcile wait for a forget, then find nothing of the day', async () => {
    const { businessId, auth } = await setUp('+2348177000422');
    await classify(auth, (await position(auth)).lines[0]!.id);
    const forgetting = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:held' }),
    );
    expect(await forgetting.ready).toMatchObject({ removed: 1 });

    const reconciling = post('/v1/bank/reconcile', {}, auth);
    expect(await stillWaiting(reconciling)).toBe(true);
    await forgetting.commit();

    expect((await reconciling).json()).toMatchObject({ matched: 0, unmatchedMovements: 0 });
    expect(await nets(businessId)).toEqual({});
  });

  /* Forget vs release, both orders: one reversal, never two. */
  it('reverses once when a release commits while the forget waits', async () => {
    const { businessId, auth, line } = await setUp('+2348177000424');
    await classify(auth, line.id);
    const releasing = holdOpen(businessId, (tx) =>
      bankRepo.releaseLine(tx, { businessId, lineId: line.id, actor: 'user:held' }),
    );
    expect(await releasing.ready).toMatchObject({ outcome: 'released_classification' });

    const forgetting = forget(auth, '2026-08-03');
    expect(await stillWaiting(forgetting)).toBe(true);
    await releasing.commit();

    expect(await forgetting).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
  });

  it('finds nothing to release once the forget has committed', async () => {
    const { businessId, auth, line } = await setUp('+2348177000425');
    await classify(auth, line.id);
    const forgetting = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:held' }),
    );
    expect(await forgetting.ready).toMatchObject({ removed: 1 });

    const releasing = release(auth, line.id);
    expect(await stillWaiting(releasing)).toBe(true);
    await forgetting.commit();

    expect(await releasing).toEqual({ outcome: 'not_matched', released: 0 });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
  });

  /* Forget vs re-import, after the forget's DELETE: the import waits (on the
   * pairing lock here; the unique index alone would also hold it) and then
   * inserts afresh. This pins the outcome; the next test pins the lock that
   * covers the earlier window. */
  it('imports the day afresh when the upload arrives while the forget is committing', async () => {
    const { businessId, auth, line } = await setUp('+2348177000426');
    const forgetting = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:held' }),
    );
    expect(await forgetting.ready).toMatchObject({ removed: 1 });

    const importing = post('/v1/bank/statement', { csv: ONE_CREDIT }, auth);
    expect(await stillWaiting(importing)).toBe(true);
    await forgetting.commit();

    expect(importStatementResponse.parse((await importing).json())).toMatchObject({
      imported: 1,
      duplicates: 0,
    });
    const after = await linesOn(businessId, '2026-08-03');
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(line.id);
  });

  /* The window the index does not cover: a forget that holds the lock and
   * has not yet deleted (it is still writing reversals). Parked there for
   * real, then let run in the SAME transaction. Without the import taking
   * the pairing lock, the import answers at once that every line is a
   * duplicate, and then the forget deletes them: the day is gone. */
  it('makes an import wait for a forget that has not yet deleted, then imports afresh', async () => {
    const { businessId, auth, line } = await setUp('+2348177000427');
    let resume!: () => void;
    const midGate = new Promise<void>((resolve) => (resume = resolve));
    held.push(resume);
    let parked!: () => void;
    const isParked = new Promise<void>((resolve) => (parked = resolve));
    const forgetting = withBusiness(db, businessId, async (tx) => {
      await bankRepo.lockBankPairings(tx, businessId);
      parked();
      await midGate;
      return bankRepo.forgetStatementDay(tx, {
        businessId,
        postedOn: '2026-08-03',
        actor: 'user:held',
      });
    });
    await Promise.race([isParked, forgetting]);

    const importing = post('/v1/bank/statement', { csv: ONE_CREDIT }, auth);
    expect(await stillWaiting(importing)).toBe(true);
    resume();

    expect(await forgetting).toEqual({ removed: 1, reversed: [] });
    expect(importStatementResponse.parse((await importing).json())).toMatchObject({
      imported: 1,
      duplicates: 0,
    });
    const after = await linesOn(businessId, '2026-08-03');
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(line.id);
  });

  /* O: two forgets of the same day. One does the work; the other finds none. */
  it('reverses once when two forgets of the same day arrive together', async () => {
    const { businessId, auth, line } = await setUp('+2348177000423');
    await classify(auth, line.id);
    const first = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:first' }),
    );
    expect(await first.ready).toMatchObject({ removed: 1 });

    const second = forget(auth, '2026-08-03');
    expect(await stillWaiting(second)).toBe(true);
    await first.commit();

    expect(await second).toEqual({ outcome: 'forgotten', removed: 0, reversedClassifications: 0 });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
    expect(await forgetAudits(businessId)).toHaveLength(1);
  });
});
