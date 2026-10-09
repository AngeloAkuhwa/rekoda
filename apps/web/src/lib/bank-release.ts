/**
 * What the bank page says after a release (G-95, OD-24).
 *
 * Two different things share the Release button, and the sentence must not
 * blur them. An ordinary match comes apart and the entry stays exactly as
 * it was. A classification's entry is REVERSED: Rekoda wrote it because the
 * merchant said what the money was, and taking that back is a correction
 * in the books, never a deletion. Chosen from the API's outcome, never from
 * a memo.
 */
import { periodLabel } from '@rekoda/core';
import type { ForgetStatementDayResponse, UnmatchLineResponse } from '@rekoda/contracts';

export function releaseMessage(outcome: UnmatchLineResponse): { done: string } | { error: string } {
  switch (outcome.outcome) {
    case 'released_classification':
      return {
        done: 'Released. Rekoda reversed the classification entry and left the bank line unmatched so you can classify it again.',
      };
    case 'released_match':
      return { done: 'Released. The bank line and the existing entry are unmatched again.' };
    case 'not_matched':
      return { done: 'That line was not matched to anything.' };
    case 'period_closed':
      return {
        error: `Your books are closed through ${periodLabel(outcome.closedThrough)}, so Rekoda cannot reverse this classification today. Nothing was changed.`,
      };
  }
}

/**
 * What the bank page says after a statement day is forgotten (G-97).
 *
 * The lines go, and so do their matches. Entries that existed apart from the
 * statement (a sale, a payment, a journal) are untouched, and the sentence
 * must not suggest otherwise. Only a classification's entry is reversed, and
 * then the sentence says how many.
 */
export function forgetMessage(
  outcome: ForgetStatementDayResponse,
): { done: string } | { error: string } {
  if (outcome.outcome === 'period_closed') {
    return {
      error: `Your books are closed through ${periodLabel(outcome.closedThrough)}, so Rekoda cannot reverse the classifications on that day today. Nothing was removed.`,
    };
  }
  if (outcome.removed === 0) return { done: 'There was nothing from that day to remove.' };
  const lines = `${outcome.removed} ${outcome.removed === 1 ? 'line' : 'lines'}`;
  const n = outcome.reversedClassifications;
  if (n === 0) {
    return {
      done: `Removed ${lines} from that day. You can import them again at any time.`,
    };
  }
  return {
    done: `Removed ${lines} from that day, and Rekoda reversed the ${n === 1 ? '1 classification entry' : `${n} classification entries`} created from ${outcome.removed === 1 ? 'that line' : 'those lines'}. Other entries in your books are unchanged. You can import the day again at any time.`,
  };
}
