/**
 * The recognition wiring (spec §12; PR-046): policy → per-order ledger
 * state → the pure engine → the chart → one atomic posting — or one
 * refusal that keeps everything.
 *
 * Everything §12.2 demands meets here:
 *   - the state is read FROM THE LEDGER at posting time (role-filtered
 *     sums over the order's dimensioned lines; recognised-to-date a live
 *     sum over RevenueRecognitionEvents) — no cached balance anywhere;
 *   - the engine's role-keyed lines are resolved through `accountByRole`,
 *     so a merchant who replaced an account posts to the replacement
 *     without this file knowing;
 *   - the posting carries the §12.2 dimensions the writer can know (its
 *     order, its invoice) and §9.4's identity (REVENUE_RECOGNITION purpose
 *     for revenue postings, a postingKey for the rest);
 *   - a `requires_review` outcome opens the review item and posts NOTHING;
 *   - after posting, the invariants are re-asserted against the ledger.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  assertRecognitionInvariants,
  recognise,
  type MoneyRole,
  type RecognitionEvent,
  type RecognitionLine,
  type RecognitionOutcome,
} from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { accounts, financialAccounts } from '../schema/accounts.js';
import { ledgerEntries, ledgerTransactions } from '../schema/finance.js';
import { accountByRole } from './accounts.js';
import { assertPeriodOpen } from './close.js';
import {
  openReviewItem,
  recordRevenueRecognition,
  revenueRecognisedToDate,
} from './recognition-events.js';
import { receivablePolicyFor } from './recognition-policy.js';

/** A role-filtered signed sum over one order's dimensioned lines. */
async function orderRoleBalance(
  tx: TenantDb,
  businessId: string,
  orderId: string,
  role: string,
  sign: 'debit' | 'credit',
): Promise<number> {
  const rows = await tx.execute<{ k: string }>(sql`
    SELECT COALESCE(SUM(${sql.raw(sign === 'debit' ? 'e.debit_k - e.credit_k' : 'e.credit_k - e.debit_k')}), 0)::bigint AS k
    FROM ledger_entries e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.business_id = ${businessId}::uuid
      AND e.order_id = ${orderId}::uuid
      AND a.system_role = ${role}
  `);
  return Number([...rows][0]?.k ?? 0);
}

/** §12.2's reads, per order, at posting time, from the ledger. */
export async function orderLedgerState(tx: TenantDb, businessId: string, orderId: string) {
  const [contractLiabilityMinor, receivableMinor, revenueRecognisedToDateMinor] = await Promise.all(
    [
      orderRoleBalance(tx, businessId, orderId, 'CONTRACT_LIABILITY', 'credit'),
      orderRoleBalance(tx, businessId, orderId, 'ACCOUNTS_RECEIVABLE', 'debit'),
      revenueRecognisedToDate(tx, businessId, orderId),
    ],
  );
  return { contractLiabilityMinor, receivableMinor, revenueRecognisedToDateMinor };
}

/** The merchant's own money accounts, resolved through their scope. */
async function moneyAccountId(tx: TenantDb, businessId: string, role: MoneyRole): Promise<string> {
  if (role === 'PAYMENT_PROVIDER_CLEARING') {
    /* Clearing is per payment connection; the P1 slice threads the
     * connection through. Refusing loudly beats guessing whose. */
    throw new Error('recognition: PAYMENT_PROVIDER_CLEARING needs a payment connection (P1)');
  }
  const kind = role === 'BANK' ? 'bank' : 'till';
  const rows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(financialAccounts, eq(financialAccounts.id, accounts.scopeFinancialAccountId))
    .where(
      and(
        eq(accounts.businessId, businessId),
        eq(accounts.systemRole, role),
        eq(accounts.active, true),
        eq(financialAccounts.kind, kind),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row)
    throw new Error(`recognition: no active ${role} account on a ${kind} — the seed is missing`);
  return row.id;
}

async function resolveLineAccount(
  tx: TenantDb,
  businessId: string,
  line: RecognitionLine,
): Promise<string> {
  if (line.role === 'BANK' || line.role === 'CASH' || line.role === 'PAYMENT_PROVIDER_CLEARING') {
    return moneyAccountId(tx, businessId, line.role);
  }
  const account = await accountByRole(tx, businessId, line.role);
  if (!account) {
    throw new Error(`recognition: role ${line.role} has no active account — the seed is missing`);
  }
  return account.id;
}

export interface ApplyRecognitionInput {
  businessId: string;
  orderId: string;
  /** The §12.2 universal trace of the event being applied. */
  sourceType: string;
  sourceId: string;
  event: RecognitionEvent;
  /** The invoice behind a RECEIVABLE_RAISED, carried onto its AR line. */
  invoiceId?: string;
  orderLineId?: string;
  actor: string;
  occurredAt?: Date;
}

export type ApplyRecognitionResult =
  | { outcome: 'posted'; ledgerTransactionId: string; revenueDeltaMinor: number }
  | { outcome: 'nothing_to_post' }
  | { outcome: 'requires_review'; reviewReason: string };

export async function applyRecognition(
  tx: TenantDb,
  input: ApplyRecognitionInput,
): Promise<ApplyRecognitionResult> {
  const at = input.occurredAt ?? new Date();
  const policy = await receivablePolicyFor(tx, input.businessId);
  const state = await orderLedgerState(tx, input.businessId, input.orderId);
  const out: RecognitionOutcome = recognise(policy, state, input.event);

  if (out.outcome === 'nothing_to_post') return { outcome: 'nothing_to_post' };

  if (out.outcome === 'requires_review') {
    /* POST NOTHING; keep everything. The item is the human's copy of what
     * the engine saw, and the replayed refusal stays one item. */
    await openReviewItem(tx, {
      businessId: input.businessId,
      orderId: input.orderId,
      reviewReason: out.reviewReason,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      context: out.context,
    });
    return { outcome: 'requires_review', reviewReason: out.reviewReason };
  }

  await assertPeriodOpen(tx, input.businessId, at);

  /* §12.2's REQUIRED dimension rules, enforced on the writer that can
   * know: an AR line this posting writes carries its invoice reference
   * whenever the event brought one, and every line carries the order. */
  const isFulfilment = input.event.kind === 'FULFILMENT';
  const inserted = await tx
    .insert(ledgerTransactions)
    .values({
      businessId: input.businessId,
      memo: `Recognition: ${input.event.kind.toLowerCase().replace(/_/g, ' ')} (${input.sourceType} ${input.sourceId})`,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      ...(isFulfilment && out.revenueDeltaMinor > 0
        ? { postingPurpose: 'REVENUE_RECOGNITION' as const }
        : { postingKey: `recognition:${input.orderId}:${input.sourceType}:${input.sourceId}` }),
      ...(input.occurredAt ? { createdAt: input.occurredAt } : {}),
    })
    .returning({ id: ledgerTransactions.id });
  const posted = inserted[0];
  if (!posted) throw new Error('applyRecognition: transaction insert returned no row');

  const accountIds = new Map<string, string>();
  for (const line of out.lines) {
    if (!accountIds.has(line.role)) {
      accountIds.set(line.role, await resolveLineAccount(tx, input.businessId, line));
    }
  }
  await tx.insert(ledgerEntries).values(
    out.lines.map((line) => ({
      businessId: input.businessId,
      transactionId: posted.id,
      accountId: accountIds.get(line.role)!,
      debitK: line.debitMinor,
      creditK: line.creditMinor,
      transactionAmountMinor: line.debitMinor + line.creditMinor,
      orderId: input.orderId,
      ...(line.role === 'ACCOUNTS_RECEIVABLE' && input.invoiceId
        ? { invoiceId: input.invoiceId }
        : {}),
      ...(input.occurredAt ? { createdAt: input.occurredAt } : {}),
    })),
  );

  if (isFulfilment && out.revenueDeltaMinor > 0) {
    const recorded = await recordRevenueRecognition(tx, {
      businessId: input.businessId,
      orderId: input.orderId,
      ...(input.orderLineId ? { orderLineId: input.orderLineId } : {}),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      amountMinor: out.revenueDeltaMinor,
      ledgerTransactionId: posted.id,
    });
    if (recorded.outcome === 'already_recorded') {
      /* A concurrent replay recognised first. Rolling back keeps the
       * quadruple's promise: one recognition, one journal. */
      throw new Error('applyRecognition: fulfilment already recognised, rolling back');
    }
  }

  /* §12.2's closing move: the invariants, re-checked against the ledger
   * the posting just changed. A violation is a defect in the engine. */
  const after = await orderLedgerState(tx, input.businessId, input.orderId);
  assertRecognitionInvariants({
    earnedToDateMinor:
      input.event.kind === 'FULFILMENT'
        ? input.event.earnedToDateMinor
        : after.revenueRecognisedToDateMinor,
    revenueRecognisedToDateMinor: after.revenueRecognisedToDateMinor,
    contractLiabilityMinor: after.contractLiabilityMinor,
    receivableMinor: after.receivableMinor,
  });

  return {
    outcome: 'posted',
    ledgerTransactionId: posted.id,
    revenueDeltaMinor: out.revenueDeltaMinor,
  };
}
