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
 * The allowance arrives as an argument (from `@rekoda/core`'s plan table or
 * the catalogue), but it is no longer authoritative (migration 0222): the
 * database computes the business's own ceiling (`usage_entitlement`) and the
 * argument can only lower it, so a caller cannot spend more than the plan
 * sells by passing a larger number. `bonus` raises the ceiling and is written by exactly one function,
 * `creditBonus`, whose only caller is a subscription charge the provider has
 * confirmed.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

export type { UsageUnit } from '@rekoda/core';
import {
  INDEPENDENTLY_METERED_UNITS,
  periodBefore,
  usagePeriod,
  type UsageUnit,
} from '@rekoda/core';

/**
 * The meter row a unit is spent on (G-109, OWN-27, OD-26), and the reservation that spent it.
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
 * The value is a HANDLE, opaque to callers: `<row>` or, for a spend that may be given back,
 * `<row>#<reservation id>` (OD-51.4, migration 0216). The reservation is what a refund returns:
 * the database gives back at most what that one reservation spent, once, to the row it was spent
 * on. A handle with no reservation (a spend that was not refundable, or the two constructors
 * below) names a row but can return nothing. The only ways to hold one are a reserve's answer, a
 * stored record of one, and the constructors, which say what they are.
 */
export type MeterRow = string & { readonly __meterRow: unique symbol };

export const TRIAL_PERIOD = 'TRIAL00';
/** The one row a trial's base-plan units are spent on (a row name only: it can refund nothing). */
export const TRIAL_METER = TRIAL_PERIOD as MeterRow;
/** A calendar-month row, for a paid business or a standalone holding's unit (a row name only). */
export const monthMeter = (period: string): MeterRow => period as MeterRow;
/** A handle read back from a stored reservation; a missing one names the month (and refunds nothing). */
export const storedMeter = (stored: string | null | undefined, period: string): MeterRow =>
  (stored && stored.length > 0 ? stored : period) as MeterRow;

/** The counter row a handle names, without its reservation. */
export const meterRowOf = (meter: MeterRow): string => meter.split('#')[0] ?? meter;
/** The reservation a handle carries, or null for a bare row name. */
export const reservationOf = (meter: MeterRow): string | null => {
  const id = meter.split('#')[1];
  return id && id.length > 0 ? id : null;
};

const independent = new Set<string>(INDEPENDENTLY_METERED_UNITS);

async function planOf(tx: TenantDb, businessId: string): Promise<string | undefined> {
  const rows = await tx.execute<{ plan: string }>(sql`
    SELECT plan FROM businesses WHERE id = ${businessId}::uuid
  `);
  return [...rows][0]?.plan;
}

/**
 * The row `unit` is spent on now, for a business on `plan`: the same rule the database applies in
 * `rekoda_private.usage_meter_row` (migration 0222), which is the one that decides. A trial's
 * base-plan units go on the trial row. Otherwise the asked month is kept when it is the current
 * Africa/Lagos month, or the month before during a month's first seven days (a message that arrived
 * on the 31st and is processed after midnight is metered on the month it arrived in; the database
 * honours that only on a row last month already opened, and otherwise uses the current month); any
 * other label is metered on the current month, so no label can open a fresh allowance. The handle's
 * row is a label: a refund returns a reservation to the row the database recorded on it.
 */
function meterOn(
  plan: string | undefined,
  period: string,
  unit: string,
  now: Date = new Date(),
): MeterRow {
  const trial = !plan || plan === 'trial';
  if (trial && !independent.has(unit)) return TRIAL_METER;
  const current = usagePeriod(now);
  if (period === current) return monthMeter(current);
  const lagosDay = new Date(now.getTime() + 3_600_000).getUTCDate();
  if (period === periodBefore(current) && lagosDay <= 7) return monthMeter(period);
  return monthMeter(current);
}

/**
 * Spend `n` units, atomically, against `allowance + bonus`.
 * Returns whether the spend was GRANTED; a refusal means exhausted.
 *
 * For a spend that is never given back (an API request, a report export): no reservation is
 * recorded, so there is nothing a later call could return.
 */
export async function consumeUnit(
  tx: TenantDb,
  businessId: string,
  period: string,
  unit: UsageUnit,
  allowance: number,
  n = 1,
): Promise<boolean> {
  return (await spend(tx, businessId, period, unit, allowance, n, false)).granted;
}

/**
 * `consumeUnit`, also returning the HANDLE of the spend: the meter row it was taken from and the
 * reservation that took it. A caller that may give the unit back later keeps the handle (in memory
 * or on the message's event) and hands it to `refundUnit`: a refund is never worked out from the
 * plan the business is on when it runs, which may not be the plan it was on when it spent the
 * unit, and it can return only what this reservation spent.
 */
export async function reserveUnit(
  tx: TenantDb,
  businessId: string,
  period: string,
  unit: UsageUnit,
  allowance: number,
  n = 1,
): Promise<{ granted: boolean; meter: MeterRow }> {
  return spend(tx, businessId, period, unit, allowance, n, true);
}

/**
 * The one spend, through `usage_reserve` (OD-51.4, migration 0216): no runtime role writes
 * `usage_counters` directly any more. The function is the single statement this file used to
 * hold: its WHERE carries the ceiling, so two simultaneous messages cannot both take the last
 * unit, an allowance of zero refuses the very first unit, and a pack's `bonus` raises the ceiling
 * without new SQL. Every number is a typed parameter there, so `9 <= 600` is compared as numbers
 * (untyped, PostgreSQL compared them as text and refused a nine-second voice note against a
 * six-hundred-second allowance).
 */
async function spend(
  tx: TenantDb,
  businessId: string,
  period: string,
  unit: UsageUnit,
  allowance: number,
  n: number,
  refundable: boolean,
): Promise<{ granted: boolean; meter: MeterRow }> {
  const row = meterOn(await planOf(tx, businessId), period, unit);
  const rows = await tx.execute<{ granted: boolean; reservation: string | null }>(sql`
    SELECT granted, reservation FROM usage_reserve(
      ${businessId}::uuid, ${row}::text, ${unit}::text, ${allowance}::int, ${n}::int,
      ${refundable}::boolean)
  `);
  const answer = [...rows][0];
  if (!answer?.granted) return { granted: false, meter: row };
  return {
    granted: true,
    meter: (answer.reservation ? `${row}#${answer.reservation}` : row) as MeterRow,
  };
}

/**
 * Give a unit back, same transaction. For the paths where the consume
 * happened but no value was delivered (the daily ceiling refused the model,
 * the provider was down, the answer was unusable): the merchant's meter
 * must only move when the product actually worked.
 *
 * `meter` is the handle `reserveUnit` returned (or a stored reservation recorded). The database
 * returns at most what THAT reservation spent and has not already given back, to the row it was
 * spent on (`usage_refund`, migration 0216): never a row chosen by the current plan, never more
 * than was taken, and never twice. A handle that carries no reservation returns nothing. Answers
 * how many units actually went back.
 */
export async function refundUnit(
  tx: TenantDb,
  businessId: string,
  meter: MeterRow,
  unit: UsageUnit,
  n = 1,
): Promise<number> {
  const reservation = reservationOf(meter);
  if (!reservation) return 0;
  const rows = await tx.execute<{ returned: number }>(sql`
    SELECT usage_refund(${businessId}::uuid, ${reservation}::uuid, ${unit}::text, ${n}::int)
      AS returned
  `);
  return Number([...rows][0]?.returned ?? 0);
}

/**
 * Add a paid pack's capacity to this month's ceiling (ADR 0024's add-on packs).
 *
 * Separate from `used` and never netted against it, so the two questions stay
 * answerable apart: how much a merchant consumed, and how much they paid to
 * be allowed to. Netting would make a pack look like usage that never
 * happened.
 *
 * Through `usage_credit_pack` (OD-51.4, migration 0216), which only the settlement principal may
 * run: it credits the units for ONE paid pack charge that is not set aside and not yet credited,
 * and stamps the charge's credit time (OD-40) in the same call. A charge can therefore raise the
 * ceiling once, whatever calls this and however often. Answers false when the charge was already
 * credited (nothing changes).
 *
 * A trial business is never offered a pack (its price is 0), so a trial's base
 * units meet this only through a direct call; there the bonus is held on the
 * trial row with the rest of that unit's budget.
 *
 * The pack is spent in the month it is bought and does not roll over, which
 * is why the period is an argument and not derived: the caller passes the
 * period the charge covers.
 */
export async function creditPack(
  tx: TenantDb,
  businessId: string,
  reference: string,
  period: string,
  unit: UsageUnit,
  n: number,
): Promise<boolean> {
  const row = meterOn(await planOf(tx, businessId), period, unit);
  const rows = await tx.execute<{ credited: boolean }>(sql`
    SELECT usage_credit_pack(
      ${businessId}::uuid, ${reference}, ${row}::text, ${unit}::text, ${n}::int) AS credited
  `);
  return [...rows][0]?.credited === true;
}

/**
 * The row a unit of `period` belongs on for this business (for the test harness's bonus fixture):
 * the trial row for a trial's base units, otherwise the month named. Not clamped to the current
 * month the way a spend is (0222): a fixture may stage a pack on next month's row, as a renewal
 * that crosses a month end would find it.
 */
export async function meterRowFor(
  tx: TenantDb,
  businessId: string,
  period: string,
  unit: string,
): Promise<string> {
  const plan = await planOf(tx, businessId);
  const trial = !plan || plan === 'trial';
  return trial && !independent.has(unit) ? TRIAL_METER : monthMeter(period);
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

/**
 * The plan this business is on, read under the tenant pin — with the trial
 * clock applied.
 *
 * A lapsed trial answers `expired`, whose allowances are all zero, so the
 * gate refuses without needing a second concept. ONLY a trial expires here:
 * a paid plan whose date has slipped past keeps its allowances, because
 * cutting off a merchant who is paying us over a late billing job is the
 * one failure this file must never cause.
 */
export async function planFor(tx: TenantDb, businessId: string, now = new Date()): Promise<string> {
  const rows = await tx.execute<{ plan: string; plan_expires_at: string | null }>(sql`
    SELECT plan, plan_expires_at FROM businesses WHERE id = ${businessId}::uuid
  `);
  const row = [...rows][0];
  if (!row) return 'trial';
  if (row.plan !== 'trial') return row.plan;
  if (!row.plan_expires_at) return 'trial';
  return new Date(row.plan_expires_at) <= now ? 'expired' : 'trial';
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
  const rows = await tx.execute<{ plan: string; plan_expires_at: string | null }>(sql`
    SELECT plan, plan_expires_at FROM businesses WHERE id = ${businessId}::uuid
  `);
  const row = [...rows][0];
  if (!row) return null;
  if (row.plan === 'expired') return 'plan';
  if (row.plan === 'trial' && row.plan_expires_at && new Date(row.plan_expires_at) <= now) {
    return 'trial';
  }
  return null;
}
