import { Logger } from '@nestjs/common';
import { modelFamily, registerModelPrice } from '@rekoda/core';

/**
 * Prices `@rekoda/core` deliberately does not ship, supplied as CONFIGURATION.
 *
 * `MODEL_PRICES` in core carries only the Claude families Rekoda runs by
 * default, and its comment is explicit that anything else arrives at runtime
 * "from the current price list when you switch providers". This is that door,
 * and it is an env var rather than a table in this file for two reasons.
 *
 * A table here goes stale silently. The one this replaces held OpenAI's
 * `gpt-4.1` family, which leaves the API on 14 October 2026 — seven weeks of
 * shelf life, and nothing in the build would have said so. Worse, replacing
 * it means writing prices nobody here can check against the vendor's own
 * page, and this codebase's rule is that a wrong price is worse than a
 * missing one: a missing one refuses to boot, a wrong one becomes a margin
 * somebody acts on.
 *
 * So the price comes from whoever holds the invoice. That also happens to be
 * what makes an OpenAI-compatible endpoint usable at all — DeepSeek weights
 * on a US host, Groq, Together, OpenRouter — because a provider we have never
 * heard of cannot have a price compiled into us.
 *
 * Format, micro-USD per million tokens, keyed by model FAMILY:
 *
 *   AI_MODEL_PRICES='{"gpt-5-mini":{"in":250000,"out":2000000,"cacheRead":25000}}'
 *
 * `in` and `out` are required. `cacheWrite` defaults to `in` and `cacheRead`
 * to a tenth of it, which is the shape of every published cache price we have
 * seen; name them explicitly when a provider differs.
 */
interface PriceInput {
  in: number;
  out: number;
  cacheWrite?: number;
  cacheRead?: number;
}

export class BadModelPrices extends Error {}

/**
 * Read the configured prices, refusing anything malformed.
 *
 * Throws rather than skipping: a price that failed to parse and was ignored
 * is exactly a silently-free model, which is the outcome the whole file
 * exists to prevent.
 */
export function parseModelPrices(raw: string | undefined): Record<string, PriceInput> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadModelPrices('AI_MODEL_PRICES is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadModelPrices('AI_MODEL_PRICES must be an object keyed by model family');
  }

  const prices: Record<string, PriceInput> = {};
  for (const [family, value] of Object.entries(parsed as Record<string, unknown>)) {
    const price = value as Partial<PriceInput>;
    if (!isPositive(price?.in) || !isPositive(price?.out)) {
      throw new BadModelPrices(`AI_MODEL_PRICES["${family}"] needs positive "in" and "out"`);
    }
    prices[family] = {
      in: price.in,
      out: price.out,
      ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite }),
      ...(price.cacheRead === undefined ? {} : { cacheRead: price.cacheRead }),
    };
  }
  return prices;
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Register them, longest family first.
 *
 * `modelFamily` matches the first family whose name the model id CONTAINS, so
 * a shorter name that is a prefix of a longer one would swallow it: register
 * `gpt-5` before `gpt-5-mini` and every mini call is costed as a full one,
 * silently and in the expensive direction. Sorting by length descending makes
 * that structural rather than a property of key order in someone's env var.
 */
export function registerRuntimeModelPrices(raw: string | undefined): void {
  const prices = parseModelPrices(raw);
  for (const family of Object.keys(prices).sort((a, b) => b.length - a.length)) {
    const price = prices[family]!;
    registerModelPrice(family, {
      inputMicrosPerMTok: price.in,
      outputMicrosPerMTok: price.out,
      cacheWriteMicrosPerMTok: price.cacheWrite ?? price.in,
      cacheReadMicrosPerMTok: price.cacheRead ?? Math.round(price.in / 10),
    });
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
      `no price is registered for AI model "${model}". Supply one in ` +
        `AI_MODEL_PRICES, e.g. {"${model}":{"in":250000,"out":2000000}} in ` +
        'micro-USD per million tokens, or every call is recorded as free.',
    );
  }
  new Logger('ModelPrices').log(`costing "${model}" as family "${modelFamily(model)}"`);
}
