'use server';

import { revalidatePath } from 'next/cache';
import { parseAmountText, toKobo } from '@rekoda/core';
import { createRecurring, stopRecurring, voidExpense } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

export interface VoidSpendFormState {
  error?: string;
  done?: string;
}

/**
 * Withdraw a spend entry that should not have been recorded.
 *
 * The entry is named by id rather than by what it was called, because two
 * "diesel" rows in one week is the normal case and reversing the wrong one is
 * a second error on top of the first.
 *
 * Every refusal comes back as a sentence rather than an error page. A merchant
 * withdrawing something already withdrawn is having an ordinary moment.
 */
export async function voidExpenseAction(
  _prev: VoidSpendFormState,
  formData: FormData,
): Promise<VoidSpendFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const expenseId = String(formData.get('expenseId') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!expenseId) return { error: 'Pick an entry to withdraw.' };
  if (reason.length < 4) return { error: 'Say why, in a few words. It goes on the record.' };

  const outcome = await voidExpense(token, expenseId, reason);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'not_found') return { error: 'That entry is no longer here.' };
  if (outcome.outcome === 'already_void') {
    return { error: 'That entry was already withdrawn. Nothing changed.' };
  }
  if (outcome.outcome === 'no_posting') {
    return {
      error:
        'That entry was recorded before Rekoda kept the link to its posting, so it cannot be ' +
        'withdrawn safely. Record the correction as a new entry instead.',
    };
  }

  revalidatePath('/app/expenses');

  /* The stock line is not a footnote. A merchant who reads "withdrawn" and
   * assumes the delivery came off their count would be trading on a number
   * nobody took. */
  const stockNote = outcome.stockUnchanged
    ? ' Your stock count is unchanged, so tell Rekoda in chat if the goods never arrived.'
    : '';
  return {
    done:
      `"${outcome.description}" is withdrawn. Your books show the entry and its reversal.` +
      stockNote,
  };
}

export interface RecurringFormState {
  error?: string;
  done?: string;
}

/**
 * Set up a cost that arrives every month.
 *
 * The amount is typed in NAIRA, because that is what a person says, and
 * converted once by `toKobo`, which asserts the result is a whole number of
 * kobo. Nothing in this file does arithmetic on money.
 */
export async function createRecurringAction(
  _prev: RecurringFormState,
  formData: FormData,
): Promise<RecurringFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const description = String(formData.get('description') ?? '').trim();
  const category = String(formData.get('category') ?? '').trim();
  const anchorDay = Number(formData.get('anchorDay'));
  const method = formData.get('method') === 'transfer' ? 'transfer' : 'cash';

  if (description.length < 2) return { error: 'Say what the cost is. Rent, salaries, diesel.' };

  const naira = parseAmountText(String(formData.get('amount') ?? ''));
  if (naira === null || naira <= 0) {
    return { error: 'Say how much, in naira. For example 150000, or 150k.' };
  }
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    return { error: 'Pick the day of the month it lands on, 1 to 31.' };
  }

  const outcome = await createRecurring(token, {
    description,
    category: category === '' ? null : category,
    amountK: toKobo(naira),
    method,
    anchorDay,
  });
  if (!outcome) return { error: 'That did not go through. Nothing was saved.' };

  /* Stock is the one category a schedule cannot wear: a delivery is something
   * somebody took, and a monthly figure with no delivery behind it would put
   * the books and the shelf permanently out of step. */
  if (outcome.outcome === 'not_stock') {
    return {
      error:
        'A stock purchase cannot repeat on its own, because a delivery is something somebody ' +
        'took. Tell Rekoda in chat when the stock arrives, and give this schedule another name.',
    };
  }

  revalidatePath('/app/expenses');
  return {
    done: `"${description}" is set. The first entry lands on ${longDate(outcome.firstDueOn)}.`,
  };
}

/** Stop a schedule. Entries it already raised stay exactly where they are. */
export async function stopRecurringAction(
  _prev: RecurringFormState,
  formData: FormData,
): Promise<RecurringFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Pick a schedule to stop.' };

  const outcome = await stopRecurring(token, id);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };
  if (outcome.outcome === 'not_found') return { error: 'That schedule is no longer here.' };
  if (outcome.outcome === 'already_stopped') {
    return { error: 'That schedule was already stopped. Nothing changed.' };
  }

  revalidatePath('/app/expenses');
  return {
    done: 'Stopped. It will not raise anything else, and what it already recorded stays.',
  };
}

/** `1 September 2026`, Lagos, from a plain calendar day. */
function longDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
}
