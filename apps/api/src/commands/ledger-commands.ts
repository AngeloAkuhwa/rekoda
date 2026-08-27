/**
 * The ledger commands (spec §25; PR-024): `PostJournal`, `ClosePeriod`.
 *
 * Same pattern as PR-021/022/023: the work the dashboard held inline, moved
 * to the one place every front door converges; both flag positions call the
 * same function.
 *
 * One deliberate asymmetry in error shape. `ClosePeriod` answers in
 * outcomes (`closed` / `not_ended` / `already_closed`) because its refusals
 * write nothing, so the idempotency claim may complete beside them.
 * `PostJournal` THROWS `PeriodClosed`, on purpose: the journal number is
 * minted before the period gate fires, and returning an outcome would
 * commit the counter bump for an entry that never posted — a hole in the
 * dense numbering. The throw rolls the whole transaction back, claim and
 * counter included, which is exactly §26's promise.
 *
 * `ReopenAccountingPeriod` (PR-028) is the dashboard's first HIGH_RISK
 * command: reported figures become movable again, so the endpoint runs the
 * two-step Appendix D demands — the first call opens a confirmation naming
 * the consequence, the second claims it through the bus and reopens.
 */
import { closeRepo, journalRepo, outboxRepo, type TenantDb } from '@rekoda/db';

export type PostJournalInput = Parameters<typeof journalRepo.recordJournal>[1];
export type JournalPosted = Awaited<ReturnType<typeof journalRepo.recordJournal>>;

export async function postJournalWork(
  tx: TenantDb,
  input: PostJournalInput,
): Promise<JournalPosted> {
  const recorded = await journalRepo.recordJournal(tx, input);

  /* The memo stays out of the event for the same reason the expense
   * description does: a correction's prose can name a person; the
   * announcement needs the fact. */
  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'journal.posted',
    payload: {
      journalNumber: recorded.journalNumber,
      amountK: input.amountK,
      intoAccount: input.intoAccount,
      outOfAccount: input.outOfAccount,
    },
  });

  return recorded;
}

export interface ClosePeriodInput {
  businessId: string;
  /** `YYYY-MM`, the last month the statements may no longer change through. */
  through: string;
  actor: string;
}

export type ClosePeriodResult = Awaited<ReturnType<typeof closeRepo.closeBooks>>;

export async function closePeriodWork(
  tx: TenantDb,
  input: ClosePeriodInput,
): Promise<ClosePeriodResult> {
  const outcome = await closeRepo.closeBooks(tx, input);

  if (outcome.outcome === 'closed') {
    await outboxRepo.append(tx, {
      businessId: input.businessId,
      type: 'period.closed',
      payload: { through: outcome.through, actor: input.actor },
    });
  }

  return outcome;
}

export interface ReopenPeriodInput {
  businessId: string;
  /** `YYYY-MM`, the month to open back up (and everything after it). */
  from: string;
  actor: string;
}

export type ReopenPeriodResult = Awaited<ReturnType<typeof closeRepo.reopenBooks>>;

/**
 * Never refused, never quiet (§ the close's mirror): a merchant who must
 * correct a filed month can, and the audit trail plus the announcement say
 * so beside the close they undo.
 */
export async function reopenPeriodWork(
  tx: TenantDb,
  input: ReopenPeriodInput,
): Promise<ReopenPeriodResult> {
  const outcome = await closeRepo.reopenBooks(tx, input);

  if (outcome.outcome === 'reopened') {
    await outboxRepo.append(tx, {
      businessId: input.businessId,
      type: 'period.reopened',
      payload: { from: outcome.from, wasClosedThrough: outcome.wasClosedThrough },
    });
  }

  return outcome;
}
