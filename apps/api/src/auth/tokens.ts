/**
 * The setup grant: the bridge between "this phone is verified" and "this
 * merchant has a business".
 *
 * A session cannot cover that gap, because a session is bound to a business by
 * definition and there is not one yet. Rather than making `sessions.business_id`
 * nullable — which would weaken the invariant everywhere for the sake of ninety
 * seconds of onboarding — the gap gets its own artefact with exactly one
 * permitted use: creating the first business.
 *
 * Stateless and HMAC-signed. It is short-lived, single-purpose, and confers no
 * read access to anything, so the cost of not storing it is bounded: a stolen
 * grant can create a business for a phone the thief already controls.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SETUP_TOKEN_TTL_MS = 30 * 60 * 1_000;

export interface SetupGrant {
  userId: string;
  phone: string;
  expiresAt: Date;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function issueSetupToken(grant: Omit<SetupGrant, 'expiresAt'>, now: Date, secret: string) {
  const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_MS);
  // The phone is base64url-encoded so the '+' in E.164 cannot be mistaken for
  // a separator, and so the payload stays a single unambiguous split.
  const payload = [
    grant.userId,
    Buffer.from(grant.phone, 'utf8').toString('base64url'),
    String(expiresAt.getTime()),
  ].join('.');
  return { token: `${payload}.${sign(payload, secret)}`, expiresAt };
}

/** Null for every expired, malformed or forged token — callers just redirect. */
export function readSetupToken(token: string, now: Date, secret: string): SetupGrant | null {
  const cut = token.lastIndexOf('.');
  if (cut < 0) return null;
  const payload = token.slice(0, cut);
  if (!safeEqual(token.slice(cut + 1), sign(payload, secret))) return null;

  const parts = payload.split('.');
  if (parts.length !== 3) return null;
  const [userId, encodedPhone, expiry] = parts as [string, string, string];

  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;

  return {
    userId,
    phone: Buffer.from(encodedPhone, 'base64url').toString('utf8'),
    expiresAt: new Date(expiresAt),
  };
}
