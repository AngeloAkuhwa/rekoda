/**
 * What a plan grants (canonical spec §3, §4.1).
 *
 * Pure, and deliberately here rather than beside the meter. An allowance says
 * how many more this month; an entitlement says whether the capability exists
 * for this business at all. Conflating them is what the repository did before
 * PR-012: Integrate was "gated" by an orders allowance of zero, which only
 * works for capabilities that happen to be counted and puts a permission in a
 * table about volume.
 */
import type { PlanId } from './allowances.js';

/**
 * Complete is the PAIR, never a value (spec §3.3). A `REKODA_COMPLETE` key
 * would make it possible to hold Complete while holding neither half.
 */
export const ENTITLEMENT_KEYS = ['REKODA_CHAT', 'REKODA_INTEGRATE', 'REKODA_API'] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

/**
 * The plan-to-entitlement map.
 *
 * `integrate` holds REKODA_INTEGRATE and NOT REKODA_CHAT, because Complete is
 * the pair and a plan that already held both would leave Complete selling
 * nothing but volume. Owner decision, 26 Aug 2026, taken against the
 * alternative reading that the repository's allowance table implied.
 *
 * The consequence is deliberate and was accepted with the decision: an
 * Integrate merchant does not have merchant-side Chat. Their messaging, voice
 * and document-understanding allowances go to zero in the same change, so the
 * pricing page cannot promise capacity the gate refuses.
 *
 * `trial` holds both: a trialist who never tastes automatic order capture
 * never learns why Integrate is worth paying for.
 *
 * `expired` holds nothing. A lapsed business keeps its books readable and
 * grows nothing (spec §4.5).
 *
 * REKODA_API is in no plan. It is a separate commercial entitlement (spec
 * §27) and is granted explicitly, never derived.
 */
export const PLAN_ENTITLEMENTS: Record<PlanId, readonly EntitlementKey[]> = {
  trial: ['REKODA_CHAT', 'REKODA_INTEGRATE'],
  expired: [],
  chat: ['REKODA_CHAT'],
  integrate: ['REKODA_INTEGRATE'],
  complete: ['REKODA_CHAT', 'REKODA_INTEGRATE'],
};

/** An unknown plan grants nothing. The safe direction is stingy. */
export function entitlementsForPlan(plan: string): readonly EntitlementKey[] {
  return PLAN_ENTITLEMENTS[plan as PlanId] ?? [];
}

/**
 * The effective set: what the plan implies, plus anything granted explicitly.
 *
 * A union rather than an override, because the two answer different
 * questions. The plan says what was bought; a grant says what somebody
 * decided this business should also have. Neither can take away what the
 * other gave, and a support-issued entitlement therefore survives a renewal.
 */
export function effectiveEntitlements(
  plan: string,
  explicitGrants: readonly EntitlementKey[],
): EntitlementKey[] {
  const held = new Set<EntitlementKey>(entitlementsForPlan(plan));
  for (const grant of explicitGrants) held.add(grant);
  return [...held].sort();
}
