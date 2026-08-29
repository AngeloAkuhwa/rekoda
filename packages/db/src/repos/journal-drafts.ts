/**
 * The editable half of the journal model (spec §9.1, §9.2; PR-041).
 *
 * A draft is a proposal. It cites chart accounts directly — any account of
 * the business's chart, not only the seventeen-key vocabulary — may be
 * edited in place, and becomes books only through `postJournalDraft`:
 * validate, one atomic INSERT into the authoritative pair, immutable
 * forever. The database backs every validation here with its own (0070's
 * shape triggers, 0066's active-account gate, the period triggers), so a
 * writer that skips this function changes nothing about what can exist.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import {
  journalDraftLines,
  journalDrafts,
  ledgerEntries,
  ledgerTransactions,
} from '../schema/finance.js';
import { assertPeriodOpen } from './close.js';

export interface DraftLineInput {
  accountId: string;
  debitK: number;
  creditK: number;
}

export interface JournalDraftRow {
  id: string;
  memo: string;
  createdBy: string;
  postedJournalId: string | null;
  lines: Array<{ id: string; accountId: string; debitK: number; creditK: number }>;
}

function validateLines(lines: readonly DraftLineInput[]): string | null {
  if (lines.length < 2) return 'a journal needs at least two lines';
  let debits = 0;
  let credits = 0;
  for (const line of lines) {
    if (line.debitK < 0 || line.creditK < 0) return 'amounts cannot be negative';
    if ((line.debitK === 0) === (line.creditK === 0)) {
      return 'each line carries exactly one of debit or credit';
    }
    debits += line.debitK;
    credits += line.creditK;
  }
  if (debits !== credits || debits === 0) {
    return `debits ${debits} and credits ${credits} must match and be more than zero`;
  }
  return null;
}

export async function createJournalDraft(
  tx: TenantDb,
  input: { businessId: string; memo: string; createdBy: string; lines: DraftLineInput[] },
): Promise<{ id: string }> {
  const rows = await tx
    .insert(journalDrafts)
    .values({ businessId: input.businessId, memo: input.memo, createdBy: input.createdBy })
    .returning({ id: journalDrafts.id });
  const draft = rows[0];
  if (!draft) throw new Error('createJournalDraft: insert returned no row');
  if (input.lines.length > 0) {
    await tx.insert(journalDraftLines).values(
      input.lines.map((line, position) => ({
        businessId: input.businessId,
        draftId: draft.id,
        accountId: line.accountId,
        debitK: line.debitK,
        creditK: line.creditK,
        position,
      })),
    );
  }
  return draft;
}

/** Replace a draft wholesale: memo and lines. The editable pair, edited. */
export async function reviseJournalDraft(
  tx: TenantDb,
  input: { businessId: string; draftId: string; memo?: string; lines?: DraftLineInput[] },
): Promise<'revised' | 'not_found'> {
  const found = await tx
    .select({ id: journalDrafts.id })
    .from(journalDrafts)
    .where(and(eq(journalDrafts.businessId, input.businessId), eq(journalDrafts.id, input.draftId)))
    .limit(1);
  if (!found[0]) return 'not_found';
  if (input.memo !== undefined) {
    await tx
      .update(journalDrafts)
      .set({ memo: input.memo, updatedAt: sql`now()` })
      .where(
        and(eq(journalDrafts.businessId, input.businessId), eq(journalDrafts.id, input.draftId)),
      );
  }
  if (input.lines) {
    await tx
      .delete(journalDraftLines)
      .where(
        and(
          eq(journalDraftLines.businessId, input.businessId),
          eq(journalDraftLines.draftId, input.draftId),
        ),
      );
    if (input.lines.length > 0) {
      await tx.insert(journalDraftLines).values(
        input.lines.map((line, position) => ({
          businessId: input.businessId,
          draftId: input.draftId,
          accountId: line.accountId,
          debitK: line.debitK,
          creditK: line.creditK,
          position,
        })),
      );
    }
  }
  return 'revised';
}

export async function journalDraftById(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<JournalDraftRow | null> {
  const drafts = await tx
    .select()
    .from(journalDrafts)
    .where(and(eq(journalDrafts.businessId, businessId), eq(journalDrafts.id, draftId)))
    .limit(1);
  const draft = drafts[0];
  if (!draft) return null;
  const lines = await tx
    .select({
      id: journalDraftLines.id,
      accountId: journalDraftLines.accountId,
      debitK: journalDraftLines.debitK,
      creditK: journalDraftLines.creditK,
    })
    .from(journalDraftLines)
    .where(
      and(eq(journalDraftLines.businessId, businessId), eq(journalDraftLines.draftId, draftId)),
    )
    .orderBy(asc(journalDraftLines.position));
  return {
    id: draft.id,
    memo: draft.memo,
    createdBy: draft.createdBy,
    postedJournalId: draft.postedJournalId,
    lines,
  };
}

/**
 * The trail for one-step flows (the dashboard's simple journal form):
 * entry and approval are the same act, so the draft is born already
 * posted, recording exactly what was approved beside what was booked.
 */
export async function recordPostedDraft(
  tx: TenantDb,
  input: {
    businessId: string;
    memo: string;
    createdBy: string;
    postedJournalId: string;
    lines: DraftLineInput[];
  },
): Promise<{ id: string }> {
  /* Lines land BEFORE the claim: 0073's lock admits edits only while
   * `posted_journal_id` is null, and being born posted is still a birth. */
  const rows = await tx
    .insert(journalDrafts)
    .values({
      businessId: input.businessId,
      memo: input.memo,
      createdBy: input.createdBy,
    })
    .returning({ id: journalDrafts.id });
  const draft = rows[0];
  if (!draft) throw new Error('recordPostedDraft: insert returned no row');
  await tx.insert(journalDraftLines).values(
    input.lines.map((line, position) => ({
      businessId: input.businessId,
      draftId: draft.id,
      accountId: line.accountId,
      debitK: line.debitK,
      creditK: line.creditK,
      position,
    })),
  );
  await tx
    .update(journalDrafts)
    .set({ postedJournalId: input.postedJournalId })
    .where(and(eq(journalDrafts.businessId, input.businessId), eq(journalDrafts.id, draft.id)));
  return draft;
}

export type PostDraftOutcome =
  | { outcome: 'posted'; ledgerTransactionId: string }
  | { outcome: 'not_found' }
  | { outcome: 'already_posted'; ledgerTransactionId: string }
  /* A refusal that wrote nothing: the draft stays editable. */
  | { outcome: 'invalid'; reason: string };

/**
 * §9.2: validate → atomic INSERT → immutable forever.
 *
 * The compare-and-set on `posted_journal_id IS NULL` plus its partial
 * unique means a draft posts exactly once whatever races; the posting_key
 * backs that at the ledger itself (§9.4's postingKey).
 */
export async function postJournalDraft(
  tx: TenantDb,
  input: { businessId: string; draftId: string; actor: string; occurredAt?: Date },
): Promise<PostDraftOutcome> {
  const draft = await journalDraftById(tx, input.businessId, input.draftId);
  if (!draft) return { outcome: 'not_found' };
  if (draft.postedJournalId !== null) {
    return { outcome: 'already_posted', ledgerTransactionId: draft.postedJournalId };
  }
  const invalid = validateLines(draft.lines);
  if (invalid) return { outcome: 'invalid', reason: invalid };

  const at = input.occurredAt ?? new Date();
  /* The good error message; the trigger behind it is the guarantee. */
  await assertPeriodOpen(tx, input.businessId, at);

  const inserted = await tx
    .insert(ledgerTransactions)
    .values({
      businessId: input.businessId,
      memo: draft.memo,
      sourceType: 'journal_draft',
      sourceId: draft.id,
      postingKey: `journal-draft:${draft.id}`,
      ...(input.occurredAt ? { createdAt: input.occurredAt } : {}),
    })
    .returning({ id: ledgerTransactions.id });
  const posted = inserted[0];
  if (!posted) throw new Error('postJournalDraft: transaction insert returned no row');

  await tx.insert(ledgerEntries).values(
    draft.lines.map((line) => ({
      businessId: input.businessId,
      transactionId: posted.id,
      accountId: line.accountId,
      debitK: line.debitK,
      creditK: line.creditK,
      transactionAmountMinor: line.debitK + line.creditK,
      ...(input.occurredAt ? { createdAt: input.occurredAt } : {}),
    })),
  );

  const claimed = await tx
    .update(journalDrafts)
    .set({ postedJournalId: posted.id, updatedAt: sql`now()` })
    .where(
      and(
        eq(journalDrafts.businessId, input.businessId),
        eq(journalDrafts.id, input.draftId),
        isNull(journalDrafts.postedJournalId),
      ),
    )
    .returning({ id: journalDrafts.id });
  if (claimed.length === 0) {
    /* A concurrent post won the claim; this transaction's rows roll back
     * with the throw, so no second entry survives. */
    throw new Error('postJournalDraft: draft was posted concurrently');
  }
  return { outcome: 'posted', ledgerTransactionId: posted.id };
}
