/**
 * Closing a month, so a statement somebody already sent cannot change.
 *
 * The four statements are a file a merchant hands to a bank, a landlord or a
 * grant officer. Until this existed, nothing stopped a posting landing in a
 * month that had already been reported: an expense carries the day it was
 * paid, a recurring entry the day it fell due, and opening balances the
 * merchant's own date. September could change in October, and neither copy
 * would say so.
 *
 * The refusal itself lives in the database (migration 0034, reading
 * `accounting_periods` since 0067), not here. A
 * check the writer is trusted to make is exactly the weaker thing a close is
 * meant to replace. What lives here is the friendly path: read the watermark
 * before writing, so an ordinary refusal is an outcome rather than a poisoned
 * transaction.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { usagePeriod } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { accountingPeriods } from '../schema/finance.js';
import { auditEvents } from '../schema/ops.js';

/**
 * Thrown rather than returned, for the reason `OpeningBalancesAlreadySet`
 * records: the trigger raises, which aborts the PostgreSQL transaction, so a
 * caller that caught it and returned an outcome would fail at the COMMIT
 * instead, from somewhere with no context left to explain it.
 */
export class PeriodClosed extends Error {
  constructor(
    readonly closedThrough: string,
    readonly fallsIn: string,
  ) {
    super(`books are closed through ${closedThrough} and this entry falls in ${fallsIn}`);
  }
}

/** The Lagos month a posting belongs to. Lagos is UTC+1 all year. */
export const periodOf = (at: Date): string => usagePeriod(at);

/**
 * The watermark, DERIVED (PR-036): the latest month with a closed period
 * row. One fact a merchant can hold in their head, now computed from the
 * rows that also know when each month closed and who closed it.
 */
export async function booksClosedThroughFor(
  tx: TenantDb,
  businessId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ through: sql<string | null>`max(${accountingPeriods.period})` })
    .from(accountingPeriods)
    .where(
      and(eq(accountingPeriods.businessId, businessId), eq(accountingPeriods.status, 'closed')),
    );
  return rows[0]?.through ?? null;
}

/** Every period row, newest first — the record behind the watermark. */
export async function periodsFor(
  tx: TenantDb,
  businessId: string,
): Promise<
  Array<{
    period: string;
    status: string;
    closedAt: Date;
    closedBy: string;
    reopenedAt: Date | null;
    reopenedBy: string | null;
  }>
> {
  const rows = await tx
    .select({
      period: accountingPeriods.period,
      status: accountingPeriods.status,
      closedAt: accountingPeriods.closedAt,
      closedBy: accountingPeriods.closedBy,
      reopenedAt: accountingPeriods.reopenedAt,
      reopenedBy: accountingPeriods.reopenedBy,
    })
    .from(accountingPeriods)
    .where(eq(accountingPeriods.businessId, businessId));
  return rows.sort((a, b) => (a.period < b.period ? 1 : -1));
}

/**
 * Refuse before writing anything, when the caller can still be told why.
 *
 * Called from `writePosting`, which is the one place every posting in the
 * system passes through. The trigger behind it is the guarantee; this is the
 * good error message.
 */
export async function assertPeriodOpen(tx: TenantDb, businessId: string, at: Date): Promise<void> {
  const closedThrough = await booksClosedThroughFor(tx, businessId);
  if (closedThrough === null) return;
  const fallsIn = periodOf(at);
  if (fallsIn <= closedThrough) throw new PeriodClosed(closedThrough, fallsIn);
}

export type CloseOutcome =
  | { outcome: 'closed'; through: string }
  | { outcome: 'not_ended' }
  | { outcome: 'already_closed'; through: string };

/**
 * Close through a month that has ended.
 *
 * The current month is refused because it can still legitimately receive
 * postings, and that refusal is what keeps the blast radius honest: every
 * live posting is stamped now, now is always the current month, so nothing a
 * merchant does today can ever meet this guard. Only a backdated entry can,
 * which is precisely the entry a close exists to stop.
 *
 * Closing earlier than the existing watermark is refused rather than obeyed.
 * "Closed through August" already means July is closed, so a request to close
 * through July is somebody expecting the books to open, and quietly doing
 * nothing would look like it worked.
 */
export async function closeBooks(
  tx: TenantDb,
  input: { businessId: string; through: string; actor: string; now?: Date },
): Promise<CloseOutcome> {
  const current = periodOf(input.now ?? new Date());
  if (input.through >= current) return { outcome: 'not_ended' };

  const existing = await booksClosedThroughFor(tx, input.businessId);
  if (existing !== null && input.through <= existing) {
    return { outcome: 'already_closed', through: existing };
  }

  /* One row per month being closed: from the month after the watermark, or
   * from the business's earliest ledger activity on a first close (a
   * business with no postings still keeps its close — the target month
   * alone). The old compare-and-set race is structurally gone: closing only
   * ever ADDS closed rows, so two concurrent closes commute, and the
   * later-through one simply owns the extra months. Re-closing a reopened
   * month rehabilitates its row rather than minting a second. */
  let start: string;
  if (existing !== null) {
    start = monthAfter(existing);
  } else {
    const firstRows = await tx.execute<{ p: string | null }>(sql`
      SELECT to_char(MIN(t.created_at AT TIME ZONE 'Africa/Lagos'), 'YYYY-MM') AS p
      FROM ledger_transactions t
      WHERE t.business_id = ${input.businessId}::uuid
    `);
    const first = [...firstRows][0]?.p ?? null;
    start = first !== null && first < input.through ? first : input.through;
  }

  const months: string[] = [];
  for (let m = start; m <= input.through; m = monthAfter(m)) months.push(m);
  await tx
    .insert(accountingPeriods)
    .values(
      months.map((period) => ({
        businessId: input.businessId,
        period,
        status: 'closed',
        closedBy: input.actor,
      })),
    )
    .onConflictDoUpdate({
      target: [accountingPeriods.businessId, accountingPeriods.period],
      set: {
        status: 'closed',
        closedAt: sql`now()`,
        closedBy: input.actor,
        reopenedAt: null,
        reopenedBy: null,
      },
    });

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'books',
    entityId: input.through,
    action: 'closed',
    ...(existing === null ? {} : { oldValue: { through: existing } as never }),
    newValue: { through: input.through } as never,
    sourceType: 'dashboard',
  });

  return { outcome: 'closed', through: input.through };
}

export type ReopenOutcome =
  { outcome: 'reopened'; from: string; wasClosedThrough: string } | { outcome: 'already_open' };

/**
 * Open a closed month back up, and say so out loud.
 *
 * Never refused. A merchant who has to correct a filed month must be able to,
 * and a lock with no key is a support ticket rather than a control. What it
 * is not is quiet: reopening lands in the audit trail beside the close it
 * undoes, which is the honest version of this trade.
 *
 * `from` is the earliest month to reopen, and the watermark moves to the
 * month before it. So reopening July when the books are closed through
 * September reopens August and September too, which is the only coherent
 * reading: a single watermark cannot express "July open, August closed", and
 * pretending otherwise would need a second way to say what is closed.
 */
export async function reopenBooks(
  tx: TenantDb,
  input: { businessId: string; from: string; actor: string },
): Promise<ReopenOutcome> {
  const existing = await booksClosedThroughFor(tx, input.businessId);
  if (existing === null || input.from > existing) return { outcome: 'already_open' };

  /* Flip, never delete: a reopened month keeps its row, its original close
   * and now its reopening, which is the honest version of this trade. */
  await tx
    .update(accountingPeriods)
    .set({ status: 'open', reopenedAt: sql`now()`, reopenedBy: input.actor })
    .where(
      and(
        eq(accountingPeriods.businessId, input.businessId),
        gte(accountingPeriods.period, input.from),
        eq(accountingPeriods.status, 'closed'),
      ),
    );

  /* The surviving frontier, materialised. "Closed through May" protected
   * every month at or before May whether or not it had a row; reopening
   * from March splits that range, and February's protection must not
   * depend on February having had activity. If no closed row already
   * marks the month before `from`, one is written now — the remnant of
   * the close being partially undone. */
  const back = monthBefore(input.from);
  const remaining = await booksClosedThroughFor(tx, input.businessId);
  if (remaining === null || remaining < back) {
    await tx
      .insert(accountingPeriods)
      .values({
        businessId: input.businessId,
        period: back,
        status: 'closed',
        closedBy: input.actor,
      })
      .onConflictDoNothing();
  }

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'books',
    entityId: input.from,
    action: 'reopened',
    oldValue: { through: existing } as never,
    newValue: { through: back } as never,
    sourceType: 'dashboard',
  });

  return { outcome: 'reopened', from: input.from, wasClosedThrough: existing };
}

/** The Lagos month after a period. */
function monthAfter(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  if (month < 12) return `${year}-${String(month + 1).padStart(2, '0')}`;
  return `${year + 1}-01`;
}

/** The Lagos month before a period. */
function monthBefore(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  if (month > 1) return `${year}-${String(month - 1).padStart(2, '0')}`;
  return `${year - 1}-12`;
}
