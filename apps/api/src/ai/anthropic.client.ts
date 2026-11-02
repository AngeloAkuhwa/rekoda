import Anthropic from '@anthropic-ai/sdk';

/** Anthropic's own endpoint: what an unset AI_BASE_URL means, whatever the environment holds. */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * The API version the requests are written against. SDK 1.0 moved its own
 * default to this value; it is pinned here so a later SDK bump cannot change
 * the contract silently, and so an ambient ANTHROPIC_CUSTOM_HEADERS cannot.
 */
export const ANTHROPIC_API_VERSION = '2026-10-21';

/**
 * The one place an Anthropic SDK client is built (interpretation and document
 * reading both use it), so the two cannot drift.
 *
 * - `maxRetries: 0`: the job runner owns retry, with backoff and a dead
 *   letter. Two retry layers means a merchant waits through both, and a call
 *   the SDK silently retried is one we were billed for twice and recorded once.
 * - `openTelemetry: false`: a prompt or a photo is the merchant's data
 *   (invariant 4); no spans from the SDK, whatever the environment says.
 * - `baseURL` always explicit, so the SDK never reads ANTHROPIC_BASE_URL or a
 *   profile host from the process.
 * - One credential per request: the key travels only as `X-Api-Key`, the
 *   header SDK 0.x sent and both the Anthropic API and Anthropic-compatible
 *   gateways behind AI_BASE_URL accept. SDK 1.x would send `apiKey` as
 *   `Authorization: Bearer`; `authorization: null` removes that header.
 *   `anthropic-version` is pinned. ANTHROPIC_CUSTOM_HEADERS is refused outright
 *   (below), so no credential or other header from the environment reaches the
 *   configured host.
 */
export function buildAnthropicClient(
  apiKey: string,
  timeoutMs: number,
  baseUrl?: string,
): Anthropic {
  /* The SDK adds every header named in ANTHROPIC_CUSTOM_HEADERS to every request.
   * Pinning covers the credential and the version, not an arbitrary extra header
   * (`Proxy-Authorization`, `anthropic-beta`), so its presence is refused rather
   * than half-honoured: a bad configuration value fails closed (invariant 8). */
  if (process.env.ANTHROPIC_CUSTOM_HEADERS) {
    throw new Error(
      'ANTHROPIC_CUSTOM_HEADERS is set; Rekoda refuses ambient headers on provider calls. Unset it.',
    );
  }
  return new Anthropic({
    apiKey,
    timeout: timeoutMs,
    maxRetries: 0,
    openTelemetry: false,
    // No SDK logging, whatever ANTHROPIC_LOG says: at debug it would print request bodies (invariant 4).
    logLevel: 'off',
    baseURL: baseUrl || ANTHROPIC_DEFAULT_BASE_URL,
    defaultHeaders: {
      'x-api-key': apiKey,
      // One credential per request, exactly as SDK 0.x sent it: SDK 1.x would add
      // `Authorization: Bearer` too; null removes it (and any ambient token).
      authorization: null,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
  });
}
