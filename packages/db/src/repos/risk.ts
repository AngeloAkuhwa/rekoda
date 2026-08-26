/**
 * High-risk confirmations, in SQL (canonical spec Appendix D.3).
 *
 * One operation matters and it is the claim. A confirmation is authority to
 * do something irreversible exactly once, so the claim is a SINGLE statement
 * whose WHERE carries every precondition: still open, not expired, this
 * tenant, this actor, this command, this subject. Two taps on a refund button
 * race into the database and one of them loses, the same shape as the usage
 * meter and document numbering.
 *
 * Nothing here decides POLICY. Which commands need a confirmation lives in
 * `@rekoda/core`'s risk table, so an ingress cannot lower a tier by calling a
 * different repository function.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

export interface OpenConfirmation {
  businessId: string;
  command: string;
  /** Which refund, which period, which connection. Null for a whole-business act. */
  subject?: string | null;
  actor: string;
  ingress: string;
  /** The consequence as the merchant was shown it, in their own terms. */
  consequence: string;
  /** Appendix D.3: a missing reason is a refusal, so this is required. */
  reason: string;
  context?: Record<string, unknown> | null;
  expiresAt: Date;
}

export interface ConfirmationRow {
  id: string;
  command: string;
  subject: string | null;
  actor: string;
  ingress: string;
  consequence: string;
  reason: string;
  expiresAt: Date;
}

/**
 * Record that a merchant was shown a consequence and accepted it.
 *
 * Written when the consequence is DISPLAYED and accepted, never when the
 * command is dispatched: the whole point of the tier is that a human read a
 * sentence about money leaving and said yes to that sentence.
 */
export async function openConfirmation(
  tx: TenantDb,
  input: OpenConfirmation,
): Promise<ConfirmationRow> {
  const rows = await tx.execute<{
    id: string;
    command: string;
    subject: string | null;
    actor: string;
    ingress: string;
    consequence: string;
    reason: string;
    expires_at: Date;
  }>(sql`
    INSERT INTO pending_confirmations
      (business_id, command, subject, actor, ingress, consequence, reason, context, expires_at)
    VALUES (
      ${input.businessId}::uuid, ${input.command}::text, ${input.subject ?? null}::text,
      ${input.actor}::text, ${input.ingress}::text, ${input.consequence}::text,
      ${input.reason}::text, ${JSON.stringify(input.context ?? null)}::jsonb,
      ${input.expiresAt.toISOString()}::timestamptz)
    RETURNING id, command, subject, actor, ingress, consequence, reason, expires_at
  `);
  const row = [...rows][0];
  if (!row) throw new Error('confirmation was not opened');
  return {
    id: row.id,
    command: row.command,
    subject: row.subject,
    actor: row.actor,
    ingress: row.ingress,
    consequence: row.consequence,
    reason: row.reason,
    expiresAt: new Date(row.expires_at),
  };
}

/** Why a claim did not succeed. Distinguished because the merchant needs to know. */
export type ClaimOutcome =
  | { readonly outcome: 'claimed'; readonly row: ConfirmationRow }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'already_used' };

/**
 * Spend a confirmation, once.
 *
 * The UPDATE carries the whole precondition, so there is no read-then-write
 * for two requests to interleave inside. A caller that loses the race gets
 * zero rows and is told which wall it hit, because "this already happened"
 * and "this expired, ask again" ask completely different things of a merchant
 * standing in a shop.
 *
 * Every binding is in the WHERE. A confirmation opened for one refund cannot
 * be spent on another, opened by one actor cannot be spent by a second, and
 * opened in the dashboard cannot be replayed through the API.
 */
export async function claimConfirmation(
  tx: TenantDb,
  claim: {
    businessId: string;
    id: string;
    command: string;
    subject?: string | null;
    actor: string;
    ingress: string;
    now?: Date;
  },
): Promise<ClaimOutcome> {
  const now = (claim.now ?? new Date()).toISOString();
  const rows = await tx.execute<{
    id: string;
    command: string;
    subject: string | null;
    actor: string;
    ingress: string;
    consequence: string;
    reason: string;
    expires_at: Date;
  }>(sql`
    UPDATE pending_confirmations
    SET claimed_at = ${now}::timestamptz
    WHERE id = ${claim.id}::uuid
      AND business_id = ${claim.businessId}::uuid
      AND command = ${claim.command}::text
      AND subject IS NOT DISTINCT FROM ${claim.subject ?? null}::text
      AND actor = ${claim.actor}::text
      AND ingress = ${claim.ingress}::text
      AND claimed_at IS NULL
      AND expires_at > ${now}::timestamptz
    RETURNING id, command, subject, actor, ingress, consequence, reason, expires_at
  `);
  const row = [...rows][0];
  if (row) {
    return {
      outcome: 'claimed',
      row: {
        id: row.id,
        command: row.command,
        subject: row.subject,
        actor: row.actor,
        ingress: row.ingress,
        consequence: row.consequence,
        reason: row.reason,
        expiresAt: new Date(row.expires_at),
      },
    };
  }

  /* Nothing moved. Which wall it was decides what the merchant is told, and
   * the three answers are genuinely different actions on their part. */
  const found = await tx.execute<{ claimed_at: Date | null; expires_at: Date }>(sql`
    SELECT claimed_at, expires_at FROM pending_confirmations
    WHERE id = ${claim.id}::uuid AND business_id = ${claim.businessId}::uuid
  `);
  const state = [...found][0];
  if (!state) return { outcome: 'not_found' };
  if (state.claimed_at !== null) return { outcome: 'already_used' };
  if (new Date(state.expires_at) <= new Date(now)) return { outcome: 'expired' };
  /* It exists, it is open and it is unexpired, so a binding did not match:
   * a different actor, ingress, command or subject. Indistinguishable from
   * absent ON PURPOSE — telling a caller WHICH binding failed tells them how
   * to forge the next attempt. */
  return { outcome: 'not_found' };
}

/** What is still outstanding for this tenant. For the dashboard and for tests. */
export async function openConfirmationsFor(
  tx: TenantDb,
  businessId: string,
  now = new Date(),
): Promise<ConfirmationRow[]> {
  const rows = await tx.execute<{
    id: string;
    command: string;
    subject: string | null;
    actor: string;
    ingress: string;
    consequence: string;
    reason: string;
    expires_at: Date;
  }>(sql`
    SELECT id, command, subject, actor, ingress, consequence, reason, expires_at
    FROM pending_confirmations
    WHERE business_id = ${businessId}::uuid
      AND claimed_at IS NULL
      AND expires_at > ${now.toISOString()}::timestamptz
    ORDER BY created_at DESC
  `);
  return [...rows].map((row) => ({
    id: row.id,
    command: row.command,
    subject: row.subject,
    actor: row.actor,
    ingress: row.ingress,
    consequence: row.consequence,
    reason: row.reason,
    expiresAt: new Date(row.expires_at),
  }));
}
