'use server';

import { revalidatePath } from 'next/cache';
import { formatKobo, parseAmountText, toKobo } from '@rekoda/core';
import { creditInvoice, recordPayment, voidInvoice, viewOnlyRefusal } from '@/server/api';
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
async function voidInvoiceActionUnguarded(
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
async function creditInvoiceActionUnguarded(
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

/**
 * A payment the merchant is reporting.
 *
 * This was only possible on WhatsApp. A merchant on the Bank page looking at
 * a transfer their books do not explain had to leave the dashboard and type a
 * message to record it, which is the one direction the books were not
 * reachable from.
 *
 * `balance_moved` is the refusal worth writing carefully: a provider payment
 * can land while the merchant is typing, so the figure they reported no
 * longer fits. The reply names what the invoice actually owes now, because
 * posting the difference away silently is the one thing this must not do.
 */
async function recordPaymentActionUnguarded(
  _prev: VoidFormState,
  formData: FormData,
): Promise<VoidFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const invoiceNumber = String(formData.get('invoiceNumber') ?? '').trim();
  if (!invoiceNumber) return { error: 'Pick the invoice this money was for.' };

  const naira = parseAmountText(String(formData.get('amount') ?? ''));
  if (naira === null || naira <= 0) {
    return { error: 'Say how much came in, in naira. For example 40000, or 40k.' };
  }
  const method = String(formData.get('method') ?? 'cash') === 'transfer' ? 'transfer' : 'cash';
  const clientRefRaw = String(formData.get('clientRef') ?? '');
  const clientRef = /^[0-9a-f-]{36}$/i.test(clientRefRaw) ? clientRefRaw : undefined;

  const outcome = await recordPayment(token, {
    invoiceNumber,
    amountK: toKobo(naira),
    method,
    ...(clientRef ? { clientRef } : {}),
  });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'not_found') {
    return { error: 'That invoice is no longer here. Reload the page and try again.' };
  }
  if (outcome.outcome === 'duplicate') {
    /* The same form reached us twice; the first submission booked. */
    revalidatePath('/app/invoices');
    return { done: 'Already recorded. Nothing was recorded twice.' };
  }
  if (outcome.outcome === 'already_settled') {
    return { error: `${outcome.invoiceNumber} is already paid in full. Nothing was recorded.` };
  }
  if (outcome.outcome === 'balance_moved') {
    /* Never claim a cause. The same refusal covers a merchant typing more
     * than the invoice owes and a provider payment landing while they were
     * typing, and Rekoda cannot tell the two apart from here. Saying
     * "something settled it while you were on this page" would be a
     * fabrication in the ordinary case and the ordinary case is a typo. */
    return {
      error: `${outcome.invoiceNumber} owes ${formatKobo(outcome.balanceDueK)}, and you typed ${formatKobo(outcome.excessK)} more than that. Record ${formatKobo(outcome.balanceDueK)} against this invoice. If more money really came in, the rest was for something else and belongs on its own invoice.`,
    };
  }

  revalidatePath('/app/invoices');
  return {
    done:
      outcome.balanceDueK > 0
        ? `Recorded. Receipt ${outcome.receiptNumber} for ${formatKobo(outcome.amountK)}, and ${formatKobo(outcome.balanceDueK)} still owing on ${outcome.invoiceNumber}.`
        : `Recorded. Receipt ${outcome.receiptNumber} for ${formatKobo(outcome.amountK)}, and ${outcome.invoiceNumber} is paid in full.`,
  };
}

/* Role refusals (403) come back as a sentence in the form, not a crash.
 * Everything else still throws to the error boundary. */

export async function voidInvoiceAction(
  ...args: Parameters<typeof voidInvoiceActionUnguarded>
): ReturnType<typeof voidInvoiceActionUnguarded> {
  try {
    return await voidInvoiceActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof voidInvoiceActionUnguarded>>;
  }
}

export async function creditInvoiceAction(
  ...args: Parameters<typeof creditInvoiceActionUnguarded>
): ReturnType<typeof creditInvoiceActionUnguarded> {
  try {
    return await creditInvoiceActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof creditInvoiceActionUnguarded>>;
  }
}

export async function recordPaymentAction(
  ...args: Parameters<typeof recordPaymentActionUnguarded>
): ReturnType<typeof recordPaymentActionUnguarded> {
  try {
    return await recordPaymentActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof recordPaymentActionUnguarded>>;
  }
}
