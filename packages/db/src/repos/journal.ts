/**
 * A correction a merchant makes by hand.
 *
 * Every other posting in Rekoda is derived from a business event: a sale, a
 * payment, an expense, a delivery, a count. That is why the books have stayed
 * right without the merchant having to be an accountant, and it is also the
 * one thing an accountant looking at Rekoda asks for and does not find. Money
 * carried from the till to the bank, an amount that went to the wrong
 * account, an owner putting their own money in: all real, all ordinary, and
 * none of them a sale.
 *
 * Two sides and one amount rather than a list of lines. The shape makes an
 * unbalanced entry impossible instead of catching it after the fact, which
 * means the merchant is never asked to make anything balance. What it cannot
 * express is a genuine multi-line journal, and that is a real limit rather
 * than an oversight: the accounts a trader can reach are ten, and every
 * correction those ten can describe is a movement between two of them.
 *
 * Marked in the ledger as `journal` so nothing downstream mistakes it for a
 * business event. The revenue schedule, the expense schedule and the audit
 * trail all read source type, and a hand written entry that looked like a
 * sale would be worse than no entry at all.
 */
import { lagosYear, postJournal, type AccountKey } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { auditEvents } from '../schema/ops.js';
import { nextDocumentNumber, writePosting } from './issue.js';

/** What the ledger calls an entry a person wrote rather than an event. */
export const JOURNAL_SOURCE = 'journal';

export interface JournalInput {
  businessId: string;
  /** Why. Required, because an entry nobody can explain is the one that hurts. */
  memo: string;
  amountK: number;
  /** Debited: what gains. */
  intoAccount: AccountKey;
  /** Credited: what gives it up. */
  outOfAccount: AccountKey;
  /**
   * When it happened, if that is not now.
   *
   * A correction to a month still open belongs in that month. One aimed at a
   * closed month is refused by the ledger's own trigger (migration 0034)
   * rather than by anything here.
   */
  occurredAt?: Date;
  actor: string;
}

export interface JournalRecorded {
  journalNumber: string;
  ledgerTransactionId: string;
}

export async function recordJournal(tx: TenantDb, input: JournalInput): Promise<JournalRecorded> {
  const at = input.occurredAt ?? new Date();
  /* Throws on a zero or negative amount and on both sides being the same
   * account, before anything is written and before a number is taken. */
  const posting = postJournal({
    memo: input.memo,
    amountK: input.amountK,
    intoAccount: input.intoAccount,
    outOfAccount: input.outOfAccount,
  });

  const journalNumber = await nextDocumentNumber(tx, input.businessId, 'journal', lagosYear(at));
  const ledgerTransactionId = await writePosting(
    tx,
    input.businessId,
    { ...posting, memo: `${journalNumber}: ${input.memo}` },
    JOURNAL_SOURCE,
    journalNumber,
    { occurredAt: at },
  );

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'journal',
    entityId: journalNumber,
    action: 'recorded',
    newValue: {
      journalNumber,
      memo: input.memo,
      amountK: input.amountK,
      intoAccount: input.intoAccount,
      outOfAccount: input.outOfAccount,
    } as never,
    sourceType: 'dashboard',
  });

  return { journalNumber, ledgerTransactionId };
}
