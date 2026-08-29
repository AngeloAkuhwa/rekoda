/**
 * What a model call cost (MASTER-PLAN §5.3.3, pricing-model.md
 * §"Cost telemetry is a build item").
 *
 * Pure arithmetic over integers. Prices are held in **micro-USD per million
 * tokens** rather than dollars-per-MTok floats, because the whole point of
 * this file is to feed a margin view six weeks after launch, and a margin
 * computed from accumulated float error is a margin nobody can act on.
 *
 * Everything downstream is integers too: USD micros on the way in, kobo on
 * the way out, same as the ledger.
 */

/** Token counts as Anthropic reports them. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache. Billed at a premium, once. */
  cacheWriteTokens?: number;
  /** Tokens served from the cache. The reason caching is worth doing. */
  cacheReadTokens?: number;
}

export interface ModelPrice {
  /** micro-USD per 1,000,000 input tokens. */
  readonly inputMicrosPerMTok: number;
  readonly outputMicrosPerMTok: number;
  /** Cache writes cost more than input; cache reads cost far less. */
  readonly cacheWriteMicrosPerMTok: number;
  readonly cacheReadMicrosPerMTok: number;
}

/**
 * Published list prices (pricing-model.md §"Unit costs").
 *
 * Keyed by model FAMILY rather than by exact id, because a family's price is
 * the stable thing: ids gain suffixes and tiers gain members, but every
 * `claude-haiku-*` bills at the haiku rate. Configuration names an exact id
 * (see config.ts) and this table costs whichever family it belongs to.
 *
 * ALWAYS THE PERMANENT LIST RATE, never a promotional one. Introductory
 * pricing expires on a date nobody will remember, and a margin view that
 * quietly flatters the morning it lapses is worse than one that was
 * pessimistic all along. When a promotional rate BECOMES the list rate (as
 * Sonnet 5's did), the table follows the vendor's page, dated in the family
 * comment.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  /**
   * $2 / $10 per MTok — Sonnet 5's PERMANENT list price.
   *
   * An earlier revision of this table held $3 / $15 with a note that $2/$10
   * was introductory and would lapse on 1 September 2026. Anthropic made
   * $2/$10 the standing Sonnet 5 rate, so the caution is now just a 50%
   * overstatement of every vision and interpreter call. Rows already written
   * keep the cost that was recorded when they were written — this table
   * prices FUTURE calls, never rewrites history.
   *
   * The interpreter default (ADR 0031, accuracy-first) and the vision
   * reader.
   */
  sonnet: {
    inputMicrosPerMTok: 2_000_000,
    outputMicrosPerMTok: 10_000_000,
    cacheWriteMicrosPerMTok: 2_500_000, // 1.25× input (5-minute cache)
    cacheReadMicrosPerMTok: 200_000, // 0.10× input
  },
  // $1 / $5 per MTok. The classifier (ADR 0031 moved the interpreter to Sonnet).
  haiku: {
    inputMicrosPerMTok: 1_000_000,
    outputMicrosPerMTok: 5_000_000,
    cacheWriteMicrosPerMTok: 1_250_000,
    cacheReadMicrosPerMTok: 100_000,
  },
  // $5 / $25 per MTok. The escalation model, never a default.
  opus: {
    inputMicrosPerMTok: 5_000_000,
    outputMicrosPerMTok: 25_000_000,
    cacheWriteMicrosPerMTok: 6_250_000,
    cacheReadMicrosPerMTok: 500_000,
  },
  // $10 / $50 per MTok. Build-time and evals; escalation flag only.
  fable: {
    inputMicrosPerMTok: 10_000_000,
    outputMicrosPerMTok: 50_000_000,
    cacheWriteMicrosPerMTok: 12_500_000,
    cacheReadMicrosPerMTok: 1_000_000,
  },
};

/**
 * Extra prices supplied at runtime, keyed by family.
 *
 * Exists because this file must not invent a price it is not sure of. A wrong
 * price is worse than a missing one: `priced: false` shows up in the margin
 * view as a gap somebody investigates, while a wrong number shows up as a
 * margin somebody acts on.
 *
 * OpenAI families are deliberately absent from `MODEL_PRICES` for that reason
 * — supply them here from the current price list when you switch providers.
 */
const runtimePrices = new Map<string, ModelPrice>();

export function registerModelPrice(family: string, price: ModelPrice): void {
  runtimePrices.set(family.toLowerCase(), price);
}

function priceFor(family: string): ModelPrice | undefined {
  return MODEL_PRICES[family] ?? runtimePrices.get(family);
}

/** The family a model id belongs to, or null if we do not price it. */
export function modelFamily(modelId: string): string | null {
  const id = modelId.toLowerCase();
  for (const family of [...Object.keys(MODEL_PRICES), ...runtimePrices.keys()]) {
    if (id.includes(family)) return family;
  }
  return null;
}

export interface CallCost {
  /** Provider cost in USD micros. */
  readonly usdMicros: number;
  /** Naira equivalent in kobo, at the planning FX supplied by the caller. */
  readonly nairaKobo: number;
  /**
   * False when we have no price for this model.
   *
   * The cost is then zero — but a zero that says so. Silently recording an
   * unpriced model as free is the one outcome this file exists to prevent:
   * it would not look like a bug, it would look like good margin.
   */
  readonly priced: boolean;
}

function microsFor(tokens: number, microsPerMTok: number): number {
  return Math.round((Math.max(0, tokens) * microsPerMTok) / 1_000_000);
}

/**
 * Cost one model call.
 *
 * `fxNairaPerUsd` is passed in rather than read from the environment so the
 * rate that was in force when the row was written is the rate the row records.
 * Re-deriving it later from today's FX would silently rewrite history.
 */
export function costOfCall(modelId: string, usage: TokenUsage, fxNairaPerUsd: number): CallCost {
  const family = modelFamily(modelId);
  const price = family ? priceFor(family) : undefined;
  if (!price) return { usdMicros: 0, nairaKobo: 0, priced: false };

  const usdMicros =
    microsFor(usage.inputTokens, price.inputMicrosPerMTok) +
    microsFor(usage.outputTokens, price.outputMicrosPerMTok) +
    microsFor(usage.cacheWriteTokens ?? 0, price.cacheWriteMicrosPerMTok) +
    microsFor(usage.cacheReadTokens ?? 0, price.cacheReadMicrosPerMTok);

  // USD micros → naira → kobo. 1 USD micro = fx/1e6 naira = fx/1e4 kobo.
  const nairaKobo = Math.round((usdMicros * fxNairaPerUsd) / 10_000);
  return { usdMicros, nairaKobo, priced: true };
}

/**
 * `YYYY-MM` for the `billing_period` column — the SAME Lagos month the usage
 * meter counts in (`usagePeriod`).
 *
 * These were UTC and the meter was Lagos, so for the hour before midnight UTC
 * on the last day of a month the cost row and the counter it explains landed
 * in different months. A margin view that can never exactly tie to the meter
 * is a margin view nobody trusts.
 */
export function billingPeriod(at: Date): string {
  return new Date(at.getTime() + 3_600_000).toISOString().slice(0, 7);
}

/**
 * What a cached prompt saves, as a fraction.
 *
 * Exists to be asserted on: prompt caching is only worth its complexity if the
 * saving is real, and "real" should be a number in a test rather than a claim
 * in a comment.
 */
export function cacheSaving(modelId: string, tokens: number): number {
  const family = modelFamily(modelId);
  const price = family ? priceFor(family) : undefined;
  if (!price || tokens <= 0) return 0;
  const full = microsFor(tokens, price.inputMicrosPerMTok);
  const cached = microsFor(tokens, price.cacheReadMicrosPerMTok);
  return full === 0 ? 0 : (full - cached) / full;
}
