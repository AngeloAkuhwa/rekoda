/**
 * The plan catalogue (canonical spec §30, migration 0105). BL2's step A.
 *
 * Readers answer the three questions billing will ask: which version of a
 * plan is (or was) current, what that version costs in a currency over an
 * interval, and what it sells. Nothing in production calls them yet - the
 * PR-100 cutover moves the allowance and price readers here after proving
 * the data equals the constants.
 *
 * The catalogue is platform reference data, identical for every tenant, so
 * readers take a plain `Db` for the same reason the entitlements catalogue
 * does. The maintenance functions at the bottom only work on the owner
 * credential: both app roles hold SELECT only, which is what makes "a price
 * change does not alter a historical charge" a database property rather than
 * a code-review hope.
 */
import { sql } from 'drizzle-orm';
import type { EntitlementKey, UsageUnit } from '@rekoda/core';
import type { Db, TenantDb } from '../client.js';

export type BillingInterval = 'monthly' | 'annual';

export interface PlanVersion {
  id: string;
  planId: string;
  version: number;
  name: string;
  /** Team seats beyond the owner ("owner + N"). */
  seats: number;
  effectiveFrom: Date;
  /** Null means current. */
  effectiveTo: Date | null;
}

type VersionRow = {
  id: string;
  plan_id: string;
  version: number;
  name: string;
  seats: number;
  effective_from: string;
  effective_to: string | null;
};

const shapeVersion = (row: VersionRow): PlanVersion => ({
  id: row.id,
  planId: row.plan_id,
  version: row.version,
  name: row.name,
  seats: row.seats,
  effectiveFrom: new Date(row.effective_from),
  effectiveTo: row.effective_to ? new Date(row.effective_to) : null,
});

const VERSION_COLUMNS = sql`id, plan_id, version, name, seats, effective_from, effective_to`;

/**
 * The version of a plan in force at a moment.
 *
 * Historical by construction: asked with the date of an old charge it
 * answers the version that charge was sold under, however many versions have
 * been published since. Null when the moment predates the catalogue or the
 * plan id is unknown - the caller decides what stingy means for its
 * question, this function does not guess.
 */
export async function planVersionAt(db: Db, planId: string, at: Date): Promise<PlanVersion | null> {
  const rows = await db.execute<VersionRow>(sql`
    SELECT ${VERSION_COLUMNS} FROM plan_versions
    WHERE plan_id = ${planId}
      AND effective_from <= ${at.toISOString()}::timestamptz
      AND (effective_to IS NULL OR effective_to > ${at.toISOString()}::timestamptz)
    ORDER BY version DESC
    LIMIT 1
  `);
  const row = [...rows][0];
  return row ? shapeVersion(row) : null;
}

/** One version by id: what a grandfathering pin dereferences to. */
export async function planVersionById(db: Db, id: string): Promise<PlanVersion | null> {
  const rows = await db.execute<VersionRow>(sql`
    SELECT ${VERSION_COLUMNS} FROM plan_versions WHERE id = ${id}::uuid
  `);
  const row = [...rows][0];
  return row ? shapeVersion(row) : null;
}

/**
 * What a plan version cost at a moment, in minor units, or null when no
 * price was in force. Null and zero are different answers: zero is a stated
 * price (a trial), null is a currency or interval this version was never
 * sold in, and a biller that treated them alike would sell Complete for
 * nothing in a currency nobody priced.
 */
export async function priceAt(
  db: Db,
  planVersionId: string,
  currency: string,
  billingInterval: BillingInterval,
  at: Date,
): Promise<number | null> {
  const rows = await db.execute<{ amount_minor: string | number }>(sql`
    SELECT amount_minor FROM plan_prices
    WHERE plan_version_id = ${planVersionId}::uuid
      AND currency = ${currency}
      AND billing_interval = ${billingInterval}
      AND effective_from <= ${at.toISOString()}::timestamptz
      AND (effective_to IS NULL OR effective_to > ${at.toISOString()}::timestamptz)
    ORDER BY effective_from DESC
    LIMIT 1
  `);
  const row = [...rows][0];
  return row ? Number(row.amount_minor) : null;
}

/**
 * The allowance table for a version, in sold units. A unit absent from the
 * map is not sold on that version: zero, never unlimited.
 */
export async function allowancesOf(
  db: Db,
  planVersionId: string,
): Promise<Partial<Record<UsageUnit, number>>> {
  const rows = await db.execute<{ unit: string; allowance: number }>(sql`
    SELECT unit, allowance FROM allowance_versions
    WHERE plan_version_id = ${planVersionId}::uuid
    ORDER BY unit
  `);
  const sold: Partial<Record<UsageUnit, number>> = {};
  for (const row of rows) sold[row.unit as UsageUnit] = row.allowance;
  return sold;
}

/** What a version grants, sorted, against the PR-012 catalogue keys. */
export async function entitlementsOf(db: Db, planVersionId: string): Promise<EntitlementKey[]> {
  const rows = await db.execute<{ entitlement_key: string }>(sql`
    SELECT entitlement_key FROM plan_version_entitlements
    WHERE plan_version_id = ${planVersionId}::uuid
    ORDER BY entitlement_key
  `);
  return [...rows].map((row) => row.entitlement_key as EntitlementKey);
}

/** A business's grandfathering pin, or null when it floats on the current version. */
export async function pinnedPlanVersion(tx: TenantDb, businessId: string): Promise<string | null> {
  const rows = await tx.execute<{ plan_version_id: string | null }>(sql`
    SELECT plan_version_id FROM businesses WHERE id = ${businessId}::uuid
  `);
  return [...rows][0]?.plan_version_id ?? null;
}

/* ── catalogue maintenance ────────────────────────────────────────────────
 *
 * Owner-credential only: migrations, seed scripts and (later) an operator
 * surface. The app and worker roles meet 42501 here, by design. Nothing in
 * production calls these in PR-099 - they exist so the PR-100 cutover and
 * the tests that gate it can exercise versioning the way an operator will.
 */

export interface NewPlanVersion {
  planId: string;
  name: string;
  seats: number;
  effectiveFrom: Date;
  entitlements: readonly EntitlementKey[];
  /** Sold units. A unit left out is not sold: zero, never unlimited. */
  allowances: Partial<Record<UsageUnit, number>>;
  prices: readonly { currency: string; billingInterval: BillingInterval; amountMinor: number }[];
}

/**
 * Publish the next version of a plan: close the open version at the
 * successor's effective_from and append the successor with its entitlements,
 * allowances and prices, in one transaction.
 *
 * Append-only by shape. The predecessor keeps every row it ever had - its
 * allowances, its entitlements, its price history - so a business pinned to
 * it is billed and gated exactly as it was sold, which is the BL2 gate's
 * grandfathering requirement.
 */
export async function publishPlanVersion(db: Db, input: NewPlanVersion): Promise<string> {
  const from = input.effectiveFrom.toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE plan_versions SET effective_to = ${from}::timestamptz
      WHERE plan_id = ${input.planId} AND effective_to IS NULL
    `);
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO plan_versions (plan_id, version, name, seats, effective_from)
      SELECT ${input.planId},
             COALESCE(MAX(version), 0) + 1,
             ${input.name}, ${input.seats}, ${from}::timestamptz
      FROM plan_versions WHERE plan_id = ${input.planId}
      RETURNING id
    `);
    const id = [...rows][0]?.id;
    /* The INSERT..SELECT always returns one row; this is for the type. */
    if (!id) throw new Error('plan version insert returned no id');

    for (const key of input.entitlements) {
      await tx.execute(sql`
        INSERT INTO plan_version_entitlements (plan_version_id, entitlement_key)
        VALUES (${id}::uuid, ${key})
      `);
    }
    for (const [unit, allowance] of Object.entries(input.allowances)) {
      await tx.execute(sql`
        INSERT INTO allowance_versions (plan_version_id, unit, allowance)
        VALUES (${id}::uuid, ${unit}, ${allowance})
      `);
    }
    for (const price of input.prices) {
      await tx.execute(sql`
        INSERT INTO plan_prices
          (plan_version_id, currency, billing_interval, amount_minor, effective_from)
        VALUES (${id}::uuid, ${price.currency}, ${price.billingInterval},
                ${price.amountMinor}, ${from}::timestamptz)
      `);
    }
    return id;
  });
}

/**
 * Reprice a version without changing what it sells: close the open price row
 * at `from` and append the new one. The closed row is never touched again,
 * so a charge computed from it still finds it - a price change does not
 * alter a historical charge, and this is the only write path a repricing
 * has.
 */
export async function changePlanPrice(
  db: Db,
  change: {
    planVersionId: string;
    currency: string;
    billingInterval: BillingInterval;
    amountMinor: number;
    from: Date;
  },
): Promise<void> {
  const from = change.from.toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE plan_prices SET effective_to = ${from}::timestamptz
      WHERE plan_version_id = ${change.planVersionId}::uuid
        AND currency = ${change.currency}
        AND billing_interval = ${change.billingInterval}
        AND effective_to IS NULL
    `);
    await tx.execute(sql`
      INSERT INTO plan_prices
        (plan_version_id, currency, billing_interval, amount_minor, effective_from)
      VALUES (${change.planVersionId}::uuid, ${change.currency},
              ${change.billingInterval}, ${change.amountMinor}, ${from}::timestamptz)
    `);
  });
}

/**
 * Pin a business to a plan version, or clear the pin with null.
 *
 * A tenant write rather than catalogue maintenance, so it runs under the
 * tenant pin like every other businesses-row write. Unwired in PR-099: the
 * PR-100 cutover decides when a business is pinned (a sale pins to the
 * version sold; the launch cohort is pinned to version 1).
 */
export async function pinPlanVersion(
  tx: TenantDb,
  businessId: string,
  planVersionId: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses SET plan_version_id = ${planVersionId}, updated_at = now()
    WHERE id = ${businessId}::uuid
  `);
}
