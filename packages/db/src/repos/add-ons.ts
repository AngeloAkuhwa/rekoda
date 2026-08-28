/**
 * What a business holds, and what those holdings grant (PR-116).
 *
 * Migration 0112's two tables read together. The resolution rule is one
 * sentence: a business's ceiling for a unit is what their PLAN sells plus
 * what every add-on they hold today GRANTS, judged at the version each was
 * sold at.
 *
 * The version pin is the same idea as `businesses.plan_version_id`: a
 * merchant who bought the API when it included twenty-five thousand requests
 * keeps twenty-five thousand after a repricing, because their holding still
 * points at the version whose grants never changed.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

export type GrantKind = 'ENTITLEMENT' | 'CAPACITY' | 'MONTHLY_UNITS';

export interface HeldAddOn {
  addOnId: string;
  version: number;
  name: string;
  startedAt: Date;
  endsAt: Date | null;
}

/** The add-ons live for this business at `now`, with the version sold. */
export async function heldBy(
  tx: TenantDb,
  businessId: string,
  now: Date = new Date(),
): Promise<HeldAddOn[]> {
  const at = now.toISOString();
  const rows = await tx.execute<{
    add_on_id: string;
    version: number;
    name: string;
    started_at: string | Date;
    ends_at: string | Date | null;
  }>(sql`
    SELECT h.add_on_id, h.version, a.name, h.started_at, h.ends_at
      FROM business_add_ons h
      JOIN add_ons a ON a.add_on_id = h.add_on_id AND a.version = h.version
     WHERE h.business_id = ${businessId}
       AND h.started_at <= ${at}::timestamptz
       AND (h.ends_at IS NULL OR h.ends_at > ${at}::timestamptz)
     ORDER BY h.started_at
  `);
  return [...rows].map((row) => ({
    addOnId: row.add_on_id,
    version: Number(row.version),
    name: row.name,
    startedAt: at_(row.started_at)!,
    endsAt: at_(row.ends_at),
  }));
}

/**
 * How much of one unit the held add-ons grant, of one kind.
 *
 * A SUM rather than a max: two extra-application add-ons grant two
 * applications. Zero when nothing grants it, which is the honest answer and
 * the one that keeps a business with no add-ons at exactly their plan.
 */
export async function grantedUnits(
  tx: TenantDb,
  businessId: string,
  kind: 'CAPACITY' | 'MONTHLY_UNITS',
  unit: string,
  now: Date = new Date(),
): Promise<number> {
  const at = now.toISOString();
  const rows = await tx.execute<{ granted: number }>(sql`
    SELECT COALESCE(sum(g.quantity), 0)::int AS granted
      FROM business_add_ons h
      JOIN add_on_grants g
        ON g.add_on_id = h.add_on_id AND g.version = h.version
     WHERE h.business_id = ${businessId}
       AND h.started_at <= ${at}::timestamptz
       AND (h.ends_at IS NULL OR h.ends_at > ${at}::timestamptz)
       AND g.grant_kind = ${kind}
       AND g.unit = ${unit}
  `);
  return [...rows][0]?.granted ?? 0;
}

/**
 * Entitlements the held add-ons grant.
 *
 * DERIVED rather than copied into `business_entitlements` when the add-on is
 * bought: an entitlement that was copied has to be un-copied when the
 * holding ends, and the day somebody forgets, a cancelled subscription
 * leaves a live capability behind. Deriving it means ending the holding ends
 * the capability, with nothing to remember.
 */
export async function grantedEntitlements(
  tx: TenantDb,
  businessId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const at = now.toISOString();
  const rows = await tx.execute<{ entitlement_key: string }>(sql`
    SELECT DISTINCT g.entitlement_key
      FROM business_add_ons h
      JOIN add_on_grants g
        ON g.add_on_id = h.add_on_id AND g.version = h.version
     WHERE h.business_id = ${businessId}
       AND h.started_at <= ${at}::timestamptz
       AND (h.ends_at IS NULL OR h.ends_at > ${at}::timestamptz)
       AND g.grant_kind = 'ENTITLEMENT'
       AND g.entitlement_key IS NOT NULL
  `);
  return [...rows].map((row) => row.entitlement_key);
}

/** Start a holding at the version in force. The purchase's record. */
export async function hold(
  tx: TenantDb,
  input: { businessId: string; addOnId: string; version: number; startedAt?: Date },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO business_add_ons (business_id, add_on_id, version, started_at)
    VALUES (
      ${input.businessId}, ${input.addOnId}, ${input.version},
      ${(input.startedAt ?? new Date()).toISOString()}::timestamptz
    )
    ON CONFLICT DO NOTHING
  `);
}

/**
 * End a holding, at a date.
 *
 * `ends_at` in the future is a cancellation that has not taken effect yet,
 * which is how a merchant who cancels mid-month keeps what they paid for
 * until the period closes. Nothing is deleted: "they used to hold the API"
 * is the answer to a billing dispute.
 */
export async function endHolding(
  tx: TenantDb,
  businessId: string,
  addOnId: string,
  endsAt: Date,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE business_add_ons
       SET ends_at = ${endsAt.toISOString()}::timestamptz
     WHERE business_id = ${businessId} AND add_on_id = ${addOnId} AND ends_at IS NULL
     RETURNING id
  `);
  return [...rows].length > 0;
}

/** The open version of an add-on, or null if the catalogue has none. */
export async function openVersionOf(
  tx: TenantDb,
  addOnId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const at = now.toISOString();
  const rows = await tx.execute<{ version: number }>(sql`
    SELECT version FROM add_ons
     WHERE add_on_id = ${addOnId}
       AND effective_from <= ${at}::timestamptz
       AND (effective_to IS NULL OR effective_to > ${at}::timestamptz)
     ORDER BY version DESC
     LIMIT 1
  `);
  const row = [...rows][0];
  return row ? Number(row.version) : null;
}

function at_(value: string | Date | null): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}
