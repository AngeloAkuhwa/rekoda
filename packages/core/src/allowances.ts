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

export type PlanId = 'trial' | 'chat' | 'integrate' | 'complete';

export const PLAN_ALLOWANCES: Record<PlanId, Record<UsageUnit, number>> = {
  trial: { messages: 50, voice_seconds: 600, documents: 25, documents_understood: 10, orders: 0 },
  chat: {
    messages: 400,
    voice_seconds: 3_600,
    documents: 100,
    documents_understood: 50,
    orders: 0,
  },
  integrate: {
    messages: 800,
    voice_seconds: 0,
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
