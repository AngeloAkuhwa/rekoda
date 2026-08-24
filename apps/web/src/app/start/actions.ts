'use server';

import { redirect } from 'next/navigation';
import { ApiUnavailable, requestOtp, verifyOtp } from '@/server/api';
import { setSessionToken, setSetupToken } from '@/server/session-cookies';
import { stashDevCode } from '@/server/dev-otp';

export interface FormState {
  error?: string;
}

const NOT_A_NUMBER = 'That does not look like a Nigerian mobile number. Try 0803 123 4567.';
const UNAVAILABLE = 'We could not reach Rekoda just now. Try again in a moment.';
const LOCKED_OUT = 'Too many failed attempts for this number. Try again in an hour.';

/**
 * Phone normalisation now happens in ONE place — the API, which calls the same
 * `@rekoda/core` rule the identity tests cover. The web tier deliberately does
 * not normalise a second time: two implementations of "which number is this"
 * is how one merchant becomes two businesses with two ledgers.
 */
export async function requestCode(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = String(formData.get('phone') ?? '').trim();
  if (!raw) return { error: 'Enter your WhatsApp number.' };

  let result;
  try {
    result = await requestOtp(raw);
  } catch (error) {
    if (error instanceof ApiUnavailable) return { error: UNAVAILABLE };
    throw error;
  }

  if (result === 'invalid_phone') return { error: NOT_A_NUMBER };
  if (result.status === 'locked_out') return { error: LOCKED_OUT };

  if (result.status === 'sent') await stashDevCode(result.devCode);

  // `resend_too_soon` still goes forward: the merchant has a live code, and
  // stranding them on /start holding it is the worst of both outcomes.
  redirect(`/verify?phone=${encodeURIComponent(result.phone)}`);
}

export interface ResendState {
  error?: string;
  done?: string;
}

/**
 * A fresh code to the SAME number, without the walk back to /start.
 *
 * "Start again" was the only affordance, and it forgot the phone number on
 * the way. A slow SMS is the single most ordinary failure at the top of the
 * funnel; the answer to it has to be one tap.
 */
export async function resendCode(_prev: ResendState, formData: FormData): Promise<ResendState> {
  const phone = String(formData.get('phone') ?? '');
  if (!phone) return { error: 'Start again with your number.' };

  let result;
  try {
    result = await requestOtp(phone);
  } catch (error) {
    if (error instanceof ApiUnavailable) return { error: UNAVAILABLE };
    throw error;
  }

  if (result === 'invalid_phone') return { error: NOT_A_NUMBER };
  if (result.status === 'locked_out') return { error: LOCKED_OUT };
  if (result.status === 'resend_too_soon') {
    return { done: 'Your last code is still live. Give it a minute to arrive, then check again.' };
  }
  await stashDevCode(result.devCode);
  return { done: 'A new code is on its way to your WhatsApp.' };
}

export async function confirmCode(_prev: FormState, formData: FormData): Promise<FormState> {
  const phone = String(formData.get('phone') ?? '');
  const code = String(formData.get('code') ?? '').trim();
  if (!/^\d{6}$/.test(code)) return { error: 'Enter the 6-digit code.' };

  let result;
  try {
    result = await verifyOtp(phone, code);
  } catch (error) {
    if (error instanceof ApiUnavailable) return { error: UNAVAILABLE };
    throw error;
  }

  if (result === 'invalid_phone') return { error: NOT_A_NUMBER };

  switch (result.status) {
    case 'signed_in':
      // A returning merchant skips setup entirely and lands in the dashboard.
      await setSessionToken(result.sessionToken);
      redirect('/app');
    // eslint-disable-next-line no-fallthrough
    case 'setup_required':
      await setSetupToken(result.setupToken);
      redirect('/setup/business');
    // eslint-disable-next-line no-fallthrough
    case 'wrong_code':
      return {
        error:
          result.attemptsLeft > 0
            ? `That code is not right. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left.`
            : 'That code is not right, and you have no tries left. Start again.',
      };
    case 'too_many_attempts':
      return { error: 'Too many tries. Start again to get a new code.' };
    case 'expired':
      // Covers spent codes too, deliberately. The API reports one status for
      // "no live challenge" whatever the reason, so that probing a number
      // cannot reveal whether a sign-in there recently succeeded. The copy has
      // to be true of both cases, and actionable in both.
      return {
        error: 'That code has expired or has already been used. Start again for a new one.',
      };
    case 'already_used':
      return { error: 'That code has already been used. Start again.' };
    case 'locked_out':
      return { error: LOCKED_OUT };
  }
}
