/**
 * Enforcing the published retention schedule (ADR 0024, migration 0022).
 *
 * The periods are in `@rekoda/core/retention` and are not repeated here. What
 * this file owns is finding who is due and calling the one function allowed
 * to delete them.
 *
 * The deletion itself is deliberately NOT SQL in this file. Migration 0022
 * says at length why: the capability handed to the worker is "delete a
 * business the schedule says is due", with the predicate inside a
 * SECURITY DEFINER function where no caller can pass around it, rather than
 * "delete a business", which a compromised worker could aim at a paying
 * merchant.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

export interface RetentionCandidate {
  businessId: string;
  /** E.164, for the warning. Null when the owner row has gone already. */
  ownerPhone: string | null;
  /** STOP, as a fact. Checked before every proactive send. */
  ownerOptedOut: boolean;
  /** When the trial or the paid period ended. */
  endedAt: Date;
  notifiedAt: Date | null;
}

interface RawCandidate extends Record<string, unknown> {
  id: string;
  owner_phone: string | null;
  opted_out_at: string | null;
  plan_expires_at: string;
  retention_notified_at: string | null;
}

const shape = (row: RawCandidate): RetentionCandidate => ({
  businessId: row.id,
  ownerPhone: row.owner_phone,
  ownerOptedOut: row.opted_out_at !== null,
  endedAt: new Date(row.plan_expires_at),
  notifiedAt: row.retention_notified_at ? new Date(row.retention_notified_at) : null,
});

/**
 * The predicate, written once.
 *
 * A business that ever completed a subscription charge is excluded from every
 * query here. Their books are subject to the financial retention period, and
 * no abandoned-trial rule may reach them: this is the condition that stands
 * between a merchant who paid us once and a sweep that deletes their records.
 */
const NEVER_PAID = sql`
  NOT EXISTS (
    SELECT 1 FROM subscription_charges c
    WHERE c.business_id = b.id AND c.status IN ('paid', 'refunded'))
`;

/**
 * Businesses to warn: the trial ended long enough ago, and nobody has been
 * told yet. Cross-tenant, so it rides the worker credential.
 */
export async function dueForNotice(
  db: Db,
  cutoff: Date,
  limit = 200,
): Promise<RetentionCandidate[]> {
  const rows = await db.execute<RawCandidate>(sql`
    SELECT b.id, b.plan_expires_at, b.retention_notified_at,
           u.phone AS owner_phone, u.opted_out_at
    FROM businesses b
    LEFT JOIN users u ON u.id = b.owner_user_id
    WHERE b.plan IN ('trial', 'expired')
      AND b.plan_expires_at IS NOT NULL
      AND b.plan_expires_at <= ${cutoff.toISOString()}::timestamptz
      AND b.retention_notified_at IS NULL
      AND ${NEVER_PAID}
    ORDER BY b.plan_expires_at
    LIMIT ${limit}
  `);
  return [...rows].map(shape);
}

/**
 * Businesses to delete: warned, and the notice period has run.
 *
 * Both conditions, always. A deletion without a warning is the failure this
 * whole schedule exists to avoid, and the SECURITY DEFINER function checks
 * the same thing again rather than trusting this query.
 */
export async function dueForDeletion(
  db: Db,
  endedBefore: Date,
  notifiedBefore: Date,
  limit = 50,
): Promise<RetentionCandidate[]> {
  const rows = await db.execute<RawCandidate>(sql`
    SELECT b.id, b.plan_expires_at, b.retention_notified_at,
           u.phone AS owner_phone, u.opted_out_at
    FROM businesses b
    LEFT JOIN users u ON u.id = b.owner_user_id
    WHERE b.plan IN ('trial', 'expired')
      AND b.plan_expires_at IS NOT NULL
      AND b.plan_expires_at <= ${endedBefore.toISOString()}::timestamptz
      AND b.retention_notified_at IS NOT NULL
      AND b.retention_notified_at <= ${notifiedBefore.toISOString()}::timestamptz
      AND ${NEVER_PAID}
    ORDER BY b.retention_notified_at
    LIMIT ${limit}
  `);
  return [...rows].map(shape);
}

/**
 * Claim the warning, once.
 *
 * `IS NULL` in the WHERE means the notice period runs from the FIRST warning
 * rather than the latest sweep pass, so a merchant cannot be warned every day
 * and a second worker cannot restart their clock.
 */
export async function claimRetentionNotice(
  tx: TenantDb,
  businessId: string,
  when: Date,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE businesses
    SET retention_notified_at = ${when.toISOString()}::timestamptz, updated_at = now()
    WHERE id = ${businessId}::uuid AND retention_notified_at IS NULL
    RETURNING id
  `);
  return [...rows].length === 1;
}

/**
 * Delete one business, if the schedule says it is due.
 *
 * Returns how many rows went, or -1 when the function's own predicate refused
 * - which is not an error and not something to retry: a business that started
 * paying between the query and this call is a business that must not be
 * deleted, and the refusal is the system working.
 */
export async function deleteForRetention(
  db: Db,
  businessId: string,
  cutoff: Date,
): Promise<number> {
  const rows = await db.execute<{ removed: number }>(sql`
    SELECT retention_delete_business(${businessId}::uuid, ${cutoff.toISOString()}::timestamptz) AS removed
  `);
  return Number([...rows][0]?.removed ?? -1);
}

export interface DeletionRecord {
  businessId: string;
  reason: string;
  rowsDeleted: number;
  deletedAt: Date;
}

/** What the sweep has removed. The proof, kept after the tenant is gone. */
export async function deletions(db: Db, limit = 100): Promise<DeletionRecord[]> {
  const rows = await db.execute<{
    business_id: string;
    reason: string;
    rows_deleted: number;
    deleted_at: string;
  }>(sql`
    SELECT business_id, reason, rows_deleted, deleted_at
    FROM retention_deletions ORDER BY deleted_at DESC LIMIT ${limit}
  `);
  return [...rows].map((row) => ({
    businessId: row.business_id,
    reason: row.reason,
    rowsDeleted: row.rows_deleted,
    deletedAt: new Date(row.deleted_at),
  }));
}
