/**
 * The usage meter's SQL (docs/metering-v1.md §2).
 *
 * One operation matters: consume. It is a SINGLE statement whose WHERE
 * clause carries the precondition, the same race-proof shape as document
 * numbering and the draft claim — two simultaneous messages cannot both take
 * the last unit, because the database picks the winner and the loser gets
 * zero rows back. There is no path that increments without checking and no
 * path that checks without incrementing.
 *
 * The allowance arrives as an argument (from `@rekoda/core`'s plan table)
 * rather than living here, so the decision stays in core and this file stays
 * SQL. `bonus` raises the ceiling and is written by exactly one function,
 * `creditBonus`, whose only caller is a subscription charge the provider has
 * confirmed.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

export type { UsageUnit } from '@rekoda/core';
import { INDEPENDENTLY_METERED_UNITS, type UsageUnit } from '@rekoda/core';

/**
 * The meter row a unit is spent on (G-109, OWN-27, OD-26).
 *
 * A paid business meters by calendar month. A business still on the trial
 * meters its BASE-PLAN units on ONE fixed row for the whole trial, whatever
 * month the caller names: the trial is one 14-day budget, so a trial that
 * crosses a month boundary does not earn a second allowance, and the row is
 * left behind when the first paid plan lands, so trial usage never carries
 * into the paid month. The units a standalone holding sells
 * (`INDEPENDENTLY_METERED_UNITS`, the Developer API Starter) follow that
 * holding's own monthly cycle whatever the base plan is.
 *
 * A row is named by this brand so a refund cannot be given a calendar month
 * by mistake: the only ways to hold one are a consume's answer, a stored
 * record of one, and the two constructors below, which say what they are.
 */
export type MeterRow = string & { readonly __meterRow: unique symbol };

export const TRIAL_PERIOD = 'TRIAL00';
/** The one row a trial's base-plan units are spent on. */
export const TRIAL_METER = TRIAL_PERIOD as MeterRow;
/** A calendar-month row, for a paid business or a standalone holding's unit. */
export const monthMeter = (period: string): MeterRow => period as MeterRow;
/** A row read back from a stored reservation; a missing one was spent in its month. */
export const storedMeter = (stored: string | null | undefined, period: string): MeterRow =>
  (stored && stored.length > 0 ? stored : period) as MeterRow;

const independent = new Set<string>(INDEPENDENTLY_METERED_UNITS);

async function planOf(tx: TenantDb, businessId: string): Promise<string | undefined> {
  const rows = await tx.execute<{ plan: string }>(sql`
    SELECT plan FROM businesses WHERE id = ${businessId}::uuid
  `);
  return [...rows][0]?.plan;
}

/** The row `unit` is spent on now, for a business on `plan`. */
function meterOn(plan: string | undefined, period: string, unit: string): MeterRow {
  const trial = !plan || plan === 'trial';
  return trial && !independent.has(unit) ? TRIAL_METER : monthMeter(period);
}

/**
 * Spend `n` units, atomically, against `allowance + bonus`.
 * Returns whether the spend was GRANTED; a refusal means exhausted.
 */
export async function consumeUnit(
  tx: TenantDb,
  businessId: string,
  period: string,
  unit: UsageUnit,
  allowance: number,
  n = 1,
): Promise<boolean> {
  return (await reserveUnit(tx, businessId, period, unit, allowance, n)).granted;
}

/**
 * `consumeUnit`, also saying WHICH meter row the spend was taken from. A caller
 * that may give the unit back later keeps that row with the reservation and
 * hands it to `refundUnit`: a refund is never worked out from the plan the
 * business is on when it runs, which may not be the plan it was on when it
 * spent the unit.
 */
export async function reserveUnit(
  tx: TenantDb,
  businessId: string,
  period: string,
  unit: UsageUnit,
  allowance: number,
  n = 1,
): Promise<{ granted: boolean; meter: MeterRow }> {
  const meter = meterOn(await planOf(tx, businessId), period, unit);
  period = meter;
  /**
   * Both arms carry the ceiling. The SELECT's WHERE guards the FRESH-ROW
   * case (an allowance of zero, like orders on Chat, must refuse the
   * very first unit); the EXISTS keeps existing rows flowing to the
   * conflict arm, whose WHERE re-checks against `allowance + bonus` so a
   * billing top-up raises the ceiling without new SQL. Two concurrent
   * fresh-row consumers both pass the EXISTS=false path, one wins the
   * insert, and the loser is re-judged by the conflict arm — the database
   * decides, as everywhere else in this codebase.
   */
  /**
   * EVERY number is cast. This is not defensive decoration.
   *
   * `SELECT $1, $2 WHERE $3 <= $4` gives PostgreSQL no type context, so it
   * resolves the unknown parameters as TEXT and compares them as text. Text
   * says `'9' <= '600'` is FALSE, because it reads the nine before it reads
   * anything else. A merchant sending a nine-second voice note against a
   * six-hundred-second allowance was told they had used all six hundred.
   *
   * It hid for as long as it did because almost every consume spends ONE
   * unit, and `'1' <= '600'` happens to be true. It only bites where the
   * amount is a quantity rather than a tally, and where its first digit
   * sorts above the ceiling's: 7, 8, 9, 70 to 99, 700 upward. Voice is the
   * only unit that spends that way today, which is exactly where it
   * surfaced.
   */
  /* Written only by `usage_reserve` (migration 0209), which runs the single race-proof statement
   * above and journals the consumption, so a later release can give back only what was taken. The
   * application credential holds no INSERT or UPDATE on the counters. */
  const rows = await tx.execute<{ reservation: string | null }>(sql`
    SELECT usage_reserve(${businessId}::uuid, ${period}::text, ${unit}::text, ${allowance}::int,
      ${n}::int) AS reservation
  `);
  return { granted: [...rows][0]?.reservation != null, meter };
}

/**
 * Give a unit back, same transaction. For the paths where the consume
 * happened but no value was delivered (the daily ceiling refused the model,
 * the provider was down, the answer was unusable): the merchant's meter
 * must only move when the product actually worked. GREATEST guards the
 * floor; the CHECK constraint would reject a negative anyway.
 *
 * `meter` is the exact row the unit was spent on, as `reserveUnit` returned it
 * (or a stored reservation recorded it): exactly that row, never one chosen by
 * the current plan or by which counter has something to give back.
 */
export async function refundUnit(
  tx: TenantDb,
  businessId: string,
  meter: MeterRow,
  unit: UsageUnit,
  n = 1,
): Promise<boolean> {
  /* `usage_release` (0209) gives back units of a RECORDED consumption on exactly this row, once,
   * within 35 days; with none to give back it changes nothing and answers false (a release is never
   * a free decrement). */
  const rows = await tx.execute<{ released: boolean }>(sql`
    SELECT usage_release(${businessId}::uuid, ${meter}::text, ${unit}::text, ${n}::int) AS released
  `);
  return [...rows][0]?.released === true;
}

/**
 * Add bought capacity to this month's ceiling (ADR 0024's add-on packs).
 *
 * Separate from `used` and never netted against it, so the two questions stay
 * answerable apart: how much a merchant consumed, and how much they paid to
 * be allowed to. Netting would make a pack look like usage that never
 * happened.
 *
 * Called only after a provider has confirmed the charge, in the same
 * transaction that settles it. That transaction settles once, so this credits
 * once: there is no idempotency key here because there is no second call to
 * guard against.
 *
 * A trial business is never offered a pack (its price is 0), so a trial's base
 * units meet this only through a direct call; there the bonus is held on the
 * trial row with the rest of that unit's budget.
 *
 * The pack is spent in the month it is bought and does not roll over, which
 * is why the period is an argument and not derived: the caller passes the
 * period the charge covers.
 */
export async function creditBonus(
  tx: TenantDb,
  businessId: string,
  period: string,
  unit: UsageUnit,
  n: number,
): Promise<void> {
  period = meterOn(await planOf(tx, businessId), period, unit);
  /* `usage_credit_bonus` (0209): settlement only. */
  await tx.execute(sql`
    SELECT usage_credit_bonus(${businessId}::uuid, ${period}::text, ${unit}::text, ${n}::int)
  `);
}

export interface UsageRow extends Record<string, unknown> {
  unit: string;
  used: number;
  bonus: number;
}

/** This month's meter, for the dashboard and the exhaustion messages. */
export async function usageFor(
  tx: TenantDb,
  businessId: string,
  period: string,
): Promise<UsageRow[]> {
  const plan = await planOf(tx, businessId);
  const trial = !plan || plan === 'trial';
  const independentList = sql.join(
    INDEPENDENTLY_METERED_UNITS.map((u) => sql`${u}`),
    sql`, `,
  );
  /* A trial reads its base-plan units from the trial row and the units a
   * standalone holding sells from the month, which is where they are spent. */
  const rows = await tx.execute<UsageRow>(
    trial
      ? sql`
    SELECT unit, used, bonus FROM usage_counters
    WHERE business_id = ${businessId}::uuid
      AND ((period = ${TRIAL_PERIOD} AND unit NOT IN (${independentList}))
        OR (period = ${period} AND unit IN (${independentList})))
    ORDER BY unit
  `
      : sql`
    SELECT unit, used, bonus FROM usage_counters
    WHERE business_id = ${businessId}::uuid AND period = ${period}
    ORDER BY unit
  `,
  );
  return [...rows];
}

/** The plan fields `planFor` and `lapseOf` judge, with the OD-49 rule's verdict on them. */
interface PlanRow extends Record<string, unknown> {
  plan: string;
  plan_expires_at: string | null;
  trial_started_at: string | null;
  nonconformity: string | null;
}

async function planRow(tx: TenantDb, businessId: string): Promise<PlanRow | undefined> {
  /* `subscription_nonconformity` (migration 0208) is the database's one statement of Rekoda's plan
   * durations; a row it names was written before 0203, or by hand, and grants nothing it should
   * not (OD-49). */
  const rows = await tx.execute<PlanRow>(sql`
    SELECT plan, plan_expires_at, trial_started_at,
           subscription_nonconformity(plan, plan_expires_at, cycle_started_at, billing_interval,
             trial_started_at, now()) AS nonconformity
    FROM businesses WHERE id = ${businessId}::uuid
  `);
  return [...rows][0];
}

/* 14 days, the trial's hard stop (0203: 336 hours from the business's own trial start). */
const TRIAL_MS = 336 * 3_600_000;

/**
 * Whether a row is past what it may grant. A conforming trial ends at its date. A NON-conforming
 * row (OD-49) grants no more than a conforming one could: a trial ends 14 days after its own start
 * whatever date it carries, and a paid plan that is open-ended, has no cycle start, or runs longer
 * than its interval grants nothing until an operator corrects it through the audited writer (the
 * release preflight refuses to start while such a row exists, so this is the fail-safe).
 */
function lapsed(row: PlanRow, now: Date): 'trial' | 'plan' | null {
  if (row.plan === 'expired') return 'plan';
  if (row.plan === 'trial') {
    const stored = row.plan_expires_at ? new Date(row.plan_expires_at).getTime() : null;
    const hardStop = row.trial_started_at
      ? new Date(row.trial_started_at).getTime() + TRIAL_MS
      : null;
    const ends = row.nonconformity
      ? hardStop === null
        ? -Infinity
        : stored === null
          ? hardStop
          : Math.min(stored, hardStop)
      : stored;
    if (ends !== null && ends <= now.getTime()) return 'trial';
    return null;
  }
  if (row.nonconformity) return 'plan';
  return null;
}

/**
 * The plan this business is on, read under the tenant pin — with the trial
 * clock applied.
 *
 * A lapsed trial answers `expired`, whose allowances are all zero, so the
 * gate refuses without needing a second concept. A conforming paid plan
 * whose date has slipped past keeps its allowances, because cutting off a
 * merchant who is paying us over a late billing job is the one failure this
 * file must never cause; the grace sweep is what lapses it. A paid row that
 * breaks Rekoda's plan durations (OD-49) answers `expired`: it was never a
 * period anyone paid for.
 */
export async function planFor(tx: TenantDb, businessId: string, now = new Date()): Promise<string> {
  const row = await planRow(tx, businessId);
  if (!row) return 'trial';
  return lapsed(row, now) ? 'expired' : row.plan;
}

/**
 * WHY `planFor` answers `expired`, for the sentence that says so (G-65).
 *
 * Two different facts read the same to the gate: a trial past its date
 * (stored as `trial`, the clock above makes it `expired`), and a paid plan
 * that lapsed, which the renewal path stores as `expired` itself. Telling a
 * merchant who paid for months that their "free trial has ended" is untrue,
 * so the reply asks. Null when the plan has not lapsed.
 */
export async function lapseOf(
  tx: TenantDb,
  businessId: string,
  now = new Date(),
): Promise<'trial' | 'plan' | null> {
  const row = await planRow(tx, businessId);
  if (!row) return null;
  return lapsed(row, now);
}
