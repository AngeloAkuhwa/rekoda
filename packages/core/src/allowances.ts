/**
 * Plan allowances (docs/metering-v1.md) — the numbers the meter enforces.
 *
 * One authoritative table, in core, so the pricing page and the enforcement
 * gate can never quote different figures. Merchants see these units; they
 * never see tokens (pricing-model commercial rule 3). Router-served turns
 * are free by design and no unit exists for them.
 */

export const USAGE_UNITS = [
  'messages',
  'voice_seconds',
  'documents',
  'documents_understood',
  'orders',
] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

/**
 * `expired` is not sold — it is where a trial lands when its 30 days are up.
 * Modelling it as a plan rather than a flag means the gate needs no new
 * branch: every allowance is zero, so the atomic consume refuses the first
 * unit exactly as it refuses the 51st.
 */
export type PlanId = 'trial' | 'expired' | 'chat' | 'integrate' | 'complete';

/** A trial is 30 days from the day the business was created. */
export const TRIAL_DAYS = 30;

/** When a trial started at this moment runs out. */
export function trialExpiry(startedAt: Date): Date {
  return new Date(startedAt.getTime() + TRIAL_DAYS * 86_400_000);
}

export const PLAN_ALLOWANCES: Record<PlanId, Record<UsageUnit, number>> = {
  trial: { messages: 50, voice_seconds: 600, documents: 25, documents_understood: 10, orders: 0 },
  expired: {
    messages: 0,
    voice_seconds: 0,
    documents: 0,
    documents_understood: 0,
    orders: 0,
  },
  chat: {
    messages: 400,
    voice_seconds: 3_600,
    documents: 100,
    documents_understood: 50,
    orders: 0,
  },
  integrate: {
    messages: 800,
    /* The same hour Chat carries. Zero here made the ladder walk BACKWARDS:
     * a Chat merchant who opened a shop upgraded, paid more, and lost their
     * voice notes — the only place a bigger plan took something away. */
    voice_seconds: 3_600,
    documents: 500,
    documents_understood: 100,
    orders: 300,
  },
  complete: {
    messages: 1_200,
    voice_seconds: 7_200,
    documents: 750,
    documents_understood: 200,
    orders: 300,
  },
};

/** An unknown plan gets the TRIAL allowance: the safe direction is stingy. */
export function allowanceFor(plan: string, unit: UsageUnit): number {
  const known = (PLAN_ALLOWANCES as Record<string, Record<UsageUnit, number>>)[plan];
  return known ? known[unit] : PLAN_ALLOWANCES.trial[unit];
}

/**
 * The billing month, as merchants experience it: a calendar month in
 * Africa/Lagos. Lagos is fixed UTC+1 with no daylight saving, so the shift
 * is arithmetic, not a timezone database.
 */
export function usagePeriod(at: Date): string {
  return new Date(at.getTime() + 3_600_000).toISOString().slice(0, 7);
}

/**
 * The billing month before this one.
 *
 * Arithmetic on the label rather than on a Date, so December rolls back to
 * November of the previous year without anybody reasoning about it, and
 * `2026-01` gives `2025-12` rather than a month that does not exist.
 */
export function periodBefore(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 2, 1)).toISOString().slice(0, 7);
}

/**
 * What each plan costs, in kobo (docs/pricing-model.md).
 *
 * These lived only in prose — the pricing page, the marketing copy and this
 * repository's own ADRs each carried a figure typed by hand, and one of them
 * was wrong for a day. A plan price is arithmetic input: the margin view
 * divides by it, and self-service billing (M4) will charge it. It belongs
 * beside the allowances it buys.
 *
 * `trial` and `expired` are zero because nobody is billed for either. That is
 * not a placeholder: a trial genuinely earns nothing, and the margin view
 * should show it as the cost centre it is rather than hiding it.
 */
export const PLAN_PRICES_K: Record<PlanId, number> = {
  trial: 0,
  expired: 0,
  chat: 990_000,
  integrate: 1_990_000,
  complete: 2_990_000,
};

/** An unknown plan earns nothing, which is the safe direction for a margin. */
export function planPriceK(plan: string): number {
  return (PLAN_PRICES_K as Record<string, number>)[plan] ?? 0;
}
