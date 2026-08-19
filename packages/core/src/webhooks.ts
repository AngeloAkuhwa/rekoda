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
