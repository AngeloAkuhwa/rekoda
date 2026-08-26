/**
 * The evidence clocks, enforced (spec §23; PR-011).
 *
 * Three facts drive everything here. An unresolved claim must not live
 * forever automatically, because an abandoned dispute is the most likely
 * state for a claim to be in. Raw media dies while the claim survives,
 * because a screenshot of somebody's bank app is personal data and the fact
 * that a claim was made is a financial record. And an EvidenceLegalHold is
 * the only thing that can stop either clock.
 *
 * The sweep's shape is the estate's: the WORKER discovers what is due across
 * tenants and mutates nothing; every write runs tenant-pinned on the app
 * credential. A compromised worker can list, not touch.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

/** No active hold: released holds do not count, which is the point of them. */
const NO_ACTIVE_HOLD = sql`
  NOT EXISTS (
    SELECT 1 FROM evidence_legal_holds h
    WHERE h.payment_evidence_id = e.id AND h.released_at IS NULL)
`;

export interface DueEvidence {
  businessId: string;
  evidenceId: string;
}

/**
 * Unresolved claims past their deadline. A NULL deadline is never due:
 * nothing was promised about it, and expiring it would invent a schedule.
 */
export async function dueForExpiry(worker: Db, now: Date, limit = 200): Promise<DueEvidence[]> {
  const rows = await worker.execute<{ business_id: string; id: string }>(sql`
    SELECT e.business_id, e.id
    FROM payment_evidence e
    WHERE e.resolution_state = 'UNRESOLVED'
      AND e.resolution_deadline IS NOT NULL
      AND e.resolution_deadline <= ${now.toISOString()}::timestamptz
      AND ${NO_ACTIVE_HOLD}
    ORDER BY e.resolution_deadline
    LIMIT ${limit}
  `);
  return [...rows].map((row) => ({ businessId: row.business_id, evidenceId: row.id }));
}

/**
 * Expire, tenant-pinned, re-checking everything the discovery saw. The
 * worker's list is a suggestion; the pinned WHERE is the decision, so a hold
 * placed between the two is honoured.
 */
export async function expireEvidence(
  tx: TenantDb,
  businessId: string,
  evidenceIds: readonly string[],
  now = new Date(),
): Promise<number> {
  if (evidenceIds.length === 0) return 0;
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE payment_evidence e
    SET resolution_state = 'EXPIRED', resolved_at = ${now.toISOString()}::timestamptz
    WHERE e.business_id = ${businessId}::uuid
      AND e.id = ANY(${sql.raw(`ARRAY[${evidenceIds.map((id) => `'${id}'::uuid`).join(',')}]`)})
      AND e.resolution_state = 'UNRESOLVED'
      AND e.resolution_deadline IS NOT NULL
      AND e.resolution_deadline <= ${now.toISOString()}::timestamptz
      AND ${NO_ACTIVE_HOLD}
    RETURNING e.id
  `);
  return [...rows].length;
}

/**
 * Resolved or expired claims whose raw media has outlived the countdown.
 * `media_ref IS NOT NULL` because a claim can be born without media, and
 * purging nothing every night forever is noise pretending to be work.
 */
export async function dueForPurge(worker: Db, cutoff: Date, limit = 200): Promise<DueEvidence[]> {
  const rows = await worker.execute<{ business_id: string; id: string }>(sql`
    SELECT e.business_id, e.id
    FROM payment_evidence e
    WHERE e.resolution_state IN ('RESOLVED', 'EXPIRED')
      AND e.resolved_at IS NOT NULL
      AND e.resolved_at <= ${cutoff.toISOString()}::timestamptz
      AND e.raw_purged_at IS NULL
      AND e.media_ref IS NOT NULL
      AND ${NO_ACTIVE_HOLD}
    ORDER BY e.resolved_at
    LIMIT ${limit}
  `);
  return [...rows].map((row) => ({ businessId: row.business_id, evidenceId: row.id }));
}

/**
 * Purge the raw media pointer and stamp when. The claim, its amount and its
 * outcome survive: the row is never deleted, only the picture dies.
 *
 * The storage OBJECT the ref names is deleted by the caller through the
 * storage port, and only after this commits — an object with no pointer is
 * an orphan a sweep can re-find, but a pointer to a deleted object is a
 * claim that lies about what it still holds.
 */
export async function purgeRaw(
  tx: TenantDb,
  businessId: string,
  evidenceIds: readonly string[],
  cutoff: Date,
  now = new Date(),
): Promise<string[]> {
  if (evidenceIds.length === 0) return [];
  /* RETURNING sees the row AFTER the update, which is a NULL pointer, so
   * the old refs ride in through a self-join: they are what the caller must
   * hand to the storage port for the object deletion. */
  const rows = await tx.execute<{ media_ref: string }>(sql`
    UPDATE payment_evidence e
    SET media_ref = NULL, media_mime_type = NULL,
        raw_purged_at = ${now.toISOString()}::timestamptz
    FROM payment_evidence old
    WHERE old.id = e.id
      AND e.business_id = ${businessId}::uuid
      AND e.id = ANY(${sql.raw(`ARRAY[${evidenceIds.map((id) => `'${id}'::uuid`).join(',')}]`)})
      AND e.resolution_state IN ('RESOLVED', 'EXPIRED')
      AND e.resolved_at IS NOT NULL
      AND e.resolved_at <= ${cutoff.toISOString()}::timestamptz
      AND e.raw_purged_at IS NULL
      AND e.media_ref IS NOT NULL
      AND ${NO_ACTIVE_HOLD}
    RETURNING old.media_ref
  `);
  return [...rows].map((row) => row.media_ref);
}

/* ── legal holds ─────────────────────────────────────────────────────────── */

export interface PlaceHold {
  businessId: string;
  paymentEvidenceId: string;
  kind: 'dispute' | 'investigation' | 'tax_audit';
  reason: string;
  placedBy: string;
}

export async function placeHold(tx: TenantDb, input: PlaceHold): Promise<{ holdId: string }> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO evidence_legal_holds
      (business_id, payment_evidence_id, kind, reason, placed_by)
    VALUES (${input.businessId}::uuid, ${input.paymentEvidenceId}::uuid,
            ${input.kind}, ${input.reason}, ${input.placedBy})
    RETURNING id
  `);
  const id = [...rows][0]?.id;
  if (!id) throw new Error('placeHold: no row returned');
  return { holdId: id };
}

/** Releasing names who, and releases once: an already-released hold is left as it was. */
export async function releaseHold(
  tx: TenantDb,
  input: { businessId: string; holdId: string; releasedBy: string; now?: Date },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE evidence_legal_holds
    SET released_at = ${(input.now ?? new Date()).toISOString()}::timestamptz,
        released_by = ${input.releasedBy}
    WHERE id = ${input.holdId}::uuid
      AND business_id = ${input.businessId}::uuid
      AND released_at IS NULL
    RETURNING id
  `);
  return [...rows].length === 1;
}
