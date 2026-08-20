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
 * SQL. `bonus` raises the ceiling and is written ONLY by a verified billing
 * top-up (M4) — nothing in this file mutates it.
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
   * case (an allowance of zero, like voice on Integrate, must refuse the
   * very first unit); the EXISTS keeps existing rows flowing to the
   * conflict arm, whose WHERE re-checks against `allowance + bonus` so a
   * billing top-up raises the ceiling without new SQL. Two concurrent
   * fresh-row consumers both pass the EXISTS=false path, one wins the
   * insert, and the loser is re-judged by the conflict arm — the database
   * decides, as everywhere else in this codebase.
   */
  const rows = await tx.execute<{ used: number }>(sql`
    INSERT INTO usage_counters (business_id, period, unit, used)
    SELECT ${businessId}::uuid, ${period}, ${unit}, ${n}
    WHERE ${n} <= ${allowance}
       OR EXISTS (
            SELECT 1 FROM usage_counters
            WHERE business_id = ${businessId}::uuid
              AND period = ${period} AND unit = ${unit})
    ON CONFLICT (business_id, period, unit) DO UPDATE
      SET used = usage_counters.used + ${n}, updated_at = now()
      WHERE usage_counters.used + ${n} <= ${allowance} + usage_counters.bonus
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

/** The plan this business is on, read under the tenant pin. */
export async function planFor(tx: TenantDb, businessId: string): Promise<string> {
  const rows = await tx.execute<{ plan: string }>(sql`
    SELECT plan FROM businesses WHERE id = ${businessId}::uuid
  `);
  return [...rows][0]?.plan ?? 'trial';
}
