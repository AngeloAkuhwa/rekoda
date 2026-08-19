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

export async function markPhoneVerified(phone: string, now = new Date()): Promise<void> {
  const payload = `${normalisePhone(phone)}.${now.getTime() + TTL_MS}`;
  const jar = await cookies();
  jar.set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: TTL_MS / 1_000,
  });
}

/** Returns the verified phone, or null. Never throws — callers redirect. */
export async function readVerifiedPhone(now = new Date()): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;

  const cut = raw.lastIndexOf('.');
  if (cut < 0) return null;
  const payload = raw.slice(0, cut);
  if (!safeEqual(raw.slice(cut + 1), sign(payload))) return null;

  const sep = payload.lastIndexOf('.');
  if (sep < 0) return null;
  const phone = payload.slice(0, sep);
  const expiresAt = Number(payload.slice(sep + 1));
  if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) return null;
  return phone;
}

export async function clearVerifiedPhone(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
