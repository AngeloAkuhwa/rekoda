'use server';

import { revalidatePath } from 'next/cache';
import { forgetStatementDay, importStatement } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

export interface StatementState {
  error?: string;
  done?: string;
}

/**
 * Why a file could not be read, in the merchant's terms.
 *
 * The parser's six refusals are precise and useless to a person. Each one
 * here says what to do next, because "no_header" is a fact about a file and
 * "this does not look like a statement" is a thing somebody can act on.
 */
const UNREADABLE: Record<string, string> = {
  empty: 'That file is empty. Download the statement again from your bank.',
  no_header:
    'This does not look like a bank statement. Ask your bank for the CSV or Excel version rather than the PDF.',
  no_date_column:
    'Your file has no date column, so there is no way to tell when anything happened.',
  no_amount_column:
    'Your file has dates but no amounts. Some banks let you choose the columns before you download.',
  mixed_date_order:
    'The dates in this file contradict each other, so there is no safe way to read them. Download it again, or ask your bank for the version with the month spelled out.',
  no_rows: 'That file has a header but no transactions in it.',
};

/** Anything a merchant could plausibly hand us that is not a CSV. */
const MAX_BYTES = 2_000_000;

export async function importStatementAction(
  _prev: StatementState,
  formData: FormData,
): Promise<StatementState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const file = formData.get('statement');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Pick the statement file your bank sent you.' };
  }
  if (file.size > MAX_BYTES) {
    return {
      error: 'That file is larger than a statement should be. Download one month at a time.',
    };
  }

  const csv = await file.text();
  const outcome = await importStatement(token, csv);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'unreadable') {
    return { error: UNREADABLE[outcome.reason] ?? 'That file could not be read.' };
  }

  revalidatePath('/app/bank');
  if (outcome.imported === 0) {
    return {
      done: `Nothing new. All ${outcome.duplicates} of those lines were already here, so your figures have not moved.`,
    };
  }
  const also =
    outcome.duplicates > 0
      ? ` ${outcome.duplicates} ${outcome.duplicates === 1 ? 'line was' : 'lines were'} already here.`
      : '';
  const ignored =
    outcome.skipped > 0
      ? ` ${outcome.skipped} ${outcome.skipped === 1 ? 'row' : 'rows'} carried no transaction, like a balance or a total.`
      : '';
  return {
    done: `Read ${outcome.imported} ${outcome.imported === 1 ? 'line' : 'lines'} from your bank.${also}${ignored}`,
  };
}

export async function forgetDayAction(
  _prev: StatementState,
  formData: FormData,
): Promise<StatementState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const postedOn = String(formData.get('postedOn') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(postedOn)) return { error: 'Pick a day to remove.' };

  const outcome = await forgetStatementDay(token, postedOn);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  revalidatePath('/app/bank');
  return outcome.removed === 0
    ? { done: 'There was nothing from that day to remove.' }
    : {
        done: `Removed ${outcome.removed} ${outcome.removed === 1 ? 'line' : 'lines'} from that day. You can import them again at any time.`,
      };
}
