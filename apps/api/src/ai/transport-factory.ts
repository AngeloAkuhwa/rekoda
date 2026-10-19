/**
 * Which model transport this configuration runs, decided ONCE (G-07).
 *
 * The API's module and the live evaluation runner both build their
 * transports here, so an evaluation measures exactly what production would
 * call: the configured provider, its base URL, its priced roles. A second
 * copy of these rules in the runner is how an eval came to measure
 * Anthropic for a deployment configured for OpenAI.
 *
 * No fallback between providers: a configuration either names one that is
 * reachable, or it degrades honestly (`NoTransportConfigured`).
 */
import type { ApiConfig } from '../config.js';
import { AnthropicTransport } from './anthropic.transport.js';
import { OpenAiTransport } from './openai.transport.js';
import {
  assertModelIsPriced,
  assertRolesArePriced,
  registerRuntimeModelPrices,
} from './model-prices.js';
import { ProviderUnreachable, type ModelTransport } from './transport.js';

/**
 * A transport that refuses rather than one that is absent.
 *
 * Without an API key the honest options are "fail at boot" or "behave as if
 * the provider is down". Failing at boot would stop a developer running the
 * web app to look at a page, and the deterministic router already answers most
 * messages without a model — so a missing key degrades the product rather than
 * breaking it.
 *
 * It throws `ProviderUnreachable` specifically, which the interpreter already
 * knows to handle by handing the merchant's quota slot back. There is nothing
 * special-cased about the no-key path; it takes the same route as a provider
 * outage because that is what it is.
 */
export class NoTransportConfigured implements ModelTransport {
  send(): Promise<never> {
    return Promise.reject(new ProviderUnreachable('ANTHROPIC_API_KEY is not set'));
  }
}

/** The primary transport for every token-priced role. */
export function createModelTransport(config: ApiConfig): ModelTransport {
  /**
   * One port, two providers, chosen by configuration.
   *
   * Everything that decides what Rekoda does — the ₦10bn ceiling, the
   * schema border, the spend ceiling, the conversation gates — sits
   * above this line and does not know which provider answered.
   */
  /* Prices before transports: a call that cannot be costed is a call
   * that quietly reports as free, so the check happens at boot rather
   * than at the first invoice. */
  registerRuntimeModelPrices(config.aiModelPrices ?? undefined);

  /* EVERY token-priced role, not just the interpreter. The classifier,
   * vision and escalation models each spend provider money on their
   * own id, and a role whose model has no price is a role whose every
   * call reports as free. The transcriber is deliberately absent: it
   * is priced per MINUTE, not per token, and its price is validated
   * where that mechanism lives. */
  const tokenRoles = [
    config.aiModelDefault,
    config.aiModelClassifier,
    config.aiModelVision,
    config.aiModelEscalation,
  ];

  if (config.aiProvider === 'openai') {
    assertRolesArePriced(tokenRoles, Boolean(config.openaiApiKey));
    /* `aiBaseUrl` is what makes this an OPENAI-COMPATIBLE transport
     * rather than an OpenAI one: DeepSeek weights on a US host, Groq,
     * Together, OpenRouter all speak this wire format. Undefined means
     * OpenAI itself, which is the SDK's own default. */
    return config.openaiApiKey
      ? new OpenAiTransport(config.openaiApiKey, undefined, config.aiBaseUrl ?? undefined)
      : new NoTransportConfigured();
  }
  assertRolesArePriced(tokenRoles, Boolean(config.anthropicApiKey));
  return config.anthropicApiKey
    ? new AnthropicTransport(config.anthropicApiKey, undefined, config.aiBaseUrl ?? undefined)
    : new NoTransportConfigured();
}

/**
 * The INDEPENDENT second reader for high-value documents (item 9).
 *
 * Always OpenAI-side, never a second handle on the primary transport:
 * a verifier from the same provider shares the primary's blind spots,
 * and agreement between two calls to one vendor is not verification.
 * Deliberately does NOT reuse `aiBaseUrl` — that URL belongs to the
 * primary provider, and pointing the verifier at it would quietly
 * collapse the independence this token exists for.
 *
 * Null when unset: dual extraction is opt-in until the verifying model
 * is chosen and priced. Configured without its key or without a price,
 * boot refuses — a protection that silently does not run is worse than
 * one that is honestly absent.
 */
export function createVerifierTransport(config: ApiConfig): ModelTransport | null {
  const model = config.aiModelVisionVerifier;
  if (!model) return null;
  if (!config.openaiApiKey) {
    throw new Error(
      'AI_MODEL_VISION_VERIFIER is set but OPENAI_API_KEY is not. The verifier is a ' +
        'second, independent provider by design; supply its key or unset the verifier.',
    );
  }
  /* Idempotent re-registration: factory order is not guaranteed, and
   * the price check below needs the runtime table populated. */
  registerRuntimeModelPrices(config.aiModelPrices ?? undefined);
  assertModelIsPriced(model, true);
  return new OpenAiTransport(config.openaiApiKey);
}

/**
 * The model behind every AI role this configuration runs, and nothing
 * secret: no key, no full base URL (it can carry credentials), only
 * whether each key is present and the base URL's host.
 */
export interface AiConfigurationSummary {
  readonly provider: 'anthropic' | 'openai';
  readonly baseUrlHost: string | null;
  readonly keyPresent: { readonly anthropic: boolean; readonly openai: boolean };
  readonly models: {
    readonly interpreter: string;
    readonly classifier: string;
    readonly escalation: string;
    readonly vision: string;
    readonly visionVerifier: string | null;
    readonly transcriber: string | null;
  };
}

export function describeAiConfiguration(config: ApiConfig): AiConfigurationSummary {
  let baseUrlHost: string | null = null;
  if (config.aiBaseUrl) {
    try {
      baseUrlHost = new URL(config.aiBaseUrl).host;
    } catch {
      baseUrlHost = 'unparseable';
    }
  }
  return {
    provider: config.aiProvider,
    baseUrlHost,
    keyPresent: {
      anthropic: Boolean(config.anthropicApiKey),
      openai: Boolean(config.openaiApiKey),
    },
    models: {
      interpreter: config.aiModelDefault,
      classifier: config.aiModelClassifier,
      escalation: config.aiModelEscalation,
      vision: config.aiModelVision,
      visionVerifier: config.aiModelVisionVerifier ?? null,
      transcriber: config.voiceTranscriptionEnabled ? config.aiModelTranscriber : null,
    },
  };
}
