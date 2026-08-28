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
import {
  addOnPack,
  allowanceFor,
  isConsumable,
  packsFor,
  planPriceK,
  seatsFor,
  UNIT_KIND,
  UNIT_SCALE,
  type AddOnPack,
  type UsageUnit,
} from '@rekoda/core';
import { addOnsRepo, planCatalogueRepo, type TenantDb } from '@rekoda/db';

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
  if (!isConsumable(unit)) {
    throw new Error(`${unit} is ${UNIT_KIND[unit]}, not a monthly allowance: use standingCapacity`);
  }
  const sold = config.planCatalogueReads
    ? (await planCatalogueRepo.soldAllowanceFor(tx, businessId, plan, unit, now)) * UNIT_SCALE[unit]
    : allowanceFor(plan, unit);

  /*
   * Plus what a held add-on grants every month (PR-116).
   *
   * Distinct from a pack, which credits `bonus` into one month and is gone:
   * a MONTHLY_UNITS grant belongs to a recurring subscription, so it arrives
   * every month for as long as the holding lasts and stops when it ends.
   * That difference is why the Developer API Starter's twenty-five thousand
   * requests are a grant and not a pack: a merchant paying monthly should
   * not have to re-buy the thing they are already paying for.
   */
  const granted = await addOnsRepo.grantedUnits(tx, businessId, 'MONTHLY_UNITS', unit, now);
  return sold + granted * UNIT_SCALE[unit];
}

/**
 * The standing ceiling for a CAPACITY unit: seats, connections, API
 * applications (owner ruling, 28 August 2026; `UNIT_KIND` in core).
 *
 * Deliberately its own function rather than a flag on `meterAllowance`,
 * because the two answer different questions and one signature for both is
 * how a held thing ends up back in the monthly meter. Nothing here consults
 * `usage_counters`: a capacity ceiling is compared against how many
 * currently EXIST, which the caller counts.
 *
 * The answer is in WHOLE things, not meter counts, because a capacity unit
 * is always counted one for one: half an accountant is not a quantity.
 *
 * Each function refuses the other's units rather than quietly answering.
 * A silent answer is how the confusion returns: `meterAllowance` on
 * `API_APPLICATIONS` would give a number the meter would then happily
 * decrement, which is precisely the PR-113 bug.
 */
export async function standingCapacity(
  config: PlanTermsConfig,
  tx: TenantDb,
  businessId: string,
  plan: string,
  unit: UsageUnit,
  now = new Date(),
): Promise<number> {
  if (isConsumable(unit)) {
    throw new Error(`${unit} is CONSUMABLE_MONTHLY, not capacity: use meterAllowance`);
  }
  const sold = config.planCatalogueReads
    ? await planCatalogueRepo.soldAllowanceFor(tx, businessId, plan, unit, now)
    : allowanceFor(plan, unit);
  const granted = await addOnsRepo.grantedUnits(tx, businessId, 'CAPACITY', unit, now);
  return sold + granted;
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

/* ── usage packs (PR-101) ─────────────────────────────────────────────── */

/** A catalogue pack in the shape the page and the charge already speak:
 * quantity in METER counts (seconds of voice), price in kobo. */
function toCorePack(pack: {
  packId: string;
  label: string;
  unit: UsageUnit;
  quantity: number;
  priceMinor: number;
}): AddOnPack {
  return {
    id: pack.packId,
    label: pack.label,
    unit: pack.unit,
    quantity: pack.quantity * UNIT_SCALE[pack.unit],
    priceK: pack.priceMinor,
  };
}

/**
 * Which packs THIS business may buy, priced as offered today.
 *
 * The data path derives eligibility instead of keeping a matrix: a pack is
 * buyable exactly when the merchant's plan VERSION sells a nonzero
 * allowance of its unit, on a paid plan. A pack is overage by definition,
 * and overage on capacity the gate refuses is capacity the product cannot
 * spend - the same correction the 26 Aug owner decision made to the plan
 * table, applied to the packs that ride it. (The constant path keeps the
 * old matrix, which still offered Chat-side packs to Integrate.)
 */
export async function packsForBusiness(
  config: PlanTermsConfig,
  tx: TenantDb,
  businessId: string,
  plan: string,
  now = new Date(),
): Promise<AddOnPack[]> {
  if (!config.planCatalogueReads) return packsFor(plan);
  const terms = await planCatalogueRepo.commercialTermsFor(tx, businessId, plan, now);
  if (!terms.version || terms.monthlyPriceK === 0) return [];
  const packs = await planCatalogueRepo.usagePacksAt(tx, now);
  /* Consumables only: a pack credits one month's bonus, which cannot
   * express standing capacity (owner ruling, 28 Aug 2026). Migration 0112
   * refuses a capacity pack in the catalogue; this keeps the reader honest
   * about rows written before it. */
  return packs
    .filter((pack) => isConsumable(pack.unit) && (terms.allowances[pack.unit] ?? 0) > 0)
    .map(toCorePack);
}

/** One pack as offered at `at`, whoever is asking. Null for an unknown id. */
export async function packOffer(
  config: PlanTermsConfig,
  tx: TenantDb,
  packId: string,
  at = new Date(),
): Promise<AddOnPack | null> {
  if (!config.planCatalogueReads) return addOnPack(packId);
  const pack = await planCatalogueRepo.usagePackAt(tx, packId, at);
  return pack ? toCorePack(pack) : null;
}
