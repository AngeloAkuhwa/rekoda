import 'server-only';
import { randomBytes } from 'node:crypto';
import {
  OTP_TTL_MS,
  issueOtp,
  normalisePhone,
  verifyOtp,
  type OtpChallenge,
  type RandomSource,
} from '@rekoda/core/identity';

/**
 * DEV-ONLY in-memory store.
 *
 * The identity RULES live in `@rekoda/core` and are fully tested there; this is
 * only the persistence seam, so the onboarding flow is runnable before
 * `apps/api` and Postgres land. Every function maps one-to-one onto a
 * `packages/db` table, so replacing it is mechanical.
 *
 * NOT production: state dies with the process and is not tenant-scoped.
 * Swapping it out is an M1 exit criterion.
 */
const otpByPhone = new Map<string, OtpChallenge>();

export const random: RandomSource = (n) => randomBytes(n);

/** Resends within this window reuse the live challenge instead of minting one. */
const RESEND_COOLDOWN_MS = 60 * 1_000;

export type StartResult =
  | { status: 'sent'; code: string; phone: string }
  | { status: 'resend_too_soon'; phone: string; retryInSeconds: number };

/**
 * Every read and write is keyed by the NORMALISED number. Keying on the raw
 * form value meant `/verify?phone=08031234567` looked up a key that was never
 * written, and every code came back "expired".
 */
export function startOtp(phone: string, now = new Date()): StartResult {
  const key = normalisePhone(phone);
  const live = otpByPhone.get(key);

  // A fresh challenge resets `attempts` to 0. Without a cooldown, anyone could
  // spend the attempt limit, request a new code, and keep guessing forever —
  // which would make core's "refuses the correct code after the limit"
  // guarantee buy nothing at all.
  if (live && !live.consumedAt && now < live.expiresAt) {
    const age = now.getTime() - (live.expiresAt.getTime() - OTP_TTL_MS);
    if (age < RESEND_COOLDOWN_MS) {
      return {
        status: 'resend_too_soon',
        phone: key,
        retryInSeconds: Math.ceil((RESEND_COOLDOWN_MS - age) / 1_000),
      };
    }
  }

  const { code, challenge } = issueOtp(key, random, now);
  otpByPhone.set(key, challenge);
  return { status: 'sent', code, phone: key };
}

export function checkOtp(phone: string, code: string, now = new Date()) {
  const key = normalisePhone(phone);
  const challenge = otpByPhone.get(key);
  if (!challenge) return { status: 'expired' as const };
  const result = verifyOtp(challenge, code, now);
  if ('challenge' in result) otpByPhone.set(key, result.challenge);
  return result;
}
