/**
 * Schedules for costs that repeat, and the claim that stops them repeating
 * twice.
 *
 * The reading half is ordinary. The writing half has exactly one hard part:
 * a sweep must raise today's rent once, no matter how many times it runs or
 * how many processes run it, and it must not skip a month because a process
 * died halfway through. `claimDue` is that guarantee, and everything else
 * here is plumbing around it.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { recurringEntries } from '../schema/finance.js';

export interface CreateScheduleInput {
  businessId: string;
  description: string;
  category: string | null;
  amountK: number;
  method: 'cash' | 'transfer';
  /** 1 to 31, validated by the caller and by a CHECK constraint. */
  anchorDay: number;
  /** The first day it should raise, `YYYY-MM-DD` in Lagos. */
  firstDueOn: string;
}

export interface Schedule {
  id: string;
  description: string;
  category: string | null;
  amountK: number;
  method: string;
  anchorDay: number;
  nextDueOn: string;
  lastRaisedOn: string | null;
  active: boolean;
}

export async function createSchedule(tx: TenantDb, input: CreateScheduleInput): Promise<string> {
  const rows = await tx
    .insert(recurringEntries)
    .values({
      businessId: input.businessId,
      description: input.description,
      category: input.category,
      amountK: input.amountK,
      method: input.method,
      anchorDay: input.anchorDay,
      nextDueOn: input.firstDueOn,
    })
    .returning({ id: recurringEntries.id });
  const row = rows[0];
  if (!row) throw new Error('createSchedule: insert returned no row');
  return row.id;
}

/** Every schedule this business has, running or stopped, newest first. */
export async function schedulesFor(tx: TenantDb, businessId: string): Promise<Schedule[]> {
  const rows = await tx
    .select({
      id: recurringEntries.id,
      description: recurringEntries.description,
      category: recurringEntries.category,
      amountK: recurringEntries.amountK,
      method: recurringEntries.method,
      anchorDay: recurringEntries.anchorDay,
      nextDueOn: recurringEntries.nextDueOn,
      lastRaisedOn: recurringEntries.lastRaisedOn,
      active: recurringEntries.active,
    })
    .from(recurringEntries)
    .where(eq(recurringEntries.businessId, businessId))
    .orderBy(desc(recurringEntries.createdAt));

  return rows.map((r) => ({ ...r, amountK: Number(r.amountK) }));
}

export type StopOutcome = 'stopped' | 'already_stopped' | 'not_found';

/**
 * Stop a schedule raising anything further.
 *
 * Not a delete. The entries it already raised are real expenses in a ledger
 * that is append-only, and a merchant reading "rent, monthly" beside them six
 * months later is the explanation of where they came from.
 */
export async function stopSchedule(
  tx: TenantDb,
  businessId: string,
  id: string,
): Promise<StopOutcome> {
  const stopped = await tx
    .update(recurringEntries)
    .set({ active: false, updatedAt: new Date() })
    .where(
      and(
        eq(recurringEntries.businessId, businessId),
        eq(recurringEntries.id, id),
        eq(recurringEntries.active, true),
      ),
    )
    .returning({ id: recurringEntries.id });
  if (stopped.length === 1) return 'stopped';

  const existing = await tx
    .select({ id: recurringEntries.id })
    .from(recurringEntries)
    .where(and(eq(recurringEntries.businessId, businessId), eq(recurringEntries.id, id)))
    .limit(1);
  return existing.length === 1 ? 'already_stopped' : 'not_found';
}

export interface DueSchedule extends Schedule {
  businessId: string;
}

interface RawDue extends Record<string, unknown> {
  id: string;
  business_id: string;
  description: string;
  category: string | null;
  amount_k: string | number;
  method: string;
  anchor_day: number;
  next_due_on: string;
  last_raised_on: string | null;
}

/**
 * What is due today, across every tenant.
 *
 * The worker credential, because "whose rent is due" names no business: the
 * sweep cannot pin a tenant it has not read yet. That credential can SELECT
 * this table and nothing else on it, so what it buys is the question. Every
 * answer is written back under `rekoda_app`, pinned.
 *
 * `<=`, not `=`. A sweep that did not run for two days must still raise what
 * it missed rather than skipping it, and `claimDue` advances the schedule one
 * month per raise so a long outage catches up rather than collapsing months
 * into one entry.
 */
export async function dueSchedules(db: Db, today: string, limit = 500): Promise<DueSchedule[]> {
  const rows = await db.execute<RawDue>(sql`
    SELECT id, business_id, description, category, amount_k, method,
           anchor_day, next_due_on::text AS next_due_on,
           last_raised_on::text AS last_raised_on
    FROM recurring_entries
    WHERE active
      AND next_due_on <= ${today}::date
    ORDER BY next_due_on
    LIMIT ${limit}
  `);

  return [...rows].map((r) => ({
    id: r.id,
    businessId: r.business_id,
    description: r.description,
    category: r.category,
    amountK: Number(r.amount_k),
    method: r.method,
    anchorDay: r.anchor_day,
    nextDueOn: r.next_due_on,
    lastRaisedOn: r.last_raised_on,
    active: true,
  }));
}

/**
 * Take today's raise, or find somebody else already took it.
 *
 * Called FIRST, inside the same transaction as the expense it authorises, and
 * the order is the whole design. `next_due_on <= today` in the WHERE is the
 * mutual exclusion: the row read a moment ago settles nothing, because two
 * sweeps both read the same due date before either writes. Only this UPDATE
 * decides, and only its winner may record an expense. Raising the entry first
 * and claiming second would leave the loser's expense standing in a ledger
 * that cannot delete it.
 *
 * `last_raised_on` is not part of the WHERE. It is a record of what happened,
 * and making it the guard as well would mean a schedule that fell due twice
 * in a catch-up sweep could only ever raise the first of them.
 */
export async function claimDue(
  tx: TenantDb,
  businessId: string,
  id: string,
  today: string,
  nextDueOn: string,
): Promise<boolean> {
  const claimed = await tx
    .update(recurringEntries)
    .set({ nextDueOn, lastRaisedOn: today, updatedAt: new Date() })
    .where(
      and(
        eq(recurringEntries.businessId, businessId),
        eq(recurringEntries.id, id),
        eq(recurringEntries.active, true),
        sql`${recurringEntries.nextDueOn} <= ${today}::date`,
      ),
    )
    .returning({ id: recurringEntries.id });
  return claimed.length === 1;
}
