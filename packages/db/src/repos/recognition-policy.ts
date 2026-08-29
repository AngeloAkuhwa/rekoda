/**
 * The receivable recognition policy, persisted (spec §12.3, §12.5;
 * PR-044). Versioned rows, forward-looking only, resolved BY DATE —
 * historical accounting never changes because a policy changed later. The
 * privileged surface that will write this goes through the command bus
 * when it arrives; until then the repo is the only door, and it audits.
 */
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { lagosDay, type ReceivableRecognitionPolicy } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { receivableRecognitionPolicies } from '../schema/finance.js';
import { auditEvents } from '../schema/ops.js';

/** §12.3's default: the behaviour every business has had since the first
 * invoice posted a receivable. Stated once, here. */
export const DEFAULT_RECEIVABLE_POLICY: ReceivableRecognitionPolicy = 'ON_ISSUE_UNCONDITIONAL';

export type SetPolicyOutcome =
  | { outcome: 'set'; effectiveFrom: string }
  /* Forward-looking means forward: rewriting the past is refused, always. */
  | { outcome: 'backdated'; today: string }
  | { outcome: 'already_set'; policy: ReceivableRecognitionPolicy };

export async function setReceivablePolicy(
  tx: TenantDb,
  input: {
    businessId: string;
    policy: ReceivableRecognitionPolicy;
    /** Lagos date, YYYY-MM-DD. Defaults to today. */
    effectiveFrom?: string;
    actor: string;
  },
): Promise<SetPolicyOutcome> {
  const today = lagosDay(new Date());
  const from = input.effectiveFrom ?? today;
  if (from < today) return { outcome: 'backdated', today };

  const standing = await receivablePolicyFor(tx, input.businessId, from);
  if (standing === input.policy) return { outcome: 'already_set', policy: standing };

  await tx.insert(receivableRecognitionPolicies).values({
    businessId: input.businessId,
    policy: input.policy,
    effectiveFrom: from,
    createdBy: input.actor,
  });
  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'receivable_recognition_policy',
    entityId: from,
    action: 'set',
    oldValue: { policy: standing } as never,
    newValue: { policy: input.policy, effectiveFrom: from } as never,
    sourceType: 'dashboard',
  });
  return { outcome: 'set', effectiveFrom: from };
}

/**
 * The policy in force on a Lagos date: the latest row at or before it,
 * or the default when none. Ask with the ACCOUNTING date, always — that
 * is the whole mechanism by which history stays still.
 */
export async function receivablePolicyFor(
  tx: TenantDb,
  businessId: string,
  onLagosDay?: string,
): Promise<ReceivableRecognitionPolicy> {
  const asOf = onLagosDay ?? lagosDay(new Date());
  const rows = await tx
    .select({ policy: receivableRecognitionPolicies.policy })
    .from(receivableRecognitionPolicies)
    .where(
      and(
        eq(receivableRecognitionPolicies.businessId, businessId),
        lte(receivableRecognitionPolicies.effectiveFrom, asOf),
      ),
    )
    .orderBy(desc(receivableRecognitionPolicies.effectiveFrom))
    .limit(1);
  return (rows[0]?.policy as ReceivableRecognitionPolicy | undefined) ?? DEFAULT_RECEIVABLE_POLICY;
}

/** Every policy the business ever held, newest first — the version trail. */
export async function receivablePolicyHistory(tx: TenantDb, businessId: string) {
  return tx
    .select({
      policy: receivableRecognitionPolicies.policy,
      effectiveFrom: receivableRecognitionPolicies.effectiveFrom,
      createdBy: receivableRecognitionPolicies.createdBy,
      createdAt: receivableRecognitionPolicies.createdAt,
    })
    .from(receivableRecognitionPolicies)
    .where(eq(receivableRecognitionPolicies.businessId, businessId))
    .orderBy(desc(receivableRecognitionPolicies.effectiveFrom), sql`created_at DESC`);
}
