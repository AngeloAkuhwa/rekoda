'use server';

import { revalidatePath } from 'next/cache';
import { formatKobo, parseAmountText, toKobo } from '@rekoda/core';
import { creditInvoice, voidInvoice } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

export interface VoidFormState {
  error?: string;
  done?: string;
}

/**
 * Withdraw an invoice that should not have been issued.
 *
 * The reason is required by the API and asked for here, because the document
 * sequence stays dense on purpose: a gap an auditor cannot explain is what
 * they read as a deleted invoice, and the reason is the explanation.
 *
 * Every refusal comes back as a sentence rather than an error page. A merchant
 * voiding the wrong number, or one a customer has already paid, is having an
 * ordinary moment and should be told what happened.
 */
export async function voidInvoiceAction(
  _prev: VoidFormState,
  formData: FormData,
): Promise<VoidFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const invoiceNumber = String(formData.get('invoiceNumber') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!invoiceNumber) return { error: 'Pick an invoice to void.' };
  if (reason.length < 4) return { error: 'Say why, in a few words. It goes on the record.' };

  const outcome = await voidInvoice(token, invoiceNumber, reason);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'not_found') return { error: 'No invoice with that number.' };
  if (outcome.outcome === 'already_void') {
    return { error: `${invoiceNumber} was already voided. Nothing changed.` };
  }
  if (outcome.outcome === 'has_payments') {
    return {
      error:
        'Money has already come in against that invoice, so it cannot be voided. ' +
        'Refund the customer and record the refund instead.',
    };
  }

  revalidatePath('/app/invoices');
  return { done: `${invoiceNumber} is voided. Your books show the sale and its reversal.` };
}

export interface CreditFormState {
  error?: string;
  done?: string;
}

/**
 * Credit an invoice a customer has already paid something against.
 *
 * The other half of the pair the void opens. A merchant refused by the void
 * because money has arrived is sent here; one refused here because nothing was
 * paid is sent back to the void. Neither refusal is a dead end.
 *
 * The amount is typed in NAIRA, because that is what a person says, and
 * converted once by `toKobo` which asserts the result is a whole number of
 * kobo. Nothing in this file does arithmetic on money.
 */
export async function creditInvoiceAction(
  _prev: CreditFormState,
  formData: FormData,
): Promise<CreditFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const invoiceNumber = String(formData.get('invoiceNumber') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!invoiceNumber) return { error: 'Pick an invoice to credit.' };

  const naira = parseAmountText(String(formData.get('amount') ?? ''));
  if (naira === null || naira <= 0) {
    return { error: 'Say how much to credit, in naira. For example 5000, or 5k.' };
  }
  if (reason.length < 4) return { error: 'Say why, in a few words. It goes on the credit note.' };

  const outcome = await creditInvoice(token, invoiceNumber, toKobo(naira), reason);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'not_found') return { error: 'No invoice with that number.' };
  if (outcome.outcome === 'voided') {
    return { error: `${invoiceNumber} was withdrawn, so there is nothing left to credit.` };
  }
  if (outcome.outcome === 'unpaid') {
    return {
      error:
        `Nothing has been paid on ${invoiceNumber}, so a credit note is not the right tool. ` +
        'Void it instead, using the control above.',
    };
  }
  if (outcome.outcome === 'exceeds_invoice') {
    return {
      error:
        outcome.creditableK === 0
          ? `${invoiceNumber} has already been credited in full.`
          : `That is more than is left on ${invoiceNumber}. You can credit up to ` +
            `${formatNaira(outcome.creditableK)}.`,
    };
  }

  revalidatePath('/app/invoices');

  /* Credited past what was still owed means the money is now going the other
   * way, and a merchant needs telling in a sentence rather than left to read
   * it off a negative balance. */
  const owed =
    outcome.owedToCustomerK > 0
      ? ` You now owe the customer ${formatNaira(outcome.owedToCustomerK)}.`
      : '';
  return {
    done: `${outcome.creditNoteNumber} issued against ${outcome.invoiceNumber}.` + owed,
  };
}

/** Naira in a sentence, where a <Money> element cannot go. */
function formatNaira(kobo: number): string {
  return formatKobo(kobo);
}
