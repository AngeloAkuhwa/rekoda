'use server';

import { redirect } from 'next/navigation';
import { InvalidPhoneError, normalisePhone } from '@rekoda/core';
import { startOtp, checkOtp } from '@/server/onboarding-store';

export interface FormState {
  error?: string;
}

export async function requestCode(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = String(formData.get('phone') ?? '').trim();
  if (!raw) return { error: 'Enter your WhatsApp number.' };

  let phone: string;
  try {
    phone = normalisePhone(raw);
  } catch (e) {
    if (e instanceof InvalidPhoneError) {
      return { error: 'That does not look like a Nigerian mobile number. Try 0803 123 4567.' };
    }
    throw e;
  }

  const { code } = startOtp(phone);
  // TODO(M1): send via Meta Cloud API (ADR 0002). Until the channel layer
  // lands, the code is logged server-side so the flow is walkable end to end.
  console.info(`[dev] OTP for ${phone}: ${code}`);

  redirect(`/verify?phone=${encodeURIComponent(phone)}`);
}

export async function confirmCode(_prev: FormState, formData: FormData): Promise<FormState> {
  const phone = String(formData.get('phone') ?? '');
  const code = String(formData.get('code') ?? '').trim();
  if (!/^\d{6}$/.test(code)) return { error: 'Enter the 6-digit code.' };

  const result = checkOtp(phone, code);
  switch (result.status) {
    case 'verified':
      redirect(`/setup/business?phone=${encodeURIComponent(phone)}`);
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
