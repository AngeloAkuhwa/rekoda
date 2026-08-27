/**
 * Dynamic FX (spec §16, Appendix A) — the vocabulary and the one pure
 * decision, kept apart from any provider so the rules are testable before a
 * single adapter exists.
 *
 * Four FX concepts are kept distinct and never shared (§16): what the books
 * used at the transaction date (accounting FX — this file), what a provider
 * actually converted at, what Rekoda's own costs converted at, and what a
 * price list is denominated in.
 */

export const RATE_SOURCES = ['PROVIDER', 'MANUAL_OVERRIDE', 'INHERITED'] as const;
export type RateSource = (typeof RATE_SOURCES)[number];

/** A.1: immutable once written; the rate at full provider precision. */
export interface ExchangeRateSnapshot {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  /** Full provider precision, never rounded — carried as a decimal string. */
  rate: string;
  /** The moment the rate APPLIES TO, not fetch time. */
  effectiveAt: Date;
  fetchedAt: Date;
  source: RateSource;
  providerName: string;
  providerReference?: string;
  /** Required for MANUAL_OVERRIDE: an override is a human decision. */
  actorId?: string;
  reason?: string;
}

/**
 * A.1's port, provider-neutral like every other port. Adapters arrive with
 * the first consumer that has a configured source; the port exists so that
 * consumer is written against the seam rather than against a vendor.
 */
export interface ExchangeRateProvider {
  rateFor(
    base: string,
    quote: string,
    at: Date,
  ): Promise<Omit<ExchangeRateSnapshot, 'id'> | 'unavailable'>;
}

/** A.2: the resolver answers with a named state, never a bare rate or null. */
export type RateResolution =
  | { state: 'RATE_AVAILABLE'; snapshot: ExchangeRateSnapshot }
  | { state: 'RATE_STALE'; snapshot: ExchangeRateSnapshot; distanceMs: number }
  | { state: 'RATE_UNAVAILABLE' }
  | { state: 'MANUAL_OVERRIDE_REQUIRED' };

/**
 * Choose among cached snapshots for a requested ACCOUNTING timestamp.
 *
 * Staleness is measured against the requested accounting timestamp, never
 * against today's date (A.2): a transaction dated 15 June asks for a
 * 15 June rate, and that rate is fresh for that request in August, in
 * December, and in five years. Measuring against wall-clock time would
 * make every historical import impossible the moment it aged past the
 * window — the opposite of what the rule is for.
 *
 * And the inverse guard, which is the one that actually catches the bug:
 * because distance is |effectiveAt − requestedAt|, TODAY's rate is exactly
 * as far from a historical request as its age — a current rate can never
 * silently satisfy a historical transaction. That silent fallback "always
 * succeeds and always looks reasonable", which is why A.2 bans it.
 */
export function selectRate(
  candidates: readonly ExchangeRateSnapshot[],
  base: string,
  quote: string,
  requestedAt: Date,
  freshnessWindowMs: number,
): RateResolution {
  const pair = candidates.filter((s) => s.baseCurrency === base && s.quoteCurrency === quote);
  if (pair.length === 0) return { state: 'RATE_UNAVAILABLE' };

  let best = pair[0]!;
  let bestDistance = Math.abs(best.effectiveAt.getTime() - requestedAt.getTime());
  for (const candidate of pair.slice(1)) {
    const distance = Math.abs(candidate.effectiveAt.getTime() - requestedAt.getTime());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  if (bestDistance <= freshnessWindowMs) return { state: 'RATE_AVAILABLE', snapshot: best };
  /* A stale rate is refused, never guessed: the caller must not post. */
  return { state: 'RATE_STALE', snapshot: best, distanceMs: bestDistance };
}
