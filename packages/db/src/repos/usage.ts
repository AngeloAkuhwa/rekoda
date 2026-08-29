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
import type { UsageUnit } from '@rekoda/core';

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
  const rows = await tx.execute<{ used: number }>(sql`
    INSERT INTO usage_counters (business_id, period, unit, used)
    SELECT ${businessId}::uuid, ${period}::char(7), ${unit}::text, ${n}::int
    WHERE ${n}::int <= ${allowance}::int
       OR EXISTS (
            SELECT 1 FROM usage_counters
            WHERE business_id = ${businessId}::uuid
              AND period = ${period}::char(7) AND unit = ${unit}::text)
    ON CONFLICT (business_id, period, unit) DO UPDATE
      SET used = usage_counters.used + ${n}::int, updated_at = now()
      WHERE usage_counters.used + ${n}::int <= ${allowance}::int + usage_counters.bonus
    RETURNING used
  `);
  return [...rows].length === 1;
}

/**
 * Give a unit back, same transaction. For the paths where the consume
 * happened but no value was delivered (the daily ceiling refused the model,
 * the provider was down, the answer was unusable): the merchant's meter
 * must only move when the product actually worked. GREATEST guards the
 * floor; the CHECK constraint would reject a negative anyway.
 */
export async function refundUnit(
  tx: TenantDb,
  businessId: string,
  period: string,
  unit: UsageUnit,
  n = 1,
): Promise<void> {
  await tx.execute(sql`
    UPDATE usage_counters
    SET used = GREATEST(used - ${n}, 0), updated_at = now()
    WHERE business_id = ${businessId}::uuid AND period = ${period} AND unit = ${unit}
  `);
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
  await tx.execute(sql`
    INSERT INTO usage_counters (business_id, period, unit, bonus)
    VALUES (${businessId}::uuid, ${period}, ${unit}, ${n})
    ON CONFLICT (business_id, period, unit) DO UPDATE
      SET bonus = usage_counters.bonus + ${n}, updated_at = now()
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
  const rows = await tx.execute<UsageRow>(sql`
    SELECT unit, used, bonus FROM usage_counters
    WHERE business_id = ${businessId}::uuid AND period = ${period}
    ORDER BY unit
  `);
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
