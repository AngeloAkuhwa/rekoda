import 'server-only';
import { randomBytes } from 'node:crypto';
import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  issueOtp,
  normalisePhone,
  verifyOtp,
  type OtpChallenge,
  type RandomSource,
} from '@rekoda/core/identity';

/**
 * DEV-ONLY in-memory store. The identity RULES live in `@rekoda/core` and are
 * tested there; this is only the persistence seam so the flow is runnable
 * before `apps/api` and Postgres land. Each function maps one-to-one onto a
 * `packages/db` table. NOT production: state dies with the process and is not
 * tenant-scoped. Replacing it is an M1 exit criterion.
 */
/**
 * Pinned to `globalThis`, and NOT for the usual hot-reload reason.
 *
 * Next compiles server actions and page components into separate server
 * bundles, so a plain module-level `Map` is instantiated once per bundle: the
 * page reads a different map than the action wrote to. The e2e suite caught
 * exactly this — the action stored a code and the page found nothing.
 *
 * It is one more reason this seam has to become Postgres. A store whose
 * correctness depends on which bundle happens to touch it is not a store.
 */
interface DevStore {
  otpByPhone: Map<string, OtpChallenge>;
  failuresByPhone: Map<string, { count: number; windowStartedAt: number }>;
  e2eCodes: Map<string, string>;
}
const g = globalThis as typeof globalThis & { __rekodaDevStore?: DevStore };
const store: DevStore = (g.__rekodaDevStore ??= {
  otpByPhone: new Map(),
  failuresByPhone: new Map(),
  e2eCodes: new Map(),
});

const otpByPhone = store.otpByPhone;

/**
 * Failed attempts across ALL challenges for a number.
 *
 * Per-challenge attempts alone were only a 60-second lockout: burn five
 * guesses, wait for the cooldown, request a fresh challenge with `attempts`
 * back at zero, repeat. This counter is what actually bounds guessing.
 */
const failuresByPhone = store.failuresByPhone;
const FAILURE_WINDOW_MS = 60 * 60 * 1_000; // 1 hour
const MAX_FAILURES_PER_WINDOW = 15;

/** Resends within this window reuse the live challenge instead of minting one. */
const RESEND_COOLDOWN_MS = 60 * 1_000;

export const random: RandomSource = (n) => randomBytes(n);

/**
 * Server-side pepper for OTP hashing (never stored beside the hash).
 * Dev generates an ephemeral one; production must supply it.
 */
let cachedPepper: string | undefined;
function pepper(): string {
  if (cachedPepper) return cachedPepper;
  const fromEnv = process.env.OTP_PEPPER;
  if (fromEnv && fromEnv.length >= 32) cachedPepper = fromEnv;
  else if (process.env.NODE_ENV === 'production')
    throw new Error('OTP_PEPPER must be set (>=32 chars) in production');
  else cachedPepper = randomBytes(32).toString('hex');
  return cachedPepper;
}

function bumpFailures(key: string, now: Date): number {
  const rec = failuresByPhone.get(key);
  if (!rec || now.getTime() - rec.windowStartedAt >= FAILURE_WINDOW_MS) {
    failuresByPhone.set(key, { count: 1, windowStartedAt: now.getTime() });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

function lockedOut(key: string, now: Date): boolean {
  const rec = failuresByPhone.get(key);
  if (!rec) return false;
  if (now.getTime() - rec.windowStartedAt >= FAILURE_WINDOW_MS) return false;
  return rec.count >= MAX_FAILURES_PER_WINDOW;
}

/**
 * TEST-ONLY plaintext escrow, and the only reason it exists is that the e2e
 * suite runs against a PRODUCTION build — which is the whole point, since that
 * is where the dev-only console logging is correctly off.
 *
 * Gated on an env var that exists nowhere but `playwright.config.ts`. It is
 * never set by the Dockerfile, the deploy runbook, or `.env.example`, and
 * `e2e/onboarding.spec.ts` asserts the attribute is absent when it is unset.
 * If this ever needs to survive M1, replace it with a test-only API route that
 * the production build tree-shakes out entirely.
 */
const e2eCodes = store.e2eCodes;
const REVEAL = process.env.REKODA_E2E_REVEAL_OTP === '1';

export function e2eCodeFor(phone: string): string | undefined {
  if (!REVEAL) return undefined;
  return e2eCodes.get(normalisePhone(phone));
}

export type StartResult =
  | { status: 'sent'; code: string; phone: string }
  | { status: 'resend_too_soon'; phone: string; retryInSeconds: number }
  | { status: 'locked_out'; phone: string };

/** Every read and write is keyed by the NORMALISED number. */
export function startOtp(phone: string, now = new Date()): StartResult {
  const key = normalisePhone(phone);
  if (lockedOut(key, now)) return { status: 'locked_out', phone: key };

  const live = otpByPhone.get(key);
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

  const { code, challenge } = issueOtp(key, random, now, pepper());
  otpByPhone.set(key, challenge);
  if (REVEAL) e2eCodes.set(key, code);
  return { status: 'sent', code, phone: key };
}

export type CheckResult = ReturnType<typeof verifyOtp> | { status: 'locked_out' };

export function checkOtp(phone: string, code: string, now = new Date()): CheckResult {
  const key = normalisePhone(phone);
  if (lockedOut(key, now)) return { status: 'locked_out' };

  const challenge = otpByPhone.get(key);
  if (!challenge) return { status: 'expired' as const };

  const result = verifyOtp(challenge, code, now, pepper());
  if ('challenge' in result) otpByPhone.set(key, result.challenge);
  if (result.status === 'wrong_code') {
    if (bumpFailures(key, now) >= MAX_FAILURES_PER_WINDOW) return { status: 'locked_out' };
  }
  return result;
}
