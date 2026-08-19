import 'server-only';
import { randomBytes } from 'node:crypto';
import { issueOtp, verifyOtp, type OtpChallenge, type RandomSource } from '@rekoda/core';

/**
 * DEV-ONLY in-memory store.
 *
 * The identity RULES live in `@rekoda/core` and are fully tested there; this
 * file is only the persistence seam, and it exists so the onboarding flow is
 * runnable and reviewable before `apps/api` and Postgres land. Every function
 * here maps one-to-one onto a `packages/db` table (`otp_challenges`, `users`,
 * `businesses`), so replacing it is mechanical rather than a redesign.
 *
 * It is NOT production: state dies with the process and is not tenant-scoped.
 * Swapping it out is an M1 exit criterion.
 */
const otpByPhone = new Map<string, OtpChallenge>();

export const random: RandomSource = (n) => randomBytes(n);

export function startOtp(phone: string, now = new Date()) {
  const { code, challenge } = issueOtp(phone, random, now);
  otpByPhone.set(challenge.phone, challenge);
  return { code, phone: challenge.phone };
}

export function checkOtp(phone: string, code: string, now = new Date()) {
  const challenge = otpByPhone.get(phone);
  if (!challenge) return { status: 'expired' as const };
  const result = verifyOtp(challenge, code, now);
  if ('challenge' in result) otpByPhone.set(phone, result.challenge);
  return result;
}
