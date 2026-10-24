'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ApiForbidden, billingCheckout, billingEmailVerify, viewOnlyRefusal } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';
import {
  billingEmailLengthProblem,
  checkoutInputProblem,
  checkoutRefusalCopy,
  emailVerifyCopy,
  safeCheckoutUrl,
} from '@/lib/billing-pay-copy';

export interface PayFormState {
  error?: string;
  /** Show the email field: Paystack needs an address and none is usable. */
  askEmail?: boolean;
  done?: string;
}

/**
 * Start (or restart) the Paystack checkout for one pending charge. The browser
 * only names the charge; the amount, the plan and the business all come from the
 * server. On success the merchant is sent to Paystack's own page.
 */
async function startCheckoutUnguarded(
  _prev: PayFormState,
  formData: FormData,
): Promise<PayFormState> {
  const token = await readSessionToken();
  if (!token) redirect('/start');

  const reference = String(formData.get('reference') ?? '');
  const typed = String(formData.get('billingEmail') ?? '').trim();
  const problem = checkoutInputProblem(reference, typed);
  if (problem) return { error: problem };
  const restart = formData.get('restart') === '1';
  const answer = await billingCheckout(token, {
    reference,
    ...(typed ? { billingEmail: typed } : {}),
    ...(restart ? { restart: true } : {}),
  });
  revalidatePath('/app/billing');

  if (answer.state === 'ready') {
    const url = safeCheckoutUrl(answer.checkoutUrl);
    if (!url) {
      return { error: 'We could not open the payment page just now. Nothing was charged.' };
    }
    redirect(url);
  }
  const refusal = checkoutRefusalCopy(answer);
  return { error: refusal.message, ...(refusal.askEmail ? { askEmail: true } : {}) };
}

export async function startCheckoutAction(
  prev: PayFormState,
  formData: FormData,
): Promise<PayFormState> {
  try {
    return await startCheckoutUnguarded(prev, formData);
  } catch (error) {
    if (error instanceof ApiForbidden) return viewOnlyRefusal(error);
    throw error;
  }
}

/** Save a billing email (when one is typed) and mail the confirmation link. */
async function sendConfirmationUnguarded(
  _prev: PayFormState,
  formData: FormData,
): Promise<PayFormState> {
  const token = await readSessionToken();
  if (!token) redirect('/start');

  const typed = String(formData.get('billingEmail') ?? '').trim();
  const tooLong = billingEmailLengthProblem(typed);
  if (tooLong) return { error: tooLong };
  const answer = await billingEmailVerify(token, typed || undefined);
  revalidatePath('/app/billing');
  const copy = emailVerifyCopy(answer);
  return copy.ok ? { done: copy.message } : { error: copy.message };
}

export async function sendConfirmationAction(
  prev: PayFormState,
  formData: FormData,
): Promise<PayFormState> {
  try {
    return await sendConfirmationUnguarded(prev, formData);
  } catch (error) {
    if (error instanceof ApiForbidden) return viewOnlyRefusal(error);
    throw error;
  }
}
