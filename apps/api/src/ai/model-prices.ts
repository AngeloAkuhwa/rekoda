import { Logger } from '@nestjs/common';
import { modelFamily, registerModelPrice } from '@rekoda/core';

/**
 * Prices for families `@rekoda/core` deliberately does not ship.
 *
 * `MODEL_PRICES` in core carries only the families Rekoda runs by default,
 * and its comment is explicit that anything else is supplied at runtime "from
 * the current price list when you switch providers". This is that list, in
 * the API tier where switching providers is a configuration decision.
 *
 * Published list prices, micro-USD per million tokens, taken from OpenAI's
 * pricing page. THESE GO STALE: they are a planning figure for the margin
 * view, not an invoice, and the number to trust is always the provider's own
 * bill. Update them here when the price list moves.
 */
const OPENAI_PRICES = {
  // $2 / $8 per MTok.
  'gpt-4.1': {
    inputMicrosPerMTok: 2_000_000,
    outputMicrosPerMTok: 8_000_000,
    cacheWriteMicrosPerMTok: 2_000_000,
    cacheReadMicrosPerMTok: 500_000,
  },
  // $0.40 / $1.60 per MTok.
  'gpt-4.1-mini': {
    inputMicrosPerMTok: 400_000,
    outputMicrosPerMTok: 1_600_000,
    cacheWriteMicrosPerMTok: 400_000,
    cacheReadMicrosPerMTok: 100_000,
  },
  // $0.10 / $0.40 per MTok.
  'gpt-4.1-nano': {
    inputMicrosPerMTok: 100_000,
    outputMicrosPerMTok: 400_000,
    cacheWriteMicrosPerMTok: 100_000,
    cacheReadMicrosPerMTok: 25_000,
  },
} as const;

/**
 * Register them, then prove the configured model is actually priced.
 *
 * Registration order matters: `modelFamily` matches the first family whose
 * name the model id contains, so the longer ids go in first — otherwise
 * `gpt-4.1-mini` would match the `gpt-4.1` family and be costed at five times
 * its real price. Sorting by length descending makes that structural rather
 * than a property of how this object happens to be written.
 */
export function registerRuntimeModelPrices(): void {
  for (const family of Object.keys(OPENAI_PRICES).sort((a, b) => b.length - a.length)) {
    registerModelPrice(family, OPENAI_PRICES[family as keyof typeof OPENAI_PRICES]);
  }
}

export class UnpricedModel extends Error {}

/**
 * Refuse to run a model we cannot cost.
 *
 * The alternative is what this codebase had: every call recorded at zero, a
 * margin view that flatters, and nobody finding out until an invoice arrives.
 * A deployment that names an unknown model has made a configuration mistake,
 * and the cheapest moment to hear about it is boot.
 *
 * Only enforced when a key is actually present — a developer running the
 * stack with no provider makes no calls, so there is nothing to misprice.
 */
export function assertModelIsPriced(model: string, hasApiKey: boolean): void {
  if (!hasApiKey) return;
  if (modelFamily(model) === null) {
    throw new UnpricedModel(
      `no price is registered for AI model "${model}". Add its family to ` +
        'apps/api/src/ai/model-prices.ts, or every call will be recorded as free.',
    );
  }
  new Logger('ModelPrices').log(`costing "${model}" as family "${modelFamily(model)}"`);
}
