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
 * Keyed by model FAMILY rather than by the exact id, because `AI_MODEL_*` is
 * configured with aliases like `claude-sonnet-latest` that point at whatever
 * the current snapshot is. Pricing follows the family; the alias moves.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // $2 / $10 per MTok. The runtime default (ADR 0007).
  sonnet: {
    inputMicrosPerMTok: 2_000_000,
    outputMicrosPerMTok: 10_000_000,
    cacheWriteMicrosPerMTok: 2_500_000, // 1.25× input
    cacheReadMicrosPerMTok: 200_000, // 0.10× input
  },
  // $1 / $5 per MTok. Trivial classification.
  haiku: {
    inputMicrosPerMTok: 1_000_000,
    outputMicrosPerMTok: 5_000_000,
    cacheWriteMicrosPerMTok: 1_250_000,
    cacheReadMicrosPerMTok: 100_000,
  },
  // $10 / $50 per MTok. Build-time and evals; escalation flag only.
  fable: {
    inputMicrosPerMTok: 10_000_000,
    outputMicrosPerMTok: 50_000_000,
    cacheWriteMicrosPerMTok: 12_500_000,
    cacheReadMicrosPerMTok: 1_000_000,
  },
};

/** The family a model id belongs to, or null if we do not price it. */
export function modelFamily(modelId: string): string | null {
  const id = modelId.toLowerCase();
  for (const family of Object.keys(MODEL_PRICES)) {
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
  const price = family ? MODEL_PRICES[family] : undefined;
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

/** `YYYY-MM` for the `billing_period` column. */
export function billingPeriod(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
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
  const price = family ? MODEL_PRICES[family] : undefined;
  if (!price || tokens <= 0) return 0;
  const full = microsFor(tokens, price.inputMicrosPerMTok);
  const cached = microsFor(tokens, price.cacheReadMicrosPerMTok);
  return full === 0 ? 0 : (full - cached) / full;
}
