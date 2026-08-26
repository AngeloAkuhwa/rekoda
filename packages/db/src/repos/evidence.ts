/**
 * The first `payment_evidence` writer (spec §6.1, §23; PR-022).
 *
 * "Something somebody showed us. It proves nothing." The row records that a
 * claim was made — an image was shown, an amount was asserted — and NOTHING
 * about whether it is true. Trust lives in `PaymentVerification`; the
 * evidence row is the honest register of what was presented.
 *
 * Written in the caller's transaction, beside whatever the evidence
 * accompanied, so a rolled-back payment does not leave an orphaned claim
 * asserting an image nobody acted on.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

export interface RecordEvidenceInput {
  businessId: string;
  customerId?: string | null;
  /** How it reached us: `chat_image`, a forwarded document, an upload. */
  source: string;
  /** Where the raw media lives. Null when Rekoda kept no copy — the claim
   * survives the media it arrived on (§23). */
  mediaRef?: string | null;
  mediaMimeType?: string | null;
  /** What was asserted the image is worth. An assertion, never a Payment. */
  claimedAmountK?: number | null;
  /**
   * Evidence accompanying an action that resolves it in the same breath — a
   * merchant attesting the payment the image claims — is born RESOLVED, and
   * the raw-media clock (§23) starts now. Evidence AWAITING somebody's
   * answer stays UNRESOLVED and gets the §23 deadline instead, so an
   * abandoned claim expires rather than living forever.
   */
  resolution: { state: 'RESOLVED'; at: Date } | { state: 'UNRESOLVED'; deadline: Date | null };
}

export async function recordEvidence(
  tx: TenantDb,
  input: RecordEvidenceInput,
): Promise<{ id: string }> {
  const resolved = input.resolution.state === 'RESOLVED';
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO payment_evidence
      (business_id, customer_id, source, media_ref, media_mime_type,
       claimed_amount_k, resolution_state, resolution_deadline, resolved_at)
    VALUES
      (${input.businessId}::uuid,
       ${input.customerId ?? null}::uuid,
       ${input.source},
       ${input.mediaRef ?? null},
       ${input.mediaMimeType ?? null},
       ${input.claimedAmountK ?? null}::bigint,
       ${input.resolution.state},
       ${resolved ? null : ((input.resolution as { deadline: Date | null }).deadline?.toISOString() ?? null)}::timestamptz,
       ${resolved ? (input.resolution as { at: Date }).at.toISOString() : null}::timestamptz)
    RETURNING id
  `);
  const id = [...rows][0]?.id;
  if (!id) throw new Error('recordEvidence: insert returned no row');
  return { id };
}

export interface EvidenceRow {
  id: string;
  source: string;
  claimedAmountK: number | null;
  resolutionState: string;
  resolvedAt: Date | null;
}

export async function evidenceById(
  tx: TenantDb,
  businessId: string,
  id: string,
): Promise<EvidenceRow | null> {
  const rows = await tx.execute<{
    id: string;
    source: string;
    claimed_amount_k: string | null;
    resolution_state: string;
    resolved_at: Date | null;
  }>(sql`
    SELECT id, source, claimed_amount_k, resolution_state, resolved_at
    FROM payment_evidence
    WHERE business_id = ${businessId}::uuid AND id = ${id}::uuid
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    claimedAmountK: row.claimed_amount_k === null ? null : Number(row.claimed_amount_k),
    resolutionState: row.resolution_state,
    resolvedAt: row.resolved_at,
  };
}
