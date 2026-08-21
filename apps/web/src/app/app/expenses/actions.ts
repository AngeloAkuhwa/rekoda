'use server';

import { revalidatePath } from 'next/cache';
import { voidExpense } from '@/server/api';
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
