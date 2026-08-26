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
import type { Db, TenantDb } from '../client.js';

/**
 * Complete is the PAIR, never a value (spec §3.3). A `REKODA_COMPLETE` key
 * would make it possible to hold Complete while holding neither half, and
 * every downgrade would then be an edit rather than a removal.
 */
export const ENTITLEMENT_KEYS = ['REKODA_CHAT', 'REKODA_INTEGRATE', 'REKODA_API'] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

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
