import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { normalisePhone } from '@rekoda/core/identity';

/**
 * Proof that THIS browser completed the OTP step.
 *
 * Before this existed, the step guards only checked that a `phone` query param
 * was present — so `GET /setup/business?phone=+234…` rendered for any number,
 * and a merchant (or anyone) could complete signup without ever passing
 * /verify. The OTP was decorative. This is the fix.
 *
 * An HMAC-signed, HTTP-only cookie is the smallest thing that is actually
 * sound here, and it is the same shape as the real session cookie that
 * replaces it once apps/api lands (spec §36).
 */
const COOKIE = 'rk_verified';
const TTL_MS = 30 * 60 * 1_000; // 30 minutes to finish signup
/** Once the business exists, the marker only needs to outlive the last page. */
const DONE_TTL_MS = 5 * 60 * 1_000;

/**
 * Where the merchant is in signup. `/setup/business` demands `verified`;
 * `/setup/complete` accepts either, so finishing setup can downgrade the marker
 * rather than leaving full proof-of-identity live for the remaining half hour.
 */
export type Stage = 'verified' | 'complete';

/**
 * Dev generates an ephemeral secret so the flow runs locally; production must
 * supply one and fails loudly rather than signing with a guessable value.
 *
 * Resolved LAZILY, on first signature. Doing this at module load threw during
 * `next build` — which runs with NODE_ENV=production but has no runtime env —
 * and broke the build. The secret is a request-time concern, not a build-time
 * one, and the boot doctor (MASTER-PLAN §3.4) is where absence should surface.
 */
let cachedSecret: string | undefined;

function secret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.REKODA_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 32) {
    cachedSecret = fromEnv;
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('REKODA_SESSION_SECRET must be set (>=32 chars) in production');
  } else {
    cachedSecret = randomBytes(32).toString('hex');
  }
  return cachedSecret;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function setMarker(phone: string, stage: Stage, ttlMs: number, now: Date): Promise<void> {
  const payload = `${normalisePhone(phone)}.${stage}.${now.getTime() + ttlMs}`;
  const jar = await cookies();
  jar.set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ttlMs / 1_000,
  });
}

/** Issued in exactly one place: successful OTP verification. */
export async function markPhoneVerified(phone: string, now = new Date()): Promise<void> {
  await setMarker(phone, 'verified', TTL_MS, now);
}

/**
 * Downgrade after the business is created. Clearing outright would bounce the
 * merchant off the completion page they just earned; this keeps them there
 * without leaving proof-of-identity live for the rest of the window.
 */
export async function markSetupComplete(phone: string, now = new Date()): Promise<void> {
  await setMarker(phone, 'complete', DONE_TTL_MS, now);
}

/**
 * Returns the verified phone, or null, for every malformed or forged cookie.
 *
 * It CAN still throw one way: in production with `REKODA_SESSION_SECRET`
 * unset, `sign()` raises. That is deliberate — a misconfigured deployment must
 * fail loudly — but note it fails only for merchants mid-signup, since
 * cookie-less visitors return early and never reach the signature check. The
 * boot doctor (MASTER-PLAN §3.4) is where absence should surface first.
 */
export async function readMarker(
  now = new Date(),
): Promise<{ phone: string; stage: Stage } | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;

  const cut = raw.lastIndexOf('.');
  if (cut < 0) return null;
  const payload = raw.slice(0, cut);
  if (!safeEqual(raw.slice(cut + 1), sign(payload))) return null;

  // phone.stage.expiry — a normalised phone and a base64url signature both
  // contain no '.', so this split is unambiguous.
  const parts = payload.split('.');
  if (parts.length !== 3) return null;
  const [phone, stage, expiry] = parts as [string, string, string];
  if (stage !== 'verified' && stage !== 'complete') return null;

  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) return null;
  return { phone, stage };
}

/** Proof the OTP was passed. Null for anything else — callers redirect. */
export async function readVerifiedPhone(now = new Date()): Promise<string | null> {
  const m = await readMarker(now);
  return m?.stage === 'verified' ? m.phone : null;
}

/** Either stage — used only by the terminal completion page. */
export async function readAnyStagePhone(now = new Date()): Promise<string | null> {
  return (await readMarker(now))?.phone ?? null;
}

export async function clearVerifiedPhone(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
