import { describe, expect, it } from 'vitest';
import { MATCH_WINDOW_DAYS, matchStatement } from './bank-matching.js';

const line = (id: string, postedOn: string, amountK: number) => ({ id, postedOn, amountK });
const move = (transactionId: string, occurredOn: string, amountK: number) => ({
  transactionId,
  occurredOn,
  amountK,
});

describe('pairing a statement with the books', () => {
  it('pairs the obvious case, and says nothing is left over', () => {
    const result = matchStatement(
      [line('L1', '2026-08-03', 15_000_000)],
      [move('T1', '2026-08-03', 15_000_000)],
    );
    expect(result.matched).toEqual([{ lineId: 'L1', transactionId: 'T1', daysApart: 0 }]);
    expect(result.unmatchedLines).toEqual([]);
    expect(result.unmatchedMovements).toEqual([]);
  });

  /* A transfer made on Friday posts on Monday, and the merchant recorded it
   * when it happened. */
  it('allows a few days either way', () => {
    const within = matchStatement(
      [line('L1', '2026-08-07', 15_000_000)],
      [move('T1', '2026-08-03', 15_000_000)],
    );
    expect(within.matched).toHaveLength(1);
    expect(within.matched[0]!.daysApart).toBe(MATCH_WINDOW_DAYS);

    const beyond = matchStatement(
      [line('L1', '2026-08-08', 15_000_000)],
      [move('T1', '2026-08-03', 15_000_000)],
    );
    expect(beyond.matched).toEqual([]);
    expect(beyond.unmatchedLines).toEqual(['L1']);
    expect(beyond.unmatchedMovements).toEqual(['T1']);
  });

  /**
   * Exact, never close. Two figures a bank charge apart are two facts, and
   * pairing them buries the charge inside a match that reports agreement.
   */
  it('refuses an amount that is merely nearly right', () => {
    const result = matchStatement(
      [line('L1', '2026-08-03', 15_000_000)],
      [move('T1', '2026-08-03', 14_995_000)],
    );
    expect(result.matched).toEqual([]);
    expect(result.unmatchedLines).toEqual(['L1']);
  });

  it('keeps money in and money out apart', () => {
    const result = matchStatement(
      [line('L1', '2026-08-03', 15_000_000)],
      [move('T1', '2026-08-03', -15_000_000)],
    );
    expect(result.matched).toEqual([]);
  });

  /**
   * The case a confident matcher gets wrong. Two postings of the same amount
   * in the same week is exactly when a computer should stop and ask, because
   * picking either one is a coin toss dressed as a reconciliation.
   */
  it('refuses to choose between two postings that both fit', () => {
    const result = matchStatement(
      [line('L1', '2026-08-03', 2_000_000)],
      [move('T1', '2026-08-02', 2_000_000), move('T2', '2026-08-04', 2_000_000)],
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([{ lineId: 'L1', candidates: ['T1', 'T2'] }]);
    /* Both postings stay outstanding: neither was claimed. */
    expect(result.unmatchedMovements).toEqual(['T1', 'T2']);
  });

  /**
   * The mirror, and the reason the matcher looks both ways. Each line sees
   * exactly one candidate, so a one-pass matcher would pair the first and
   * leave the second stranded, having silently decided which of two identical
   * charges was which.
   */
  it('refuses when two lines both want the same posting', () => {
    const result = matchStatement(
      [line('L1', '2026-08-03', 2_000_000), line('L2', '2026-08-04', 2_000_000)],
      [move('T1', '2026-08-03', 2_000_000)],
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguous.map((a) => a.lineId)).toEqual(['L1', 'L2']);
  });

  /* Twins on both sides are still ambiguous, not two lucky pairs. */
  it('refuses two identical charges against two identical postings', () => {
    const result = matchStatement(
      [line('L1', '2026-08-03', -5_250), line('L2', '2026-08-03', -5_250)],
      [move('T1', '2026-08-03', -5_250), move('T2', '2026-08-03', -5_250)],
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toHaveLength(2);
  });

  /**
   * What is left over is the answer, not the leftovers. A line nothing
   * explains is money the books never recorded; a posting nothing explains is
   * money the books claim and the bank has never seen.
   */
  it('names what is left on each side', () => {
    const result = matchStatement(
      [line('L1', '2026-08-03', 15_000_000), line('L2', '2026-08-09', -5_250)],
      [move('T1', '2026-08-03', 15_000_000), move('T2', '2026-08-20', -700_000)],
    );
    expect(result.matched).toEqual([{ lineId: 'L1', transactionId: 'T1', daysApart: 0 }]);
    expect(result.unmatchedLines).toEqual(['L2']);
    expect(result.unmatchedMovements).toEqual(['T2']);
  });

  it('pairs several without letting one steal another`s posting', () => {
    const result = matchStatement(
      [
        line('L1', '2026-08-03', 15_000_000),
        line('L2', '2026-08-05', -2_000_000),
        line('L3', '2026-08-12', -5_250),
      ],
      [
        move('T1', '2026-08-03', 15_000_000),
        move('T2', '2026-08-05', -2_000_000),
        move('T3', '2026-08-12', -5_250),
      ],
    );
    expect(result.matched.map((m) => [m.lineId, m.transactionId])).toEqual([
      ['L1', 'T1'],
      ['L2', 'T2'],
      ['L3', 'T3'],
    ]);
    expect(result.unmatchedMovements).toEqual([]);
  });

  it('handles nothing at all on either side', () => {
    expect(matchStatement([], [])).toEqual({
      matched: [],
      ambiguous: [],
      unmatchedLines: [],
      unmatchedMovements: [],
    });
    expect(matchStatement([], [move('T1', '2026-08-03', 100)]).unmatchedMovements).toEqual(['T1']);
  });

  /* A day the parser could not have produced must not become a wide-open
   * window that matches everything. */
  it('never matches on a day it cannot read', () => {
    const result = matchStatement(
      [line('L1', 'not-a-day', 15_000_000)],
      [move('T1', '2026-08-03', 15_000_000)],
    );
    expect(result.matched).toEqual([]);
    expect(result.unmatchedLines).toEqual(['L1']);
  });
});
