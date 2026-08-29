/**
 * The reconciliation commands (spec §25, §6.9; PR-026):
 * `IngestFinancialTransaction`, `ConfirmReconciliation`.
 *
 * Ingestion is one door however the lines arrive: the CSV upload and the
 * bank feed both land here, same fingerprint, same dedupe — nothing
 * downstream knows which way a line came in, and now nothing upstream has
 * a cheaper path to the bank column either.
 *
 * `ConfirmReconciliation` here is the STANDARD case: a person pairing what
 * the deterministic rule left open. It never overrules — `matchByHand`
 * refuses any line or movement a match already claims — and that is what
 * keeps it out of Appendix D.2's `ConfirmReconciliation override` row. The
 * override (overruling a deterministic match) is HIGH_RISK and has no
 * ingress today; it arrives with PR-028's confirmation UI.
 */
import { bankRepo, outboxRepo, type TenantDb } from '@rekoda/db';
import type { BankStatementLine } from '@rekoda/core';

export interface IngestFinancialTransactionsInput {
  businessId: string;
  lines: readonly (BankStatementLine & { externalTransactionId?: string | null })[];
  actor: string;
  /** Which door: `csv_upload` | `bank_feed`. Telemetry, never trust. */
  source: string;
  /** §22.3 (PR-073): the feed connection the lines came through, so each
   * line carries connection-scoped identity. Absent for uploads. */
  connectionId?: string | null;
}

export type IngestedTransactions = Awaited<ReturnType<typeof bankRepo.importStatementLines>>;

export async function ingestFinancialTransactionsWork(
  tx: TenantDb,
  input: IngestFinancialTransactionsInput,
): Promise<IngestedTransactions> {
  const stored = await bankRepo.importStatementLines(tx, {
    businessId: input.businessId,
    lines: input.lines,
    actor: input.actor,
    connectionId: input.connectionId ?? null,
  });

  /* Announced only when something actually landed: an import that was all
   * duplicates changed nothing, and an event about nothing is noise a
   * consumer has to learn to ignore. */
  if (stored.imported > 0) {
    await outboxRepo.append(tx, {
      businessId: input.businessId,
      type: 'financial_transactions.ingested',
      payload: {
        imported: stored.imported,
        duplicates: stored.duplicates,
        source: input.source,
      },
    });
  }

  return stored;
}

export type ConfirmReconciliationInput = Parameters<typeof bankRepo.matchByHand>[1];
export type ReconciliationOutcome = Awaited<ReturnType<typeof bankRepo.matchByHand>>;

export async function confirmReconciliationWork(
  tx: TenantDb,
  input: ConfirmReconciliationInput,
): Promise<ReconciliationOutcome> {
  const outcome = await bankRepo.matchByHand(tx, input);

  if (outcome.outcome === 'matched') {
    await outboxRepo.append(tx, {
      businessId: input.businessId,
      type: 'reconciliation.confirmed',
      payload: { lineId: input.lineId, transactionId: input.transactionId },
    });
  }

  return outcome;
}

/* ── classification (spec §22.2; B1, PR-076) ─────────────────────────────
 * "The merchant may classify a line as owner capital, a loan, a supplier
 * refund, an internal transfer, or anything else. Rekoda never makes
 * that judgement silently." The classify door is the §22.2 WHEN made a
 * surface: ONE transaction that posts the journal the merchant's
 * judgement implies and pairs it with the line, through the same two §25
 * commands a person doing it by hand would use — PostJournal, then
 * ConfirmReconciliation — so the audit trail reads identically either
 * way. "Anything else" stays the general journal-plus-pair flow; LOAN is
 * deliberately absent because the fixed V1 chart (ADR 0004) has no
 * borrowings account, and arrives with F2's chart extensions. */

export const CLASSIFICATIONS = {
  /** Money the owner put in (or drew out): equity, never revenue. */
  OWNER_CAPITAL: { account: 'OWNERS_EQUITY', label: 'Owner capital' },
  /** A supplier handing money back: an expense reduction, never income. */
  SUPPLIER_REFUND: { account: 'EXPENSES', label: 'Supplier refund' },
  /** The business's own cash crossing its own accounts. */
  INTERNAL_TRANSFER: { account: 'CASH', label: 'Cash transfer' },
} as const;

export type Classification = keyof typeof CLASSIFICATIONS;

export interface ClassifyLineInput {
  businessId: string;
  lineId: string;
  classification: Classification;
  /** The merchant's own words, riding into the memo and the reason. */
  note?: string | null;
  actor: string;
}

export type ClassificationPrepared =
  | {
      outcome: 'ready';
      journal: {
        businessId: string;
        actor: string;
        memo: string;
        amountK: number;
        intoAccount: 'BANK' | 'OWNERS_EQUITY' | 'EXPENSES' | 'CASH';
        outOfAccount: 'BANK' | 'OWNERS_EQUITY' | 'EXPENSES' | 'CASH';
        occurredAt: Date;
      };
      reason: string;
    }
  | { outcome: 'refused'; reason: 'no_such_line' | 'line_already_matched' };

/**
 * Everything decided BEFORE anything is written: which journal the
 * classification implies (direction follows the line's sign), dated the
 * day the bank says the money moved, and the tier-4 reason that will sit
 * on the match. Refusals are read-only.
 */
export async function prepareClassification(
  tx: TenantDb,
  input: ClassifyLineInput,
): Promise<ClassificationPrepared> {
  const line = await bankRepo.lineFor(tx, input.businessId, input.lineId);
  if (!line) return { outcome: 'refused', reason: 'no_such_line' };
  if (line.matched) return { outcome: 'refused', reason: 'line_already_matched' };

  const spec = CLASSIFICATIONS[input.classification];
  const note = input.note?.trim() ?? '';
  return {
    outcome: 'ready',
    journal: {
      businessId: input.businessId,
      actor: input.actor,
      memo: note ? `${spec.label}: ${note}` : spec.label,
      amountK: Math.abs(line.amountK),
      intoAccount: line.amountK > 0 ? 'BANK' : spec.account,
      outOfAccount: line.amountK > 0 ? spec.account : 'BANK',
      /* The line's own day: the classification is ABOUT that movement. */
      occurredAt: new Date(`${line.postedOn}T12:00:00+01:00`),
    },
    reason: note
      ? `Classified as ${spec.label.toLowerCase()}: ${note}`
      : `Classified as ${spec.label.toLowerCase()}`,
  };
}

/**
 * The pairing raced: something claimed the line or the posting between
 * the pre-check and the match. Thrown so the WHOLE classification rolls
 * back — a journal that exists without its line would be the silent
 * judgement §22.2 forbids, twice over.
 */
export class ClassificationRaced extends Error {
  constructor(public readonly refusal: string) {
    super(`classification raced: ${refusal}`);
  }
}
