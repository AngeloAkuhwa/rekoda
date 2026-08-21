'use server';

import { revalidatePath } from 'next/cache';
import { voidInvoice } from '@/server/api';
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
