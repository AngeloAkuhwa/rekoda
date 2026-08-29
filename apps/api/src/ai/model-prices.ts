import { Logger } from '@nestjs/common';
import {
  hasTranscriptionPrice,
  modelFamily,
  registerModelPrice,
  registerTranscriptionPrice,
} from '@rekoda/core';

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

/**
 * The same refusal, over every configured token role at once (ADR 0031 §4).
 *
 * The interpreter was the only model checked at boot, which was right when
 * it was the only model called. The classifier, vision and escalation roles
 * each spend provider money on their own id, and a role whose model has no
 * price is a role whose every call reports as free — so boot sweeps the
 * whole ensemble. The transcriber is deliberately NOT in this sweep: it is
 * priced per minute of audio, not per token, and its price is validated by
 * the mechanism that owns duration pricing.
 */
export function assertRolesArePriced(models: readonly string[], hasApiKey: boolean): void {
  for (const model of new Set(models)) {
    assertModelIsPriced(model, hasApiKey);
  }
}

/**
 * The transcriber's price, priced per MINUTE rather than per token.
 *
 * Same discipline as `AI_MODEL_PRICES`, same reason it is configuration: the
 * per-minute rate belongs to whoever holds the invoice. Keyed by EXACT model
 * id:
 *
 *   AI_TRANSCRIPTION_PRICES='{"whisper-1":{"perMinuteMicros":6000}}'
 *
 * 6_000 micro-USD is $0.006 per minute of audio.
 */
export class BadTranscriptionPrices extends Error {}

export function parseTranscriptionPrices(
  raw: string | undefined,
): Record<string, { perMinuteMicros: number }> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadTranscriptionPrices('AI_TRANSCRIPTION_PRICES is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadTranscriptionPrices('AI_TRANSCRIPTION_PRICES must be an object keyed by model id');
  }

  const prices: Record<string, { perMinuteMicros: number }> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    const price = value as { perMinuteMicros?: unknown };
    if (!isPositive(price?.perMinuteMicros)) {
      throw new BadTranscriptionPrices(
        `AI_TRANSCRIPTION_PRICES["${model}"] needs a positive "perMinuteMicros"`,
      );
    }
    prices[model] = { perMinuteMicros: price.perMinuteMicros };
  }
  return prices;
}

export function registerRuntimeTranscriptionPrices(raw: string | undefined): void {
  for (const [model, price] of Object.entries(parseTranscriptionPrices(raw))) {
    registerTranscriptionPrice(model, price);
  }
}

/**
 * Refuse to boot a hosted transcriber we cannot cost.
 *
 * Only when hosted transcription is actually the active configuration: the
 * sidecar spends no provider money per call, and a deployment with no
 * transcriber at all makes no transcriptions to misprice. This is the
 * per-minute twin of `assertModelIsPriced`, and exists so the exemption in
 * `assertRolesArePriced` is a relocation of the check, never a hole in it.
 */
export function assertTranscriberIsPriced(model: string, hostedSttActive: boolean): void {
  if (!hostedSttActive) return;
  if (!hasTranscriptionPrice(model)) {
    throw new UnpricedModel(
      `no per-minute price is registered for transcription model "${model}". Supply one in ` +
        `AI_TRANSCRIPTION_PRICES, e.g. {"${model}":{"perMinuteMicros":6000}} in ` +
        'micro-USD per minute, or every transcription is recorded as free.',
    );
  }
  new Logger('ModelPrices').log(`costing transcriber "${model}" per minute`);
}
