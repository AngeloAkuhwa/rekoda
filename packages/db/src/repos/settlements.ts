/**
 * Provider settlement, recorded as reported (spec §20; P2, PR-063).
 *
 * Actual provider data drives the books, so what lands here must be worth
 * driving them with: a report whose components do not explain its own
 * gross→net gap is REFUSED, not stored — an incoherent fact in this table
 * would flow into postings (PR-065) as an incoherent journal. And a payout
 * the provider re-reports with different numbers is a CONFLICT for a human,
 * never a silent overwrite: the first report may already be posted.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { ledgerEntries, ledgerTransactions } from '../schema/finance.js';
import { settlementComponents, settlementItems, settlements } from '../schema/payments-hub.js';
import { accountByRole } from './accounts.js';
import { accountIdsForKeys } from './issue.js';

export const COMPONENT_KINDS = [
  'PROCESSING_FEE',
  'VAT_ON_FEE',
  'WITHHOLDING',
  'LEVY',
  'RESERVE_HELD',
  'RESERVE_RELEASED',
  'REBATE',
  'ADJUSTMENT',
  'CHARGEBACK',
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export interface SettlementComponentInput {
  kind: ComponentKind;
  direction: 'DEDUCTION' | 'ADDITION';
  /** Always positive; the direction carries the sign (§20). */
  amountK: number;
  note?: string;
}

export interface SettlementReport {
  businessId: string;
  paymentConnectionId: string;
  providerSettlementId: string;
  status: 'PENDING' | 'SETTLED' | 'FAILED';
  currency?: string;
  grossK: number;
  netK: number;
  settledAt?: Date | null;
  /** Which payments the payout covered. */
  items: Array<{ paymentId: string; amountK: number }>;
  components: SettlementComponentInput[];
}

export type RecordSettlementOutcome =
  | { outcome: 'recorded'; id: string; isNew: boolean }
  /** gross − deductions + additions ≠ net: the report does not explain
   * itself, and an unexplained fact must not reach the books. */
  | { outcome: 'incoherent_report'; expectedNetK: number }
  /** The provider re-reported this payout with DIFFERENT numbers. The
   * stored report may already be posted; a human decides. */
  | { outcome: 'conflicting_report'; id: string };

const signedSumK = (components: SettlementComponentInput[]): number =>
  components.reduce((sum, c) => sum + (c.direction === 'DEDUCTION' ? -c.amountK : c.amountK), 0);

export async function recordSettlement(
  tx: TenantDb,
  report: SettlementReport,
): Promise<RecordSettlementOutcome> {
  const expectedNetK = report.grossK + signedSumK(report.components);
  if (expectedNetK !== report.netK) {
    return { outcome: 'incoherent_report', expectedNetK };
  }

  const inserted = await tx
    .insert(settlements)
    .values({
      businessId: report.businessId,
      paymentConnectionId: report.paymentConnectionId,
      providerSettlementId: report.providerSettlementId,
      status: report.status,
      ...(report.currency ? { currency: report.currency } : {}),
      grossK: report.grossK,
      netK: report.netK,
      settledAt: report.settledAt ?? null,
    })
    .onConflictDoNothing({
      target: [
        settlements.businessId,
        settlements.paymentConnectionId,
        settlements.providerSettlementId,
      ],
    })
    .returning({ id: settlements.id });

  const created = inserted[0];
  if (created) {
    /* First sight of this payout: the detail rows land with it, once —
     * items and components are immutable by REVOKE (0090). */
    if (report.items.length) {
      await tx.insert(settlementItems).values(
        report.items.map((item) => ({
          businessId: report.businessId,
          settlementId: created.id,
          paymentId: item.paymentId,
          amountK: item.amountK,
        })),
      );
    }
    if (report.components.length) {
      await tx.insert(settlementComponents).values(
        report.components.map((component) => ({
          businessId: report.businessId,
          settlementId: created.id,
          kind: component.kind,
          direction: component.direction,
          amountK: component.amountK,
          ...(component.note ? { note: component.note } : {}),
        })),
      );
    }
    return { outcome: 'recorded', id: created.id, isNew: true };
  }

  /* Seen before. The same numbers may progress the status (a PENDING
   * payout settling is the ordinary path); different numbers are a
   * conflict the caller records as an exception, never an overwrite. */
  const existingRows = await tx
    .select({
      id: settlements.id,
      grossK: settlements.grossK,
      netK: settlements.netK,
    })
    .from(settlements)
    .where(
      and(
        eq(settlements.businessId, report.businessId),
        eq(settlements.paymentConnectionId, report.paymentConnectionId),
        eq(settlements.providerSettlementId, report.providerSettlementId),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new Error('recordSettlement: conflict reported but no settlement found');

  if (existing.grossK !== report.grossK || existing.netK !== report.netK) {
    return { outcome: 'conflicting_report', id: existing.id };
  }

  await tx
    .update(settlements)
    .set({
      status: report.status,
      ...(report.settledAt ? { settledAt: report.settledAt } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(settlements.businessId, report.businessId), eq(settlements.id, existing.id)));
  return { outcome: 'recorded', id: existing.id, isNew: false };
}

export interface SettlementReadback {
  id: string;
  paymentConnectionId: string;
  providerSettlementId: string;
  status: string;
  currency: string;
  grossK: number;
  netK: number;
  settledAt: Date | null;
  items: Array<{ paymentId: string; amountK: number }>;
  components: Array<{ kind: string; direction: string; amountK: number; note: string | null }>;
}

/** One settlement, with the payments it covered and its signed explanation. */
export async function settlementById(
  tx: TenantDb,
  businessId: string,
  id: string,
): Promise<SettlementReadback | null> {
  const rows = await tx
    .select()
    .from(settlements)
    .where(and(eq(settlements.businessId, businessId), eq(settlements.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const items = await tx
    .select({ paymentId: settlementItems.paymentId, amountK: settlementItems.amountK })
    .from(settlementItems)
    .where(and(eq(settlementItems.businessId, businessId), eq(settlementItems.settlementId, id)));
  const components = await tx
    .select({
      kind: settlementComponents.kind,
      direction: settlementComponents.direction,
      amountK: settlementComponents.amountK,
      note: settlementComponents.note,
    })
    .from(settlementComponents)
    .where(
      and(
        eq(settlementComponents.businessId, businessId),
        eq(settlementComponents.settlementId, id),
      ),
    );

  return {
    id: row.id,
    paymentConnectionId: row.paymentConnectionId,
    providerSettlementId: row.providerSettlementId,
    status: row.status,
    currency: row.currency,
    grossK: row.grossK,
    netK: row.netK,
    settledAt: row.settledAt,
    items,
    components,
  };
}

/** The payout history, newest first. */
export async function settlementsFor(
  tx: TenantDb,
  businessId: string,
  limit = 50,
): Promise<Array<Omit<SettlementReadback, 'items' | 'components'>>> {
  return tx
    .select({
      id: settlements.id,
      paymentConnectionId: settlements.paymentConnectionId,
      providerSettlementId: settlements.providerSettlementId,
      status: settlements.status,
      currency: settlements.currency,
      grossK: settlements.grossK,
      netK: settlements.netK,
      settledAt: settlements.settledAt,
    })
    .from(settlements)
    .where(eq(settlements.businessId, businessId))
    .orderBy(desc(settlements.createdAt))
    .limit(limit);
}

/* ── the settlement posting (spec §20, §21.1; PR-065) ───────────────────── */

/** The component kinds whose deduction is a FEE the merchant expensed.
 * CHARGEBACK is handled apart (§21.2: its deduction CLEARS THE PAYABLE,
 * never an expense — PR-066). RESERVE_* is deliberately absent still: a
 * reserve is the merchant's ASSET held back, and expensing it would
 * misstate the books, so a settlement carrying one refuses to post until
 * the PR that models reserves lands. */
const FEE_KINDS = new Set(['PROCESSING_FEE', 'VAT_ON_FEE', 'WITHHOLDING', 'LEVY']);
const FEE_CREDIT_KINDS = new Set(['REBATE', 'ADJUSTMENT']);

export type PostSettlementOutcome =
  | { posted: true; ledgerTransactionId: string }
  | { posted: false; reason: 'already_posted' }
  | { posted: false; reason: 'not_settled' }
  /** Invariant 5 (§31): the settlement does not reconcile to the gross of
   * the payments it covered. Posting it would tie the books to a payout
   * whose contents the books cannot name. */
  | { posted: false; reason: 'items_do_not_reconcile'; itemsSumK: number }
  | { posted: false; reason: 'unpostable_components'; kinds: string[] }
  | { posted: false; reason: 'no_clearing_account' };

/**
 * Post a SETTLED settlement from its own stored §20 data — never a rate
 * card (§20's one rule). The money the provider was holding becomes bank
 * and fees:
 *
 *   DR Bank                        net
 *   DR Payment processing fees     deduction components
 *   CR Payment processing fees     addition components (a rebate reduces cost)
 *   CR Provider Clearing           gross
 *
 * Balanced BY CONSTRUCTION: ingestion refused any report where
 * gross − deductions + additions ≠ net, so the equation here is the same
 * arithmetic read back. Idempotent by §9.4's partial unique on
 * (source_type='settlement', source_id, posting_purpose='SETTLEMENT').
 */
export async function postSettlement(
  tx: TenantDb,
  businessId: string,
  settlementId: string,
): Promise<PostSettlementOutcome> {
  const settlement = await settlementById(tx, businessId, settlementId);
  if (!settlement || settlement.status !== 'SETTLED') {
    return { posted: false, reason: 'not_settled' };
  }

  const itemsSumK = settlement.items.reduce((sum, item) => sum + item.amountK, 0);
  if (itemsSumK !== settlement.grossK) {
    return { posted: false, reason: 'items_do_not_reconcile', itemsSumK };
  }

  const strange = settlement.components
    .map((c) => c.kind)
    .filter(
      (kind) => !FEE_KINDS.has(kind) && !FEE_CREDIT_KINDS.has(kind) && !(kind === 'CHARGEBACK'),
    );
  if (strange.length > 0) {
    return { posted: false, reason: 'unpostable_components', kinds: [...new Set(strange)] };
  }
  /* A chargeback ADDITION has no §21 meaning — the provider giving a
   * dispute back arrives as its own reversal, not as settlement income. */
  if (settlement.components.some((c) => c.kind === 'CHARGEBACK' && c.direction === 'ADDITION')) {
    return { posted: false, reason: 'unpostable_components', kinds: ['CHARGEBACK'] };
  }

  const clearing = await accountByRole(
    tx,
    businessId,
    'PAYMENT_PROVIDER_CLEARING',
    settlement.paymentConnectionId,
  );
  if (!clearing) return { posted: false, reason: 'no_clearing_account' };
  const fees = await accountByRole(tx, businessId, 'PAYMENT_PROCESSING_FEES');
  if (!fees) return { posted: false, reason: 'no_clearing_account' };
  const bankIds = await accountIdsForKeys(tx, businessId, ['BANK_PAYSTACK']);
  const bankId = bankIds.get('BANK_PAYSTACK')!;

  const feeDeductionsK = settlement.components
    .filter((c) => c.direction === 'DEDUCTION' && FEE_KINDS.has(c.kind))
    .reduce((sum, c) => sum + c.amountK, 0);
  const feeAdditionsK = settlement.components
    .filter((c) => c.direction === 'ADDITION')
    .reduce((sum, c) => sum + c.amountK, 0);
  /* §21.2's recovery, verbatim: a CHARGEBACK deduction on a settlement
   * clears the payable the post-settlement chargeback raised. */
  const chargebackRecoveryK = settlement.components
    .filter((c) => c.direction === 'DEDUCTION' && c.kind === 'CHARGEBACK')
    .reduce((sum, c) => sum + c.amountK, 0);
  let chargebackPayableId: string | null = null;
  if (chargebackRecoveryK > 0) {
    const payable = await accountByRole(
      tx,
      businessId,
      'PROVIDER_CHARGEBACK_PAYABLE',
      settlement.paymentConnectionId,
    );
    if (!payable) return { posted: false, reason: 'no_clearing_account' };
    chargebackPayableId = payable.id;
  }

  const inserted = await tx
    .insert(ledgerTransactions)
    .values({
      businessId,
      memo: `Settlement ${settlement.providerSettlementId}`,
      sourceType: 'settlement',
      sourceId: settlementId,
      postingPurpose: 'SETTLEMENT',
      ...(settlement.settledAt ? { createdAt: settlement.settledAt } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: ledgerTransactions.id });
  const transaction = inserted[0];
  if (!transaction) return { posted: false, reason: 'already_posted' };

  const entries = [
    { accountId: bankId, debitK: settlement.netK, creditK: 0 },
    ...(feeDeductionsK > 0 ? [{ accountId: fees.id, debitK: feeDeductionsK, creditK: 0 }] : []),
    ...(chargebackRecoveryK > 0 && chargebackPayableId
      ? [{ accountId: chargebackPayableId, debitK: chargebackRecoveryK, creditK: 0 }]
      : []),
    ...(feeAdditionsK > 0 ? [{ accountId: fees.id, debitK: 0, creditK: feeAdditionsK }] : []),
    { accountId: clearing.id, debitK: 0, creditK: settlement.grossK },
  ].filter((entry) => entry.debitK > 0 || entry.creditK > 0);

  await tx.insert(ledgerEntries).values(
    entries.map((entry) => ({
      businessId,
      transactionId: transaction.id,
      accountId: entry.accountId,
      debitK: entry.debitK,
      creditK: entry.creditK,
      /* Same-currency posting (§16): see writePosting. */
      transactionAmountMinor: entry.debitK + entry.creditK,
      ...(settlement.settledAt ? { createdAt: settlement.settledAt } : {}),
    })),
  );
  return { posted: true, ledgerTransactionId: transaction.id };
}
