'use server';

import { revalidatePath } from 'next/cache';
import { formatKobo, lagosDay, periodLabel, parseAmountText, toKobo } from '@rekoda/core';
import {
  closeBooks,
  countStock,
  openBooks,
  recordJournal,
  reopenBooks,
  viewOnlyRefusal,
} from '@/server/api';
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
async function openBooksActionUnguarded(
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
  /* An opening balance dated inside a month the merchant themselves closed.
   * Rare, and named rather than swallowed: the fix is theirs to choose,
   * either a later date or reopening the month. */
  if (outcome.outcome === 'period_closed') {
    return {
      error: `Your books are closed through ${periodLabel(outcome.closedThrough)}, so nothing can be dated on or before then. Pick a later day, or reopen that month first.`,
    };
  }

  revalidatePath('/app/reports');
  return {
    done: `Opened as at ${outcome.asAt}. Your balance sheet now starts from what you had.`,
  };
}

export interface StockCountState {
  error?: string;
  done?: string;
}

/**
 * Settle the shelf against the books.
 *
 * Sends a day and nothing else. Every figure that decides what gets posted is
 * read on the server inside the writing transaction, so this action cannot
 * hand the ledger a number that was true when the page rendered and is not
 * true now.
 */
async function countStockActionUnguarded(
  _prev: StockCountState,
  _formData: FormData,
): Promise<StockCountState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const outcome = await countStock(token, { countedOn: lagosDay(new Date()) });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'costs_missing') {
    const many = outcome.uncosted > 1;
    return {
      error: `${outcome.uncosted} ${many ? 'products hold' : 'product holds'} stock with no cost recorded, so the count is short by an unknown amount. Set ${many ? 'those costs' : 'that cost'} on your catalogue first.`,
    };
  }
  if (outcome.outcome === 'not_yet') {
    return { error: 'That day has not happened yet.' };
  }
  if (outcome.outcome === 'agrees') {
    return { done: 'Your books already match the shelf. Nothing was posted.' };
  }

  revalidatePath('/app/reports');
  const short = outcome.differenceK < 0;
  const amount = formatKobo(Math.abs(outcome.differenceK));
  return {
    done: short
      ? `Written down by ${amount}. That went to cost of goods sold, where stock that left without a sale belongs.`
      : `Written up by ${amount}. Your stock was worth more than the books said.`,
  };
}

export interface CloseBooksState {
  error?: string;
  done?: string;
}

/**
 * Close a month, or open one back up.
 *
 * One action for both because they are one control: a month is closed or it
 * is not, and the button a merchant sees says which way it will move. Two
 * actions would mean two places for the same permission check and the same
 * revalidation to drift apart.
 */
async function closeBooksActionUnguarded(
  _prev: CloseBooksState,
  formData: FormData,
): Promise<CloseBooksState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const period = String(formData.get('period') ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return { error: 'Pick a month.' };
  const reopening = String(formData.get('intent') ?? '') === 'reopen';

  if (reopening) {
    const outcome = await reopenBooks(token, { from: period });
    if (!outcome) return { error: 'That did not go through. Nothing was changed.' };
    if (outcome.outcome === 'already_open') {
      return { done: `${periodLabel(period)} was already open.` };
    }
    revalidatePath('/app/reports');
    /* Named plainly when reopening one month opened later ones with it. A
     * single watermark cannot hold "July open, August closed", and a merchant
     * who is not told would find August open and assume a bug. */
    const alsoOpened = outcome.wasClosedThrough !== period;
    return {
      done: alsoOpened
        ? `${periodLabel(period)} is open again, and so is everything after it up to ${periodLabel(outcome.wasClosedThrough)}. Entries dated in those months can be recorded and will change those statements.`
        : `${periodLabel(period)} is open again. Entries dated in it can be recorded and will change that statement.`,
    };
  }

  const outcome = await closeBooks(token, { through: period });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };
  if (outcome.outcome === 'not_ended') {
    return { error: 'That month has not finished yet. You can close it once it has.' };
  }
  if (outcome.outcome === 'already_closed') {
    return { done: `Your books were already closed through ${periodLabel(outcome.through)}.` };
  }

  revalidatePath('/app/reports');
  return {
    done: `Closed through ${periodLabel(outcome.through)}. Nothing can change that month now, so a statement you send stays true.`,
  };
}

export interface JournalState {
  error?: string;
  done?: string;
}

/**
 * Record a correction the merchant wrote themselves.
 *
 * One amount in naira, converted once by `toKobo`, and two accounts. Nothing
 * here does arithmetic: the posting builder in `@rekoda/core` makes both
 * sides from the single figure, which is why an unbalanced correction is not
 * something this form can produce and not something it has to check for.
 */
async function journalActionUnguarded(
  _prev: JournalState,
  formData: FormData,
): Promise<JournalState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const memo = String(formData.get('memo') ?? '').trim();
  if (memo.length < 3) return { error: 'Say what this is for, so it makes sense later.' };

  const naira = parseAmountText(String(formData.get('amount') ?? ''));
  if (naira === null || naira <= 0) {
    return { error: 'Say how much, in naira. For example 50000, or 50k.' };
  }

  const outOfAccount = String(formData.get('outOf') ?? '');
  const intoAccount = String(formData.get('into') ?? '');
  if (!outOfAccount || !intoAccount) return { error: 'Pick where it came from and where it went.' };
  if (outOfAccount === intoAccount) {
    return {
      error: 'Pick two different places. Moving money to where it already is changes nothing.',
    };
  }

  const occurredOn = String(formData.get('occurredOn') ?? '').trim();
  const clientRefRaw = String(formData.get('clientRef') ?? '');
  const clientRef = /^[0-9a-f-]{36}$/i.test(clientRefRaw) ? clientRefRaw : undefined;
  const outcome = await recordJournal(token, {
    memo,
    amountK: toKobo(naira),
    intoAccount: intoAccount as never,
    outOfAccount: outOfAccount as never,
    ...(occurredOn === '' ? {} : { occurredOn }),
    ...(clientRef ? { clientRef } : {}),
  });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'duplicate') {
    /* The same form reached us twice; the first submission posted. */
    revalidatePath('/app/reports');
    return { done: 'Already recorded. Nothing was posted twice.' };
  }
  if (outcome.outcome === 'same_account') {
    return {
      error: 'Pick two different places. Moving money to where it already is changes nothing.',
    };
  }
  if (outcome.outcome === 'not_yet') {
    return {
      error: 'That day has not happened yet. A correction is about something that already did.',
    };
  }
  if (outcome.outcome === 'period_closed') {
    return {
      error: `Your books are closed through ${periodLabel(outcome.closedThrough)}, so nothing can be dated on or before then. Pick a later day, or reopen that month first.`,
    };
  }

  revalidatePath('/app/reports');
  return {
    done: `Recorded as ${outcome.journalNumber}. It is on your statements and in your audit trail.`,
  };
}

/* Role refusals (403) come back as a sentence in the form, not a crash.
 * Everything else still throws to the error boundary. */

export async function openBooksAction(
  ...args: Parameters<typeof openBooksActionUnguarded>
): ReturnType<typeof openBooksActionUnguarded> {
  try {
    return await openBooksActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof openBooksActionUnguarded>>;
  }
}

export async function countStockAction(
  ...args: Parameters<typeof countStockActionUnguarded>
): ReturnType<typeof countStockActionUnguarded> {
  try {
    return await countStockActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof countStockActionUnguarded>>;
  }
}

export async function closeBooksAction(
  ...args: Parameters<typeof closeBooksActionUnguarded>
): ReturnType<typeof closeBooksActionUnguarded> {
  try {
    return await closeBooksActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof closeBooksActionUnguarded>>;
  }
}

export async function journalAction(
  ...args: Parameters<typeof journalActionUnguarded>
): ReturnType<typeof journalActionUnguarded> {
  try {
    return await journalActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof journalActionUnguarded>>;
  }
}
