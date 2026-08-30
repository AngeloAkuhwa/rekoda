'use server';

import { revalidatePath } from 'next/cache';
import {
  ApiForbidden,
  resolvePaymentException,
  submitPaymentConnection,
  viewOnlyRefusal,
  submitMerchantKey,
} from '@/server/api';
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
async function submitConnectionUnguarded(
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

/**
 * Mark an exception reviewed. A stale id (already reviewed in another tab)
 * lands on the refreshed list rather than an error page.
 */
async function markExceptionReviewedUnguarded(formData: FormData): Promise<void> {
  const id = formData.get('exceptionId');
  if (typeof id !== 'string' || id.length === 0) return;
  const token = await readSessionToken();
  if (!token) return;
  await resolvePaymentException(token, id);
  revalidatePath('/app/payments');
}

/* Role refusals (403) come back as a sentence in the form, not a crash.
 * Everything else still throws to the error boundary. */

export async function submitConnection(
  ...args: Parameters<typeof submitConnectionUnguarded>
): ReturnType<typeof submitConnectionUnguarded> {
  try {
    return await submitConnectionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof submitConnectionUnguarded>>;
  }
}

export async function markExceptionReviewed(
  ...args: Parameters<typeof markExceptionReviewedUnguarded>
): ReturnType<typeof markExceptionReviewedUnguarded> {
  try {
    return await markExceptionReviewedUnguarded(...args);
  } catch (error) {
    /* A view-only member clicking "reviewed" changes nothing, and this action
     * has no form state to say so in; the refreshed list is the answer. */
    if (error instanceof ApiForbidden) return;
    throw error;
  }
}

export interface MerchantKeyFormState {
  error?: string;
  done?: string;
}

async function submitMerchantKeyActionUnguarded(
  _prev: MerchantKeyFormState,
  formData: FormData,
): Promise<MerchantKeyFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const secretKey = String(formData.get('secretKey') ?? '').trim();
  if (secretKey.length < 10) {
    return { error: 'Paste the whole key. It starts with sk_test_ or sk_live_.' };
  }

  const outcome = await submitMerchantKey(token, secretKey);
  if (!outcome) return { error: 'That did not go through. Nothing was stored.' };
  if (outcome.state === 'rejected') {
    return {
      error:
        'Paystack did not accept that key. Copy it again from your Paystack dashboard under ' +
        'Settings, then API Keys; a revoked or truncated key reads the same as a wrong one.',
    };
  }
  if (outcome.state === 'rejected_test_key') {
    return {
      error:
        'That is a test key. It works, but the payments it confirms are not real money, so ' +
        'Rekoda will not mark your invoices paid with it. Copy your live key from Paystack ' +
        'under Settings, then API Keys; it starts with sk_live_. Nothing was stored.',
    };
  }
  if (outcome.state === 'unavailable') {
    return { error: 'Key storage is not switched on for this deployment yet. Nothing was stored.' };
  }

  revalidatePath('/app/payments');
  return {
    done: `Connected: key ending ${outcome.merchantKeyTail}. Payments now run on your own Paystack account, and the key never appears anywhere again.`,
  };
}

export async function submitMerchantKeyAction(
  ...args: Parameters<typeof submitMerchantKeyActionUnguarded>
): ReturnType<typeof submitMerchantKeyActionUnguarded> {
  try {
    return await submitMerchantKeyActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof submitMerchantKeyActionUnguarded>>;
  }
}
