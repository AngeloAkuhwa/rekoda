'use server';

import { revalidatePath } from 'next/cache';
import { parseAmountText, toKobo } from '@rekoda/core';
import { openBooks } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

export interface OpeningFormState {
  error?: string;
  done?: string;
}

/**
 * Tell Rekoda what the business was already holding.
 *
 * Three figures in NAIRA, because that is what a person says, each converted
 * once by `toKobo`. Nothing here does arithmetic on money: the balancing
 * figure that goes to owner's equity is computed by the posting builder in
 * `@rekoda/core`, from the same three numbers, so the page cannot disagree
 * with the ledger about what was opened.
 *
 * A blank field is zero rather than an error. A merchant with no bank balance
 * to declare should be able to leave that box alone, and refusing an empty
 * box would teach them to type 0 into every form they meet.
 */
export async function openBooksAction(
  _prev: OpeningFormState,
  formData: FormData,
): Promise<OpeningFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const asAt = String(formData.get('asAt') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asAt)) {
    return { error: 'Pick the day these figures were true.' };
  }

  const amounts: Record<'cashK' | 'bankK' | 'stockK', number> = { cashK: 0, bankK: 0, stockK: 0 };
  for (const [field, key] of [
    ['cash', 'cashK'],
    ['bank', 'bankK'],
    ['stock', 'stockK'],
  ] as const) {
    const typed = String(formData.get(field) ?? '').trim();
    if (typed === '') continue;
    const naira = parseAmountText(typed);
    if (naira === null || naira < 0) {
      return { error: `Say what was in ${field}, in naira. For example 200000, or 200k.` };
    }
    amounts[key] = toKobo(naira);
  }

  const outcome = await openBooks(token, { asAt, ...amounts });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'nothing_to_open') {
    return { error: 'Fill in at least one of the three. Opening with nothing is not an entry.' };
  }
  if (outcome.outcome === 'not_yet') {
    return { error: 'That day has not happened yet. Pick the day the figures were true.' };
  }
  /* Once only, and it is the database that says so. The books cannot be
   * opened twice without one of the two being a lie about the same day. */
  if (outcome.outcome === 'already_set') {
    return { error: 'Your books are already open. Anything since then is a normal entry.' };
  }

  revalidatePath('/app/reports');
  return {
    done: `Opened as at ${outcome.asAt}. Your balance sheet now starts from what you had.`,
  };
}
