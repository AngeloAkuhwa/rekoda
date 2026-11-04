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
import { lagosDay, postJournal, reversal } from '@rekoda/core';
import { bankRepo, closeRepo, issueRepo, withBusiness } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import {
  app,
  classify,
  db,
  holdOpen,
  matchedTo,
  nets,
  position,
  post,
  postings,
  release,
  releaseAudits,
  setUp,
  stillWaiting,
  useBankHarness,
} from './bank.fixtures.js';

useBankHarness();

/**
 * Releasing a classification (G-95, OD-24 Option A).
 *
 * A classification is not a pairing of two facts that existed apart: the
 * journal exists BECAUSE the merchant said what this line was. Releasing it
 * used to unpair the line and leave that journal standing, so classifying
 * the line again booked the same money a second time. These tests assert
 * the money, not the number of journals.
 */
describe('releasing a classification (G-95)', () => {
  /* J, and L's refusal: the reversal is dated today, and today closed. */
  it('changes nothing when the reversal cannot be written', async () => {
    const { businessId, auth, line } = await setUp('+2348177000210');
    await classify(auth, line.id);
    const original = (await matchedTo(auth, line.id))!;
    const before = await nets(businessId);
    /* Close the month we are in, through the real close, from a future
     * vantage point; the release's reversal then falls in a closed month. */
    const thisMonth = lagosDay(new Date()).slice(0, 7);
    await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, {
        businessId,
        through: thisMonth,
        actor: 'user:test',
        now: new Date('2099-01-15T12:00:00Z'),
      }),
    );

    expect(await release(auth, line.id)).toEqual({
      outcome: 'period_closed',
      released: 0,
      closedThrough: thisMonth,
    });
    expect((await matchedTo(auth, line.id))!.transactionId).toBe(original.transactionId);
    expect(await nets(businessId)).toEqual(before);
    expect(await postings(businessId)).toHaveLength(1);
    expect(await releaseAudits(businessId)).toEqual([]);
  });

  /* G-98: a line dated in a CLOSED month cannot be classified (the journal
   * takes the line's own day). It answered 500; it must answer what the
   * journal form and the release answer, and write nothing. */
  it('answers period_closed, not a 500, for a line dated in a closed month (G-98)', async () => {
    const { businessId, auth, line } = await setUp('+2348177000220');
    await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, { businessId, through: '2026-08', actor: 'user:test' }),
    );

    const answer = await post(
      '/v1/bank/classify',
      { lineId: line.id, classification: 'OWNER_CAPITAL' },
      auth,
    );

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ outcome: 'period_closed', closedThrough: '2026-08' });
    /* Nothing moved: no journal, and the line is still waiting to be explained. */
    expect(await postings(businessId)).toEqual([]);
    expect((await matchedTo(auth, line.id)) ?? null).toBeNull();
  });

  /* L: the original sits in a closed month; the correction is today's. */
  it('reverses a classification from a closed month today, leaving the month alone', async () => {
    const { businessId, auth, line } = await setUp('+2348177000211');
    await classify(auth, line.id);
    await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, { businessId, through: '2026-08', actor: 'user:test' }),
    );

    expect(await release(auth, line.id)).toMatchObject({ outcome: 'released_classification' });
    const [original, reversal] = await postings(businessId);
    expect(original).toMatchObject({ month: '2026-08', reverses_id: null });
    expect(reversal).toMatchObject({
      month: lagosDay(new Date()).slice(0, 7),
      reverses_id: original!.id,
    });
    expect(await nets(businessId)).toEqual({});
  });

  /* Reviewer B, P2-1: the id is matched to the uuid column whatever its
   * case, and the classification must be recognised the same way. */
  it('reverses a classification released with the line id in capitals', async () => {
    const { businessId, auth, line } = await setUp('+2348177000216');
    await classify(auth, line.id);
    const original = (await matchedTo(auth, line.id))!;

    expect(await release(auth, line.id.toUpperCase())).toEqual({
      outcome: 'released_classification',
      released: 1,
    });
    expect(await nets(businessId)).toEqual({});
    const reversal = (await postings(businessId)).find((p) => p.reverses_id !== null)!;
    /* Recorded under the line's own id, as the database spells it. */
    expect(reversal).toMatchObject({ source_id: line.id, reverses_id: original.transactionId });
    expect(await classify(auth, line.id)).toMatchObject({ outcome: 'classified' });
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });
  });

  /* Reviewer B, P2-2: a reconcile that read the books before the release
   * and the pairings after it would pair the line with the journal being
   * reversed. They take turns, and the reconcile sees the release whole. */
  it('does not let a reconcile pair the line with the journal being reversed', async () => {
    const { businessId, auth, line } = await setUp('+2348177000217');
    await classify(auth, line.id);

    const releasing = holdOpen(businessId, (tx) =>
      bankRepo.releaseLine(tx, { businessId, lineId: line.id, actor: 'user:first' }),
    );
    expect(await releasing.ready).toMatchObject({ outcome: 'released_classification' });
    const reconciling = post('/v1/bank/reconcile', {}, auth);
    expect(await stillWaiting(reconciling)).toBe(true);
    await releasing.commit();

    expect((await reconciling).statusCode).toBe(200);
    expect(await matchedTo(auth, line.id)).toBeNull();
    expect(await nets(businessId)).toEqual({});
    /* And the line can still be classified, once. */
    expect(await classify(auth, line.id)).toMatchObject({ outcome: 'classified' });
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });
  });

  /* K */
  it('cannot release another business`s line', async () => {
    const mine = await setUp('+2348177000212');
    const theirs = await setUp('+2348177000213');
    await classify(mine.auth, mine.line.id);

    expect(await release(theirs.auth, mine.line.id)).toEqual({
      outcome: 'not_matched',
      released: 0,
    });
    /* Even naming this business in the call, the session's tenant decides. */
    expect(
      await withBusiness(db, theirs.businessId, (tx) =>
        bankRepo.releaseLine(tx, {
          businessId: theirs.businessId,
          lineId: mine.line.id,
          actor: 'user:theirs',
        }),
      ),
    ).toEqual({ outcome: 'not_matched' });

    expect(await matchedTo(mine.auth, mine.line.id)).not.toBeNull();
    expect(await nets(mine.businessId)).toEqual({
      BANK: 15_000_000,
      OWNERS_EQUITY: -15_000_000,
    });
    expect(await postings(theirs.businessId)).toEqual([]);
  });

  /* M */
  it('keeps a released classification and its reversal off the reconciliation', async () => {
    const { auth, line } = await setUp('+2348177000214');
    await classify(auth, line.id);
    const original = (await matchedTo(auth, line.id))!;
    await release(auth, line.id);

    const seen = await position(auth);
    expect(seen.openMovements).toEqual([]);
    expect(seen.reconciliation).toMatchObject({ unmatchedMovements: 0, unmatchedLines: 1 });
    /* Nor can the reversed journal be picked to explain the line. */
    expect(
      (
        await post(
          '/v1/bank/match',
          { lineId: line.id, transactionId: original.transactionId },
          auth,
        )
      ).json(),
    ).toEqual({ outcome: 'refused', reason: 'no_such_movement' });
  });

  /* N */
  it('leaves every other reversed bank posting exactly as visible as before', async () => {
    const { businessId, auth } = await setUp('+2348177000215');
    /* A bank payment and its void, through the same reversal convention the
     * voids use: neither is a classification, so both stay on the page. */
    const [paid, voided] = await withBusiness(db, businessId, async (tx) => {
      const paidId = await issueRepo.writePosting(
        tx,
        businessId,
        postJournal({
          memo: 'Expense: generator fuel',
          amountK: 500_000,
          intoAccount: 'EXPENSES',
          outOfAccount: 'BANK',
        }),
        'dashboard',
        'expense-1',
      );
      const voidId = await issueRepo.writePosting(
        tx,
        businessId,
        reversal(
          postJournal({
            memo: 'Expense: generator fuel',
            amountK: 500_000,
            intoAccount: 'EXPENSES',
            outOfAccount: 'BANK',
          }),
          'Void expense: generator fuel',
        ),
        'dashboard',
        'expense-1',
        { reversesId: paidId },
      );
      return [paidId, voidId];
    });

    const open = await withBusiness(db, businessId, (tx) => bankRepo.openMovements(tx, businessId));
    expect(open.map((m) => m.transactionId).sort()).toEqual([paid, voided].sort());
    expect((await position(auth)).reconciliation).toMatchObject({ unmatchedMovements: 2 });
  });

  /* O: the classify door above ran on the bus, as Build 9 made the default. */
  it('ran every classification here through the command bus', () => {
    const config = app.get<ApiConfig>(CONFIG);
    expect(config.commandPostJournal).toBe(true);
    expect(config.commandConfirmReconciliation).toBe(true);
  });
});
