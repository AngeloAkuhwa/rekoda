/**
 * Webhook signature verification (spec §38, MASTER-PLAN §5.3.1).
 *
 * Pure crypto over bytes. The one rule that matters here is that the signature
 * covers the RAW request body — the exact bytes Meta hashed — and not a
 * re-serialisation of the parsed JSON. `JSON.parse` followed by
 * `JSON.stringify` is not the identity function: key order, whitespace and
 * unicode escaping all move, and the HMAC then fails for every legitimate
 * request while still passing for none. Capture the raw body first.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs with `sha256=<hex>` in `X-Hub-Signature-256`.
 *
 * Returns a boolean rather than throwing: a bad signature is an ordinary,
 * expected event — the internet scans for open webhooks — not an exception.
 */
export function verifyMetaSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;

  const [algorithm, provided] = header.split('=');
  if (algorithm !== 'sha256' || !provided) return false;

  const expected = createHmac('sha256', appSecret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');

  // Compare as bytes of equal length. `timingSafeEqual` throws on a length
  // mismatch, which would itself leak the expected length, so that is checked
  // first and returns the same false as any other mismatch.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The `GET` handshake Meta uses to prove it is talking to the right endpoint.
 *
 * Returns the challenge to echo, or null. The token comparison is
 * constant-time for the same reason as above: this endpoint is unauthenticated
 * and world-reachable, so it is a place someone can measure.
 */
export function answerVerificationChallenge(
  query: { mode?: string; token?: string; challenge?: string },
  expectedToken: string,
): string | null {
  if (query.mode !== 'subscribe' || !query.token || !query.challenge) return null;
  if (!expectedToken) return null;

  const a = Buffer.from(query.token, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? query.challenge : null;
}

/**
 * Paystack signs with HMAC-SHA512 of the raw body under the SECRET KEY,
 * delivered bare-hex in `x-paystack-signature` — no `sha512=` prefix, unlike
 * Meta's header format. The raw-bytes rule is identical.
 *
 * An empty secret returns false for everything, so a deployment without
 * Paystack configured rejects webhooks rather than accepting unsigned ones —
 * the same safe direction of failure as the Meta endpoint.
 */
export function verifyPaystackSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secretKey: string,
): boolean {
  if (!header || !secretKey) return false;

  const expected = createHmac('sha512', secretKey)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ─────────────────── outbound: what Rekoda signs (PR-112) ─────────────── */

/**
 * Rekoda's own signature header, on every webhook it sends.
 *
 * `t=<unix seconds>,v1=<hex hmac>` — the shape the industry converged on,
 * and it converged on it for a reason worth restating. The timestamp is
 * INSIDE the signed material, so a captured delivery cannot be replayed a
 * week later against a verifier that checks the age: an attacker who moves
 * `t` invalidates `v1`, and one who keeps `t` fails the age check. Signing
 * the body alone would leave replay entirely to the receiver's memory.
 *
 * `v1` is a version on the SCHEME, not on the payload. If the algorithm ever
 * changes, a `v2=` is added beside it for a transition period rather than
 * `v1` quietly meaning something else.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'rekoda-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'rekoda-timestamp';

/** How far out of date a delivery may be before a verifier should refuse it. */
export const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

/** Sign a body for one moment. The timestamp is part of what is signed. */
export function signWebhook(rawBody: string, secret: string, at: Date): string {
  const seconds = Math.floor(at.getTime() / 1000);
  const digest = createHmac('sha256', secret).update(`${seconds}.${rawBody}`, 'utf8').digest('hex');
  return `t=${seconds},v1=${digest}`;
}

/**
 * The verification a merchant's own endpoint performs, written here so the
 * documentation can quote working code rather than describe it.
 *
 * Two checks, and both are load-bearing: the digest must match, and the
 * timestamp must be recent. A verifier that skips the second accepts a
 * replay of a real, correctly signed delivery forever.
 */
export function verifyRekodaSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  now: Date,
  windowSeconds = WEBHOOK_REPLAY_WINDOW_SECONDS,
): boolean {
  if (!header || !secret) return false;

  const parts = new Map(
    header.split(',').map((part) => {
      const [key, value] = part.split('=');
      return [key?.trim() ?? '', value?.trim() ?? ''] as const;
    }),
  );
  const seconds = Number(parts.get('t'));
  const presented = parts.get('v1');
  if (!Number.isFinite(seconds) || !presented) return false;

  const age = Math.abs(Math.floor(now.getTime() / 1000) - seconds);
  if (age > windowSeconds) return false;

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${seconds}.${body}`, 'utf8').digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * When to try again, by attempt number.
 *
 * Exponential with a ceiling: 1 minute, 5, 25, 2 hours, 10 hours, then a day.
 * Six attempts spread over roughly a day and a half, which outlasts an
 * ordinary outage on the merchant's side without hammering an endpoint that
 * is down for good. Past the last attempt a delivery is dead and visible.
 */
export const WEBHOOK_BACKOFF_SECONDS = [60, 300, 1_500, 7_200, 36_000, 86_400] as const;

/**
 * How many endpoints one business may register (PR-134).
 *
 * Every business event fans out to EVERY matching endpoint, and each
 * delivery is retried up to six times, so the endpoint count multiplies
 * the estate's outbound volume directly. Ten is far above what an
 * integration needs and low enough that a compromised owner account cannot
 * turn one business into a thousand-destination amplifier. Raising it is a
 * commercial decision, not an incident-time one.
 */
export const MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS = 10;

export function nextAttemptAt(attempts: number, from: Date): Date {
  const index = Math.min(Math.max(attempts, 1), WEBHOOK_BACKOFF_SECONDS.length) - 1;
  return new Date(from.getTime() + WEBHOOK_BACKOFF_SECONDS[index]! * 1_000);
}

/**
 * Does this endpoint want this fact?
 *
 * An EMPTY subscription means everything. A merchant who has not thought
 * about which events they want should receive them all rather than silently
 * receive none, because "I registered a webhook and nothing arrives" is the
 * worst first experience a developer platform can offer.
 */
export function wantsEvent(subscribed: readonly string[], type: string): boolean {
  return subscribed.length === 0 || subscribed.includes(type);
}
