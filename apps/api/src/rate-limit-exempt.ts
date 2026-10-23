/**
 * The routes the per-IP limiter never counts (G-21).
 *
 * The health endpoint is polled by the platform, and the two webhooks carry
 * every merchant's traffic from a handful of source addresses, so a per-IP
 * ceiling would start refusing the platform's own inbound. Each webhook
 * verifies an HMAC signature before doing anything, which is a stronger gate
 * than any counter.
 *
 * The comparison is on the PATH. Meta's verification handshake is a GET whose
 * URL always carries `hub.mode`, `hub.verify_token` and `hub.challenge`, so
 * comparing the raw URL never matched it and a burst of handshakes was refused.
 * The match stays exact: a path that merely starts with an exempt one is
 * counted like any other.
 */
const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/webhooks/meta',
  '/webhooks/paystack',
]);

export function isRateLimitExempt(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0] ?? '';
  return EXEMPT_PATHS.has(path);
}
