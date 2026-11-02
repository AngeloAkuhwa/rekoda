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
 * - Authentication headers are pinned in `defaultHeaders`. SDK 1.x sends
 *   `apiKey` only as `Authorization: Bearer`, so `X-Api-Key` is added for an
 *   Anthropic-compatible gateway behind AI_BASE_URL that checks only that
 *   header; `Authorization` and `anthropic-version` are repeated there because
 *   the SDK lets ANTHROPIC_CUSTOM_HEADERS from the process replace its own
 *   copies, and a credential from the environment must never reach the
 *   configured host.
 */
export function buildAnthropicClient(
  apiKey: string,
  timeoutMs: number,
  baseUrl?: string,
): Anthropic {
  return new Anthropic({
    apiKey,
    timeout: timeoutMs,
    maxRetries: 0,
    openTelemetry: false,
    baseURL: baseUrl || ANTHROPIC_DEFAULT_BASE_URL,
    defaultHeaders: {
      'x-api-key': apiKey,
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
  });
}
