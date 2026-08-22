'use server';

import { revalidatePath } from 'next/cache';
import { formatKobo, parseAmountText, toKobo } from '@rekoda/core';
import { createRecurring, paySupplier, stopRecurring, voidExpense } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

export interface VoidSpendFormState {
  error?: string;
  done?: string;
  /**
   * Which field the error belongs under.
   *
   * Absent means the form as a whole. It matters on the supplier payment:
   * "that is more than this purchase owes" rendered under the PURCHASE
   * picker reads as "you chose the wrong purchase", which is the one thing
   * the merchant got right.
   */
  field?: 'amount' | 'purchase';
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

/**
 * Money going back to a supplier.
 *
 * `more_than_owed` is the refusal worth writing carefully. Overpaying a
 * supplier is a real thing, and it is a prepayment: money the supplier now
 * holds for the merchant, an asset. Absorbing it into a liability would drive
 * accounts payable below zero, so the reply names the figure and lets the
 * merchant pay the right amount.
 */
const CANNOT_PAY: Record<string, string> = {
  no_such_purchase: 'That purchase is no longer here. Reload the page and try again.',
  withdrawn: 'That purchase was withdrawn, so there is nothing left owing on it.',
  nothing_owed: 'That purchase is already settled in full.',
  more_than_owed: '',
};

export async function paySupplierAction(
  _prev: VoidSpendFormState,
  formData: FormData,
): Promise<VoidSpendFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const expenseId = String(formData.get('expenseId') ?? '').trim();
  if (!expenseId) return { field: 'purchase', error: 'Pick the purchase you are paying.' };

  const naira = parseAmountText(String(formData.get('amount') ?? ''));
  if (naira === null || naira <= 0) {
    return {
      field: 'amount',
      error: 'Say how much you paid, in naira. For example 40000, or 40k.',
    };
  }
  const amountK = toKobo(naira);

  const method = String(formData.get('method') ?? 'cash') === 'transfer' ? 'transfer' : 'cash';
  const outcome = await paySupplier(token, { expenseId, amountK, method });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'refused') {
    if (outcome.reason === 'more_than_owed') {
      return {
        field: 'amount',
        error: `That is more than this purchase still owes. ${formatKobo(outcome.owedK)} is outstanding. If you paid more than that, pay this off first and record the extra as its own entry, because money a supplier is holding for you is not a debt going down.`,
      };
    }
    return { field: 'purchase', error: CANNOT_PAY[outcome.reason] ?? 'That payment was refused.' };
  }

  revalidatePath('/app/expenses');
  return {
    done:
      outcome.owedK > 0
        ? `Recorded. ${formatKobo(outcome.owedK)} still owing on ${outcome.description}.`
        : `Recorded. ${outcome.description} is settled in full.`,
  };
}
