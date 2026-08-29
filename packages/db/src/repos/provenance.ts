/**
 * The canonical verification write (spec §6.3, §6.5).
 *
 * One shape, used by every writer: append the PaymentVerification, then
 * insert its unique claim, in the SAME transaction, with NO external work
 * between them — no provider call, no queue publish, no outbox flush, no
 * read outside the transaction. That window is the only place a duplicate
 * can be born, and the only safe width for it is zero.
 *
 * The unique violation on the claim IS the idempotency check. It aborts the
 * caller's whole transaction, which is the correct and only safe outcome:
 * a payment half-written beside a refused claim would be exactly the
 * duplicate financial truth the claim exists to prevent. Resolution — same
 * payment, so an idempotent retry, against different payment, so a genuine
 * conflict — happens in a NEW transaction, because an aborted one can no
 * longer answer questions.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import type { VerificationSource } from '@rekoda/core';

export interface AppendVerificationInput {
  businessId: string;
  paymentId: string;
  source: VerificationSource;
  /** Exactly one of these three, matching the source (spec §6.5). */
  providerSourceIdentity?: string | null;
  financialTransactionId?: string | null;
  confirmationEventId?: string | null;
  paymentEvidenceId?: string | null;
  /** The provider try this verification answers (§6.5; PR-055). */
  paymentAttemptId?: string | null;
  providerReference?: string | null;
  /** Who, for MERCHANT_ATTESTED and MANUAL_RECONCILIATION. */
  actorId?: string | null;
  reason?: string | null;
  verifiedAt?: Date;
}

/** The claim was already held for a different payment. Spec §6.5's refusal. */
export class ClaimConflict extends Error {
  override readonly name = 'ClaimConflict';
  constructor(readonly claimKey: string) {
    super(`this evidence is already spoken for: ${claimKey}`);
  }
}

/**
 * Append a verification and take its claim. Throws `ClaimConflict` when the
 * evidence is already held — the transaction is aborted by then, on purpose.
 */
export async function appendVerification(
  tx: TenantDb,
  input: AppendVerificationInput,
): Promise<{ verificationId: string }> {
  const keys = [
    input.providerSourceIdentity,
    input.financialTransactionId,
    input.confirmationEventId,
  ].filter((key) => key !== null && key !== undefined);
  if (keys.length !== 1) {
    /* Fail closed (spec §6.5): where claim integrity cannot be established,
     * REFUSE the verification. Never proceed hopefully. */
    throw new Error(
      `a verification carries exactly one claim key, not ${keys.length} (source ${input.source})`,
    );
  }

  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO payment_verifications
      (business_id, payment_id, source, payment_evidence_id, financial_transaction_id,
       provider_source_identity, payment_attempt_id, provider_reference, actor_id, reason,
       verified_at)
    VALUES
      (${input.businessId}::uuid, ${input.paymentId}::uuid, ${input.source}::text,
       ${input.paymentEvidenceId ?? null}::uuid, ${input.financialTransactionId ?? null}::uuid,
       ${input.providerSourceIdentity ?? null}::text, ${input.paymentAttemptId ?? null}::uuid,
       ${input.providerReference ?? null}::text,
       ${input.actorId ?? null}::text, ${input.reason ?? null}::text,
       ${(input.verifiedAt ?? new Date()).toISOString()}::timestamptz)
    RETURNING id
  `);
  const verificationId = [...rows][0]?.id;
  if (!verificationId) throw new Error('appendVerification: no row returned');

  try {
    await tx.execute(sql`
      INSERT INTO payment_verification_claims
        (business_id, verification_id, financial_transaction_id,
         provider_source_identity, confirmation_event_id)
      VALUES
        (${input.businessId}::uuid, ${verificationId}::uuid,
         ${input.financialTransactionId ?? null}::uuid,
         ${input.providerSourceIdentity ?? null}::text,
         ${input.confirmationEventId ?? null}::text)
    `);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ClaimConflict(String(keys[0]));
    }
    throw error;
  }

  return { verificationId };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } }) ?? {};
  return code.code === '23505' || code.cause?.code === '23505';
}
