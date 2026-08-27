/**
 * Chargeback accounting (spec §21; P2, PR-066).
 *
 * WHERE the money was decides what the books do, and the model decides
 * that from what the books already know — the payment's settlement state
 * — never from a caller's assertion:
 *
 *   pre-settlement (§21.1)   nothing left the provider; the clearing
 *                            account reverses and the dispute is resolved
 *                            by that reversal
 *       DR Accounts Receivable · CR Provider Clearing
 *
 *   post-settlement (§21.2)  the money is gone; the merchant owes the
 *                            provider — a LIABILITY, never a second
 *                            receivable (CHARGEBACK_RECEIVABLE is
 *                            SUPERSEDED in the spec's own words)
 *       DR Accounts Receivable · CR Provider Chargeback Payable
 *
 *   bank debit (§21.2)       the provider took it from the bank directly;
 *                            no payable ever exists
 *       DR Accounts Receivable · CR Bank
 *
 * Recovery from a future settlement is NOT a new event type: it is a
 * CHARGEBACK deduction component on that settlement, and `postSettlement`
 * clears the payable with it (DR Provider Chargeback Payable).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { ledgerEntries, ledgerTransactions, payments } from '../schema/finance.js';
import { chargebacks, settlementItems, settlements } from '../schema/payments-hub.js';
import { accountByRole } from './accounts.js';
import { accountIdsForKeys } from './issue.js';

export interface RecordChargebackInput {
  businessId: string;
  paymentConnectionId: string;
  paymentId: string;
  providerChargebackId: string;
  amountK: number;
  reason?: string;
  /** §21.2's direct variant: the provider debited the bank instead of
   * raising a payable. Only meaningful post-settlement. */
  recoveredByBankDebit?: boolean;
}

export type RecordChargebackOutcome =
  | {
      outcome: 'recorded';
      id: string;
      isNew: boolean;
      timing: 'PRE_SETTLEMENT' | 'POST_SETTLEMENT';
    }
  | { outcome: 'no_clearing_account' }
  | { outcome: 'payment_not_found' };

export async function recordChargeback(
  tx: TenantDb,
  input: RecordChargebackInput,
): Promise<RecordChargebackOutcome> {
  const paymentRows = await tx
    .select({ settlementStatus: payments.settlementStatus })
    .from(payments)
    .where(and(eq(payments.businessId, input.businessId), eq(payments.id, input.paymentId)))
    .limit(1);
  const payment = paymentRows[0];
  if (!payment) return { outcome: 'payment_not_found' };

  /* Settled money is gone; anything else is still provider-side. The
   * §20 model itself answers first — was this payment covered by a
   * SETTLED payout — with the per-payment stamp as the fallback for
   * payments settled before the model existed. The conservative reading
   * of an unknown state is PRE: reversing clearing claims less than
   * raising a liability does. */
  const covered = await tx
    .select({ id: settlementItems.id })
    .from(settlementItems)
    .innerJoin(settlements, eq(settlements.id, settlementItems.settlementId))
    .where(
      and(
        eq(settlementItems.businessId, input.businessId),
        eq(settlementItems.paymentId, input.paymentId),
        eq(settlements.status, 'SETTLED'),
      ),
    )
    .limit(1);
  const timing =
    covered.length === 1 || payment.settlementStatus === 'settled'
      ? 'POST_SETTLEMENT'
      : 'PRE_SETTLEMENT';
  const bankDebit = timing === 'POST_SETTLEMENT' && input.recoveredByBankDebit === true;
  const resolvedImmediately = timing === 'PRE_SETTLEMENT' || bankDebit;

  const inserted = await tx
    .insert(chargebacks)
    .values({
      businessId: input.businessId,
      paymentConnectionId: input.paymentConnectionId,
      paymentId: input.paymentId,
      providerChargebackId: input.providerChargebackId,
      amountK: input.amountK,
      timing,
      ...(input.reason ? { reason: input.reason } : {}),
      status: resolvedImmediately ? 'RECOVERED' : 'OPEN',
      recoveredVia: resolvedImmediately
        ? timing === 'PRE_SETTLEMENT'
          ? 'CLEARING_REVERSAL'
          : 'BANK_DEBIT'
        : null,
    })
    .onConflictDoNothing({
      target: [
        chargebacks.businessId,
        chargebacks.paymentConnectionId,
        chargebacks.providerChargebackId,
      ],
    })
    .returning({ id: chargebacks.id });
  const created = inserted[0];
  if (!created) {
    /* The provider re-notifying the same dispute: one row, one posting. */
    const existing = await tx
      .select({ id: chargebacks.id, timing: chargebacks.timing })
      .from(chargebacks)
      .where(
        and(
          eq(chargebacks.businessId, input.businessId),
          eq(chargebacks.paymentConnectionId, input.paymentConnectionId),
          eq(chargebacks.providerChargebackId, input.providerChargebackId),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) throw new Error('recordChargeback: conflict reported but no chargeback found');
    return {
      outcome: 'recorded',
      id: row.id,
      isNew: false,
      timing: row.timing as 'PRE_SETTLEMENT' | 'POST_SETTLEMENT',
    };
  }

  /* The posting each timing demands (§21.1/§21.2), idempotent under
   * purpose CHARGEBACK on ('chargeback', id). */
  const arIds = await accountIdsForKeys(
    tx,
    input.businessId,
    bankDebit ? ['ACCOUNTS_RECEIVABLE', 'BANK_PAYSTACK'] : ['ACCOUNTS_RECEIVABLE'],
  );
  let creditAccountId: string;
  if (bankDebit) {
    creditAccountId = arIds.get('BANK_PAYSTACK')!;
  } else {
    const account = await accountByRole(
      tx,
      input.businessId,
      timing === 'PRE_SETTLEMENT' ? 'PAYMENT_PROVIDER_CLEARING' : 'PROVIDER_CHARGEBACK_PAYABLE',
      input.paymentConnectionId,
    );
    if (!account) return { outcome: 'no_clearing_account' };
    creditAccountId = account.id;
  }

  const txRows = await tx
    .insert(ledgerTransactions)
    .values({
      businessId: input.businessId,
      memo: `Chargeback ${input.providerChargebackId}`,
      sourceType: 'chargeback',
      sourceId: created.id,
      postingPurpose: 'CHARGEBACK',
    })
    .returning({ id: ledgerTransactions.id });
  const ledgerTx = txRows[0];
  if (!ledgerTx) throw new Error('recordChargeback: ledger transaction insert returned no row');

  await tx.insert(ledgerEntries).values(
    [
      { accountId: arIds.get('ACCOUNTS_RECEIVABLE')!, debitK: input.amountK, creditK: 0 },
      { accountId: creditAccountId, debitK: 0, creditK: input.amountK },
    ].map((entry) => ({
      businessId: input.businessId,
      transactionId: ledgerTx.id,
      accountId: entry.accountId,
      debitK: entry.debitK,
      creditK: entry.creditK,
      /* Same-currency posting (§16): see writePosting. */
      transactionAmountMinor: entry.debitK + entry.creditK,
    })),
  );

  return { outcome: 'recorded', id: created.id, isNew: true, timing };
}

/**
 * Mark an OPEN chargeback recovered once its settlement deduction has
 * posted. The LEDGER truth is `postSettlement`'s CHARGEBACK component —
 * this row-level status is the merchant-facing echo, stamped by whoever
 * reconciles the payout to the dispute (a provider dispute feed, or ops).
 */
export async function markRecoveredBySettlement(
  tx: TenantDb,
  input: { businessId: string; chargebackId: string },
): Promise<boolean> {
  const rows = await tx
    .update(chargebacks)
    .set({ status: 'RECOVERED', recoveredVia: 'SETTLEMENT_DEDUCTION', updatedAt: sql`now()` })
    .where(
      and(
        eq(chargebacks.businessId, input.businessId),
        eq(chargebacks.id, input.chargebackId),
        eq(chargebacks.status, 'OPEN'),
      ),
    )
    .returning({ id: chargebacks.id });
  return rows.length === 1;
}

export interface ChargebackRow {
  id: string;
  paymentId: string;
  providerChargebackId: string;
  amountK: number;
  timing: string;
  status: string;
  recoveredVia: string | null;
  reason: string | null;
}

/** The dispute history, for the dashboard and the reconciliation queue. */
export async function chargebacksFor(tx: TenantDb, businessId: string): Promise<ChargebackRow[]> {
  return tx
    .select({
      id: chargebacks.id,
      paymentId: chargebacks.paymentId,
      providerChargebackId: chargebacks.providerChargebackId,
      amountK: chargebacks.amountK,
      timing: chargebacks.timing,
      status: chargebacks.status,
      recoveredVia: chargebacks.recoveredVia,
      reason: chargebacks.reason,
    })
    .from(chargebacks)
    .where(eq(chargebacks.businessId, businessId))
    .orderBy(chargebacks.createdAt);
}
