/**
 * The one seam between "what plan is this business on" and "what does that
 * plan sell" (BL2, PR-100).
 *
 * Every commercial figure the application enforces - a unit allowance at the
 * metering gate, the seat limit at the invite endpoint, the price a renewal
 * charges - resolves through here, and nowhere else. On the data path
 * (`planCatalogueReads`, the default) the answer comes from the plan
 * catalogue through the grandfathering pin, so a merchant pinned to the
 * version they were sold is metered and billed by THAT version after the
 * catalogue moves on. The constant path is the pre-BL2 behaviour, retained
 * verbatim as the rollback (build plan §10 step D: old path retained), and
 * deleted only in the cleanup step.
 *
 * Callers pass the EFFECTIVE plan from `planFor`, exactly as they always
 * passed it to the constants: a lapsed trial arrives as `expired`, and the
 * stale-pin rule in the repo keeps an expired business's old pin from
 * answering.
 */
import { allowanceFor, planPriceK, seatsFor, UNIT_SCALE, type UsageUnit } from '@rekoda/core';
import { planCatalogueRepo, type TenantDb } from '@rekoda/db';

/** The one config fact this seam needs; keeps the functions testable bare. */
export interface PlanTermsConfig {
  planCatalogueReads: boolean;
}

/**
 * One unit's allowance in the counts the meter stores (seconds of voice,
 * not minutes) - the drop-in replacement for `allowanceFor` at every
 * consume site. `UNIT_SCALE` stays in code on both paths: how a unit is
 * counted is a counting rule, not a commercial decision.
 */
export async function meterAllowance(
  config: PlanTermsConfig,
  tx: TenantDb,
  businessId: string,
  plan: string,
  unit: UsageUnit,
  now = new Date(),
): Promise<number> {
  if (!config.planCatalogueReads) return allowanceFor(plan, unit);
  const sold = await planCatalogueRepo.soldAllowanceFor(tx, businessId, plan, unit, now);
  return sold * UNIT_SCALE[unit];
}

/** Team seats beyond the owner, for the invite gate. */
export async function seatLimit(
  config: PlanTermsConfig,
  tx: TenantDb,
  businessId: string,
  plan: string,
  now = new Date(),
): Promise<number> {
  if (!config.planCatalogueReads) return seatsFor(plan);
  const version = await planCatalogueRepo.versionForBusiness(tx, businessId, plan, now);
  return version?.seats ?? 0;
}

/**
 * What this business's plan costs per month, in kobo - the figure a renewal
 * charges and the billing page shows. On the data path this is the PINNED
 * version's price, which is the whole point: a launch merchant renews at
 * launch pricing after a repricing, because their pin still points at the
 * version whose price row never changed.
 */
export async function planPriceKFor(
  config: PlanTermsConfig,
  tx: TenantDb,
  businessId: string,
  plan: string,
  now = new Date(),
): Promise<number> {
  if (!config.planCatalogueReads) return planPriceK(plan);
  const version = await planCatalogueRepo.versionForBusiness(tx, businessId, plan, now);
  if (!version) return 0;
  return (await planCatalogueRepo.priceAt(tx, version.id, 'NGN', 'monthly', now)) ?? 0;
}

/**
 * Every unit's allowance at once, in meter counts, for the billing overview.
 * One resolution and one allowance read instead of seventeen.
 */
export async function meterAllowances(
  config: PlanTermsConfig,
  tx: TenantDb,
  businessId: string,
  plan: string,
  now = new Date(),
): Promise<Record<UsageUnit, number>> {
  if (!config.planCatalogueReads) {
    return Object.fromEntries(
      Object.keys(UNIT_SCALE).map((unit) => [unit, allowanceFor(plan, unit as UsageUnit)]),
    ) as Record<UsageUnit, number>;
  }
  const terms = await planCatalogueRepo.commercialTermsFor(tx, businessId, plan, now);
  return Object.fromEntries(
    Object.entries(UNIT_SCALE).map(([unit, scale]) => [
      unit,
      (terms.allowances[unit as UsageUnit] ?? 0) * scale,
    ]),
  ) as Record<UsageUnit, number>;
}
