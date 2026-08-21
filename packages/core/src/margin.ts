/**
 * What a merchant earns Rekoda, against what they cost it to serve.
 *
 * `usage_events` has costed every WhatsApp message, model call and generated
 * document since metering shipped, in kobo, at the FX captured when the row
 * was written. Nothing read it, so the one number that decides whether the
 * pricing model survives contact with real merchants was being recorded and
 * never looked at.
 *
 * Integers throughout, in kobo, like everything else that touches money here.
 * The ratio is basis points rather than a float for the same reason: a
 * percentage that has been through binary floating point is a percentage that
 * can disagree with itself between two screens.
 */
import { planPriceK } from './allowances.js';

export interface MarginInput {
  /** The plan the business is on today, whatever it was during the period. */
  plan: string;
  /** Provider cost for the period, in kobo, summed from `usage_events`. */
  costK: number;
}

export interface Margin {
  /** Subscription only. Add-on packs are not recorded anywhere yet. */
  revenueK: number;
  costK: number;
  /** Negative means this merchant costs more to serve than they pay. */
  marginK: number;
  /**
   * Cost as a share of revenue, in basis points (10,000 = all of it).
   *
   * Null when revenue is zero, which is every trial. A trial's cost ratio is
   * not "infinite" or "100%" — it is undefined, and saying so is better than
   * printing a number an operator might average.
   */
  costRatioBp: number | null;
}

export function margin(input: MarginInput): Margin {
  const revenueK = planPriceK(input.plan);
  const costK = Math.max(0, Math.round(input.costK));
  return {
    revenueK,
    costK,
    marginK: revenueK - costK,
    costRatioBp: revenueK > 0 ? Math.round((costK * 10_000) / revenueK) : null,
  };
}

/**
 * The same arithmetic over a whole cohort, from parts that were counted
 * rather than listed.
 *
 * Revenue comes from a plan census (how many businesses sit on each plan)
 * and cost from a single summed total, because both are exact over the whole
 * estate. Adding up a page of rows would give a number that looked right and
 * quietly shrank the day there were more merchants than the page holds.
 *
 * Trials contribute their cost and no revenue, which is the truthful shape:
 * they are the acquisition spend, and netting them out would flatter it.
 */
export interface PlanCount {
  plan: string;
  businesses: number;
}

export function estateMargin(census: readonly PlanCount[], costK: number): Margin {
  const revenueK = census.reduce((sum, row) => sum + planPriceK(row.plan) * row.businesses, 0);
  const cost = Math.max(0, Math.round(costK));
  return {
    revenueK,
    costK: cost,
    marginK: revenueK - cost,
    costRatioBp: revenueK > 0 ? Math.round((cost * 10_000) / revenueK) : null,
  };
}

/** How many of the counted businesses are on a plan that earns anything. */
export function payingCount(census: readonly PlanCount[]): number {
  return census.reduce((sum, row) => sum + (planPriceK(row.plan) > 0 ? row.businesses : 0), 0);
}

/** Every business counted, whatever plan they are on. */
export function estateCount(census: readonly PlanCount[]): number {
  return census.reduce((sum, row) => sum + row.businesses, 0);
}
