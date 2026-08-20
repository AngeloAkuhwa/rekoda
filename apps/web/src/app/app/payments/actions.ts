'use server';

import { revalidatePath } from 'next/cache';
import { submitPaymentConnection } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

export interface ConnectFormState {
  error?: string;
}

/**
 * The one write on the Payments page. The account number crosses this
 * function once, on its way to the API over the internal network, and is
 * never echoed back: the redirect re-renders the page from the API's masked
 * view. Validation mirrors the API contract so the merchant hears about a
 * 9-digit number here, in their language, not as a 400.
 */
export async function submitConnection(
  _prev: ConnectFormState,
  formData: FormData,
): Promise<ConnectFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const bankCode = String(formData.get('bankCode') ?? '');
  const accountNumber = String(formData.get('accountNumber') ?? '').replace(/\s+/g, '');
  const accountName = String(formData.get('accountName') ?? '').trim();

  if (!/^\d{3,6}$/.test(bankCode)) return { error: 'Pick your bank from the list.' };
  if (!/^\d{10}$/.test(accountNumber)) {
    return { error: 'Account numbers have 10 digits. Check and try again.' };
  }
  if (accountName.length < 2) return { error: 'Enter the account name as the bank knows it.' };

  const outcome = await submitPaymentConnection(token, { bankCode, accountNumber, accountName });
  if (outcome.state === 'invalid') {
    return { error: 'Those details did not go through. Check them and try again.' };
  }
  if (outcome.state === 'unavailable') {
    return { error: 'Payment setup is not available yet. Your details were not saved.' };
  }

  revalidatePath('/app/payments');
  return {};
}
