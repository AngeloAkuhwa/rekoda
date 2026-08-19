'use server';

import { redirect } from 'next/navigation';
import { InvalidPhoneError, normalisePhone } from '@rekoda/core/identity';
import { checkOtp, startOtp } from '@/server/onboarding-store';
import { markPhoneVerified } from '@/server/verified-phone';

export interface FormState {
  error?: string;
}

const NOT_A_NUMBER = 'That does not look like a Nigerian mobile number. Try 0803 123 4567.';

export async function requestCode(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = String(formData.get('phone') ?? '').trim();
  if (!raw) return { error: 'Enter your WhatsApp number.' };

  let phone: string;
  try {
    phone = normalisePhone(raw);
  } catch (e) {
    if (e instanceof InvalidPhoneError) return { error: NOT_A_NUMBER };
    throw e;
  }

  const result = startOtp(phone);
  if (result.status === 'resend_too_soon') {
    return {
      error: `We already sent a code. Try again in ${result.retryInSeconds} seconds, or check WhatsApp.`,
    };
  }

  // TODO(M1): send via Meta Cloud API (ADR 0002). Until the channel layer
  // lands the code is surfaced in the dev console only — never in a deployed
  // environment, where it would put a live credential in the log store next to
  // the phone number it unlocks.
  if (process.env.NODE_ENV !== 'production') {
    console.info(`[dev] OTP for ${result.phone}: ${result.code}`);
  }

  redirect(`/verify?phone=${encodeURIComponent(result.phone)}`);
}

export async function confirmCode(_prev: FormState, formData: FormData): Promise<FormState> {
  const rawPhone = String(formData.get('phone') ?? '');
  const code = String(formData.get('code') ?? '').trim();
  if (!/^\d{6}$/.test(code)) return { error: 'Enter the 6-digit code.' };

  let phone: string;
  try {
    phone = normalisePhone(rawPhone);
  } catch {
    return { error: NOT_A_NUMBER };
  }

  const result = checkOtp(phone, code);
  switch (result.status) {
    case 'verified':
      // The ONLY place this cookie is issued. Every later step reads it, so the
      // OTP cannot be skipped by typing a URL.
      await markPhoneVerified(phone);
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
      return { error: 'That code has expired. Start again to get a new one.' };
    case 'already_used':
      return { error: 'That code has already been used. Start again.' };
  }
}
