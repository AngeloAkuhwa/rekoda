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
