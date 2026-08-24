'use server';

import { revalidatePath } from 'next/cache';
import { formatKobo, parseAmountText, toKobo } from '@rekoda/core';
import {
  createRecurring,
  disposeAsset,
  paySupplier,
  recordAsset,
  stopRecurring,
  voidExpense,
  withdrawAsset,
  viewOnlyRefusal,
} from '@/server/api';
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
async function voidExpenseActionUnguarded(
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
async function createRecurringActionUnguarded(
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

  const clientRefRaw = String(formData.get('clientRef') ?? '');
  const clientRef = /^[0-9a-f-]{36}$/i.test(clientRefRaw) ? clientRefRaw : undefined;
  const outcome = await createRecurring(token, {
    description,
    category: category === '' ? null : category,
    amountK: toKobo(naira),
    method,
    anchorDay,
    ...(clientRef ? { clientRef } : {}),
  });
  if (!outcome) return { error: 'That did not go through. Nothing was saved.' };

  if (outcome.outcome === 'duplicate') {
    /* The same form reached us twice; the first submission created it. */
    revalidatePath('/app/expenses');
    return { done: 'Already saved. Nothing was created twice.' };
  }

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
async function stopRecurringActionUnguarded(
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

async function paySupplierActionUnguarded(
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
  const clientRefRaw = String(formData.get('clientRef') ?? '');
  const clientRef = /^[0-9a-f-]{36}$/i.test(clientRefRaw) ? clientRefRaw : undefined;
  const outcome = await paySupplier(token, {
    expenseId,
    amountK,
    method,
    ...(clientRef ? { clientRef } : {}),
  });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'duplicate') {
    /* The same form reached us twice; the first submission paid. */
    revalidatePath('/app/expenses');
    return { done: 'Already recorded. Nothing was paid twice.' };
  }
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

/**
 * Buying something the business keeps and uses (ADR 0026).
 *
 * The useful life is asked in YEARS here and stored in months, because a
 * merchant thinks "about five years", not "sixty months", and asking for the
 * number they already have in their head is the difference between a figure
 * they checked and a figure they guessed to get past the form.
 */
async function recordAssetActionUnguarded(
  _prev: VoidSpendFormState,
  formData: FormData,
): Promise<VoidSpendFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const description = String(formData.get('description') ?? '').trim();
  if (description.length < 2) return { error: 'Say what it is, in a couple of words.' };

  const cost = parseAmountText(String(formData.get('cost') ?? ''));
  if (cost === null || cost <= 0) {
    return { error: 'Say what it cost, in naira. For example 450000, or 450k.' };
  }
  const paidText = String(formData.get('paid') ?? '').trim();
  const paid = paidText === '' ? cost : parseAmountText(paidText);
  if (paid === null || paid < 0) return { error: 'Say what you paid, or leave it to pay in full.' };
  if (paid > cost) return { error: 'You cannot have paid more than it cost.' };

  const years = Number(formData.get('years') ?? 0);
  if (!Number.isFinite(years) || years <= 0 || years > 12) {
    return { error: 'How many years will you get out of it? Somewhere between 1 and 12.' };
  }
  const usefulLifeMonths = Math.round(years * 12);

  const method = String(formData.get('method') ?? 'cash') === 'transfer' ? 'transfer' : 'cash';
  const clientRefRaw = String(formData.get('clientRef') ?? '');
  const clientRef = /^[0-9a-f-]{36}$/i.test(clientRefRaw) ? clientRefRaw : undefined;
  const outcome = await recordAsset(token, {
    description,
    costK: toKobo(cost),
    paidK: toKobo(paid),
    usefulLifeMonths,
    method,
    ...(clientRef ? { clientRef } : {}),
  });
  if (!outcome) return { error: 'That did not go through. Nothing was recorded.' };

  if (outcome.outcome === 'duplicate') {
    /* The same form reached us twice; the first submission recorded it. */
    revalidatePath('/app/expenses');
    return { done: 'Already recorded. Nothing was recorded twice.' };
  }

  revalidatePath('/app/expenses');
  const perMonth = formatKobo(Math.floor(toKobo(cost) / usefulLifeMonths));
  return {
    done:
      outcome.owedK > 0
        ? `Recorded. ${description} is on your balance sheet, and ${formatKobo(outcome.owedK)} is still owed on it.`
        : `Recorded. ${description} is on your balance sheet, not in this month's costs. About ${perMonth} a month will be charged against profit as you use it.`,
  };
}

/**
 * Take back something that should not have been recorded.
 *
 * Not selling it. Selling equipment is a real event with a gain or a loss
 * against what it is still worth, and Rekoda does not model that yet, so the
 * copy says plainly what this is for rather than letting a merchant reach for
 * it when they mean a sale.
 */
async function withdrawAssetActionUnguarded(
  _prev: VoidSpendFormState,
  formData: FormData,
): Promise<VoidSpendFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const assetId = String(formData.get('assetId') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!assetId) return { error: 'Pick the item to take back out.' };
  if (reason.length < 4) return { error: 'Say why, in a few words. It goes on the record.' };

  const outcome = await withdrawAsset(token, { assetId, reason });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };
  if (outcome.outcome === 'not_found') return { error: 'That item is no longer here.' };
  if (outcome.outcome === 'already_withdrawn') {
    return { error: 'That item was already taken back out. Nothing changed.' };
  }

  revalidatePath('/app/expenses');
  return {
    done: `${outcome.description} is off your balance sheet, and the ${formatKobo(outcome.reversedK)} that bought it is back where it was.`,
  };
}

/**
 * Selling or scrapping something the business owned.
 *
 * The reply names the BOOK VALUE it was measured against, because that is the
 * figure a merchant will not have in their head: they know what they paid and
 * what they got, and the gap between those two is not the gain or the loss.
 */
async function disposeAssetActionUnguarded(
  _prev: VoidSpendFormState,
  formData: FormData,
): Promise<VoidSpendFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const assetId = String(formData.get('assetId') ?? '').trim();
  if (!assetId) return { error: 'Pick the item you sold.' };

  const text = String(formData.get('proceeds') ?? '').trim();
  /* Empty means scrapped: it went, and nothing came back. That is a real
   * event with a real loss, not a missing answer. */
  const naira = text === '' ? 0 : parseAmountText(text);
  if (naira === null || naira < 0) {
    return { error: 'Say what you got for it, or leave it empty if nothing came back.' };
  }

  const method = String(formData.get('method') ?? 'cash') === 'transfer' ? 'transfer' : 'cash';
  const outcome = await disposeAsset(token, { assetId, proceedsK: toKobo(naira), method });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };
  if (outcome.outcome === 'not_found') return { error: 'That item is no longer here.' };
  if (outcome.outcome === 'not_owned') {
    return { error: 'You no longer own that one: it has already been sold or taken back out.' };
  }

  revalidatePath('/app/expenses');
  const worth = `It was still worth ${formatKobo(outcome.bookValueK)} on your books.`;
  return {
    done:
      outcome.resultK === 0
        ? `${outcome.description} is off your balance sheet. You sold it for exactly what it was worth, so nothing was gained or lost.`
        : outcome.resultK > 0
          ? `${outcome.description} is off your balance sheet. ${worth} You got ${formatKobo(outcome.resultK)} more than that, and it counts as a gain this month.`
          : `${outcome.description} is off your balance sheet. ${worth} You got ${formatKobo(-outcome.resultK)} less than that, and it counts as a loss this month.`,
  };
}

/* Role refusals (403) come back as a sentence in the form, not a crash.
 * Everything else still throws to the error boundary. */

export async function voidExpenseAction(
  ...args: Parameters<typeof voidExpenseActionUnguarded>
): ReturnType<typeof voidExpenseActionUnguarded> {
  try {
    return await voidExpenseActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof voidExpenseActionUnguarded>>;
  }
}

export async function createRecurringAction(
  ...args: Parameters<typeof createRecurringActionUnguarded>
): ReturnType<typeof createRecurringActionUnguarded> {
  try {
    return await createRecurringActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof createRecurringActionUnguarded>>;
  }
}

export async function stopRecurringAction(
  ...args: Parameters<typeof stopRecurringActionUnguarded>
): ReturnType<typeof stopRecurringActionUnguarded> {
  try {
    return await stopRecurringActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof stopRecurringActionUnguarded>>;
  }
}

export async function paySupplierAction(
  ...args: Parameters<typeof paySupplierActionUnguarded>
): ReturnType<typeof paySupplierActionUnguarded> {
  try {
    return await paySupplierActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof paySupplierActionUnguarded>>;
  }
}

export async function recordAssetAction(
  ...args: Parameters<typeof recordAssetActionUnguarded>
): ReturnType<typeof recordAssetActionUnguarded> {
  try {
    return await recordAssetActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof recordAssetActionUnguarded>>;
  }
}

export async function withdrawAssetAction(
  ...args: Parameters<typeof withdrawAssetActionUnguarded>
): ReturnType<typeof withdrawAssetActionUnguarded> {
  try {
    return await withdrawAssetActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof withdrawAssetActionUnguarded>>;
  }
}

export async function disposeAssetAction(
  ...args: Parameters<typeof disposeAssetActionUnguarded>
): ReturnType<typeof disposeAssetActionUnguarded> {
  try {
    return await disposeAssetActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof disposeAssetActionUnguarded>>;
  }
}
