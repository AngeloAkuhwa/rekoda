'use server';

import { revalidatePath } from 'next/cache';
import {
  forgetStatementDay,
  importStatement,
  matchBankLine,
  reconcileBank,
  unmatchBankLine,
  viewOnlyRefusal,
} from '@/server/api';
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

async function importStatementActionUnguarded(
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

async function forgetDayActionUnguarded(
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

/**
 * Pair what can only be paired one way.
 *
 * The message says what was left as much as what was found, because the
 * leftovers are the answer: a line nothing explains is money nobody
 * recorded, and a posting nothing explains is money the bank has never seen.
 */
async function reconcileActionUnguarded(
  _prev: StatementState,
  _formData: FormData,
): Promise<StatementState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const outcome = await reconcileBank(token);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  revalidatePath('/app/bank');
  const parts = [
    `${outcome.matched} ${outcome.matched === 1 ? 'line is' : 'lines are'} now matched to your books.`,
  ];
  if (outcome.ambiguous > 0) {
    parts.push(
      `${outcome.ambiguous} ${outcome.ambiguous === 1 ? 'line' : 'lines'} could be more than one entry, so Rekoda left ${outcome.ambiguous === 1 ? 'it' : 'them'} for you.`,
    );
  }
  if (outcome.unmatchedLines > 0) {
    parts.push(
      `${outcome.unmatchedLines} ${outcome.unmatchedLines === 1 ? 'line has' : 'lines have'} nothing in your books to explain ${outcome.unmatchedLines === 1 ? 'it' : 'them'}.`,
    );
  }
  if (outcome.unmatchedMovements > 0) {
    parts.push(
      `${outcome.unmatchedMovements} ${outcome.unmatchedMovements === 1 ? 'entry in your books has' : 'entries in your books have'} nothing on the statement.`,
    );
  }
  return { done: parts.join(' ') };
}

/**
 * A merchant deciding what the rule would not.
 *
 * `amounts_differ` is the refusal worth writing carefully. It almost always
 * means a bank charge, and the merchant's next step is a second entry for
 * the charge, not a looser match. Saying only "that did not work" would send
 * them looking for a bug instead.
 */
const REFUSED: Record<string, string> = {
  no_such_line: 'That line is no longer here. Reload the page and try again.',
  no_such_movement: 'That entry is no longer in your books. Reload the page and try again.',
  amounts_differ:
    'Those two are not the same amount, so pairing them would hide the difference. If your bank took a charge, record the charge as its own expense and the two will then agree.',
  line_already_matched: 'That line is already matched. Release it first if you want to change it.',
  movement_already_matched:
    'That entry in your books is already matched to another line. Release that one first.',
};

async function matchLineActionUnguarded(
  _prev: StatementState,
  formData: FormData,
): Promise<StatementState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const lineId = String(formData.get('lineId') ?? '');
  const transactionId = String(formData.get('transactionId') ?? '');
  if (!lineId || !transactionId) return { error: 'Pick the entry this line belongs to.' };

  const outcome = await matchBankLine(token, { lineId, transactionId });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };
  if (outcome.outcome === 'refused') {
    return { error: REFUSED[outcome.reason] ?? 'That pairing was refused. Nothing was changed.' };
  }

  revalidatePath('/app/bank');
  return { done: 'Matched. Your books and this line now agree about that money.' };
}

/**
 * Release a pairing.
 *
 * The counterpart to matching by hand, and the reason an automatic match is
 * safe to offer at all: a merchant who spots a wrong one can undo it without
 * touching the statement or the posting.
 */
async function unmatchLineActionUnguarded(
  _prev: StatementState,
  formData: FormData,
): Promise<StatementState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const lineId = String(formData.get('lineId') ?? '');
  if (!lineId) return { error: 'Pick the line to release.' };

  const outcome = await unmatchBankLine(token, lineId);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  revalidatePath('/app/bank');
  return {
    done:
      outcome.released > 0
        ? 'Released. The line and the entry are back where they were, both unmatched.'
        : 'That line was not matched to anything.',
  };
}

/* Role refusals (403) come back as a sentence in the form, not a crash.
 * Everything else still throws to the error boundary. */

export async function importStatementAction(
  ...args: Parameters<typeof importStatementActionUnguarded>
): ReturnType<typeof importStatementActionUnguarded> {
  try {
    return await importStatementActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof importStatementActionUnguarded>>;
  }
}

export async function forgetDayAction(
  ...args: Parameters<typeof forgetDayActionUnguarded>
): ReturnType<typeof forgetDayActionUnguarded> {
  try {
    return await forgetDayActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof forgetDayActionUnguarded>>;
  }
}

export async function reconcileAction(
  ...args: Parameters<typeof reconcileActionUnguarded>
): ReturnType<typeof reconcileActionUnguarded> {
  try {
    return await reconcileActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof reconcileActionUnguarded>>;
  }
}

export async function matchLineAction(
  ...args: Parameters<typeof matchLineActionUnguarded>
): ReturnType<typeof matchLineActionUnguarded> {
  try {
    return await matchLineActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof matchLineActionUnguarded>>;
  }
}

export async function unmatchLineAction(
  ...args: Parameters<typeof unmatchLineActionUnguarded>
): ReturnType<typeof unmatchLineActionUnguarded> {
  try {
    return await unmatchLineActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof unmatchLineActionUnguarded>>;
  }
}
