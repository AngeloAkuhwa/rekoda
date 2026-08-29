/**
 * What a business is allowed to do at all (canonical spec §4.1).
 *
 * Distinct from the meter, and the distinction is the point. An allowance
 * answers "how many more this month"; an entitlement answers "does this
 * business have this capability". Today Integrate is refused by an orders
 * allowance of zero, which conflates the two and only works for capabilities
 * that happen to be counted.
 *
 * Nothing here decides anything yet. The resolver that combines these grants
 * with what `businesses.plan` implies, and the command-layer gate that reads
 * it, are PR-013. This module is the record they will read.
 */
import { sql } from 'drizzle-orm';
import { effectiveEntitlements, ENTITLEMENT_KEYS as KEYS, type EntitlementKey } from '@rekoda/core';
import type { Db, TenantDb } from '../client.js';
import { grantedEntitlements } from './add-ons.js';
import { planFor } from './usage.js';

/**
 * Every source of an entitlement, resolved together (PR-116).
 *
 * Three: what the PLAN implies, what support GRANTED explicitly, and what a
 * held ADD-ON grants. The third is derived rather than copied into
 * `business_entitlements` when the add-on is bought, because a copied
 * entitlement has to be un-copied when the holding ends, and the day
 * somebody forgets, a cancelled subscription leaves a live capability
 * behind. Deriving it means ending the holding ends the capability, with
 * nothing to remember.
 */
async function allSources(
  tx: TenantDb,
  businessId: string,
  now: Date,
): Promise<{ plan: string; held: EntitlementKey[] }> {
  const plan = await planFor(tx, businessId, now);
  const explicit = await heldBy(tx, businessId);
  const fromAddOns = await grantedEntitlements(tx, businessId, now);
  const known = new Set<string>(KEYS);
  return {
    plan,
    held: effectiveEntitlements(plan, [
      ...explicit.map((g) => g.entitlementKey),
      ...fromAddOns.filter((key): key is EntitlementKey => known.has(key)),
    ]),
  };
}

/* The key set and the plan map are pure, so they live in core. Re-exported
 * here because every caller that needs one needs the other. */
export { ENTITLEMENT_KEYS, type EntitlementKey } from '@rekoda/core';

/**
 * Where a grant came from, because a downgrade must treat them differently: a
 * PLAN grant goes when the plan does, a MANUAL_GRANT issued by support does
 * not, and a TRIAL grant ends with the trial.
 */
export const GRANT_SOURCES = ['PLAN', 'TRIAL', 'MANUAL_GRANT'] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

export interface CatalogueEntry {
  key: EntitlementKey;
  name: string;
  description: string;
}

export interface HeldEntitlement {
  entitlementKey: EntitlementKey;
  source: GrantSource;
  grantedAt: Date;
  grantedBy: string | null;
}

/**
 * The catalogue. Reference data, identical for every tenant, so this takes a
 * plain `Db` rather than a pinned transaction: a policy keyed on
 * `app.business_id` would hide it from anything reading outside one.
 */
export async function catalogue(db: Db): Promise<CatalogueEntry[]> {
  const rows = await db.execute<{ key: string; name: string; description: string }>(
    sql`SELECT key, name, description FROM entitlements ORDER BY key`,
  );
  return [...rows].map((r) => ({
    key: r.key as EntitlementKey,
    name: r.name,
    description: r.description,
  }));
}

export interface GrantInput {
  businessId: string;
  entitlementKey: EntitlementKey;
  source: GrantSource;
  grantedBy?: string | null;
}

/**
 * Grant, or leave an existing grant exactly as it is.
 *
 * A renewal re-grants every month, so this cannot throw on a repeat. It also
 * must not silently rewrite `granted_at`: the date a business first got a
 * capability is the answer to "since when could they do this", and a renewal
 * is not a new answer. `DO NOTHING` rather than `DO UPDATE` for that reason.
 *
 * A change of source is a real change and is not this function's job; revoke
 * and grant again, which leaves both facts in the audit trail.
 */
export async function grant(tx: TenantDb, input: GrantInput): Promise<void> {
  await tx.execute(sql`
    INSERT INTO business_entitlements (business_id, entitlement_key, source, granted_by)
    VALUES (${input.businessId}::uuid, ${input.entitlementKey}, ${input.source},
            ${input.grantedBy ?? null})
    ON CONFLICT (business_id, entitlement_key) DO NOTHING
  `);
}

/**
 * Withdraw permission to do new things. It removes NO record the business
 * already made: existing orders stay visible, existing invoices stay
 * collectible, existing statements stay correct (spec §4.5).
 */
export async function revoke(
  tx: TenantDb,
  businessId: string,
  entitlementKey: EntitlementKey,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM business_entitlements
    WHERE business_id = ${businessId}::uuid AND entitlement_key = ${entitlementKey}
  `);
}

/**
 * The explicit grants only. Not the effective set: what a business can
 * actually do is these together with what its plan implies, and combining
 * them is the resolver's job in PR-013.
 *
 * `businessId` is passed and also pinned by `withBusiness`. The policy is what
 * answers, not the WHERE clause; the argument keeps the call site readable and
 * the tests prove it cannot be used to reach another tenant.
 */
export async function heldBy(tx: TenantDb, businessId: string): Promise<HeldEntitlement[]> {
  const rows = await tx.execute<{
    entitlement_key: string;
    source: string;
    granted_at: string;
    granted_by: string | null;
  }>(sql`
    SELECT entitlement_key, source, granted_at, granted_by
    FROM business_entitlements
    WHERE business_id = ${businessId}::uuid
    ORDER BY entitlement_key
  `);
  return [...rows].map((r) => ({
    entitlementKey: r.entitlement_key as EntitlementKey,
    source: r.source as GrantSource,
    grantedAt: new Date(r.granted_at),
    grantedBy: r.granted_by,
  }));
}

/** One membership question, for a caller that only needs the answer. */
export async function holds(
  tx: TenantDb,
  businessId: string,
  entitlementKey: EntitlementKey,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    SELECT 1 FROM business_entitlements
    WHERE business_id = ${businessId}::uuid AND entitlement_key = ${entitlementKey}
    LIMIT 1
  `);
  return [...rows].length > 0;
}

/* ── the resolver and the gate ─────────────────────────────────────────── */

/**
 * What this business can actually do: what its plan implies, what was
 * granted explicitly, and what a held add-on grants (spec §4.1).
 *
 * One place. Every ingress asks this and none of them derives it, which is
 * the whole point: before PR-013 the Chat handler inferred the boundary from
 * an orders allowance of zero and the storefront could not tell "not in your
 * plan" from "you have used all 300", so the same rule had two
 * implementations and one of them could not express the answer.
 */
export async function resolve(
  tx: TenantDb,
  businessId: string,
  now: Date = new Date(),
): Promise<EntitlementKey[]> {
  return (await allSources(tx, businessId, now)).held;
}

/** Why a capability was refused. Never a bare boolean: the caller has to say something. */
export interface EntitlementRefusal {
  missing: EntitlementKey;
  /** The plan at the moment of refusal, so the reply can name the upgrade. */
  plan: string;
}

/**
 * The gate. Returns null when the business may proceed, or the refusal.
 *
 * **Call this BEFORE the meter and before any chargeable provider work**
 * (spec §4.3, rules 1 to 3). The ordering is the invariant, not a preference:
 * an unentitled request that consumed a unit first would have to be refunded,
 * and every refund path is a place the meter can drift. A refused request
 * consumes nothing because nothing was taken.
 *
 * Until A1 lands the command layer this is called from the ingress. That is
 * the one place spec §4.1 says the check must NOT live permanently, so every
 * call site here is a line A1 deletes rather than a pattern it copies.
 */
export async function requireEntitlement(
  tx: TenantDb,
  businessId: string,
  required: EntitlementKey,
  now: Date = new Date(),
): Promise<EntitlementRefusal | null> {
  const { plan, held } = await allSources(tx, businessId, now);
  return held.includes(required) ? null : { missing: required, plan };
}
