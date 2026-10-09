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
import type { UnmatchLineResponse } from '@rekoda/contracts';

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
