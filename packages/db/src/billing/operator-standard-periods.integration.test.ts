/**
 * OD-50 (owner instruction, 11 Nov 2026; migration 0207): an operator plan assignment runs exactly
 * Rekoda's standard period, computed by the database writer, and the trial start is fixed.
 *
 *   * a paid plan runs exactly one Lagos calendar month (or twelve) from the moment the writer runs;
 *     the caller gives no end, longer or shorter; ending early is the explicit `expired` operation;
 *   * re-posting the plan and interval already in force changes nothing (no free days);
 *   * a trial runs exactly to the business's own trial start plus 336 hours, and a business whose
 *     trial is over cannot be given another;
 *   * no runtime role can move `trial_started_at`.
 *
 * Every assertion runs on a live connection as that principal. The role boundary of the writer
 * itself is pinned in plan-writer-boundary.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { TRIAL_DAYS } from '@rekoda/core';
import {
  dbBound,
  operatorDb,
  outcome,
  ownerDb,
  planOf,
  PRINCIPALS,
  seedBusiness,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

describe("OD-50: the operator writer assigns Rekoda's standard periods (0207)", () => {
  const set = (businessId: string, plan: string, expires: Date | null, interval: string | null) =>
    outcome(
      withBusiness(operatorDb, businessId, (tx) =>
        tx.execute(
          sql`SELECT subscription_operator_set_plan(${businessId}::uuid, ${plan}, ${expires?.toISOString() ?? null}::timestamptz, ${interval}, 'operator:alice')`,
        ),
      ),
    );

  /* The writer's own answer: the cycle start and end it wrote, and whether it changed anything. */
  const setRow = async (businessId: string, plan: string, interval: string | null) => {
    const rows = await withBusiness(operatorDb, businessId, (tx) =>
      tx.execute<{ cycle_start: string | null; expires_at: string; changed: boolean }>(
        sql`SELECT cycle_start, expires_at, changed FROM subscription_operator_set_plan(${businessId}::uuid, ${plan}, NULL, ${interval}, 'operator:alice')`,
      ),
    );
    return [...rows][0]!;
  };
  const dbAddInterval = async (from: string, interval: string) => {
    const [row] = await ownerDb.execute<{ at: string }>(
      sql`SELECT rekoda_private.add_billing_interval(${from}::timestamptz, ${interval})::text AS at`,
    );
    return new Date(row!.at).getTime();
  };
  const planChangedCount = async (businessId: string) => {
    const [row] = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE business_id = ${businessId}::uuid AND action = 'plan_changed'`,
    );
    return row!.n;
  };

  it('a paid plan runs its standard period: the caller gives no end, longer or shorter (OD-50, 0207)', async () => {
    const businessId = await seedBusiness();
    const bound = await dbBound('monthly');
    for (const end of [
      new Date(bound.getTime() + 1_000), // longer than a month
      new Date(Date.now() + 20 * 86_400_000), // shorter than a month
      bound, // even the exact bound computed a moment earlier
      new Date(Date.now() - 60_000), // in the past
      new Date('2099-01-01T00:00:00Z'),
    ]) {
      expect(await set(businessId, 'chat', end, 'monthly')).toMatch(
        /^22023 .*runs its standard period; give no end date/,
      );
    }
    expect((await planOf(businessId))?.plan).toBe('trial');
    expect(await planChangedCount(businessId)).toBe(0);
  });

  it('a monthly plan ends exactly one Lagos calendar month after the cycle start the writer used', async () => {
    const businessId = await seedBusiness();
    const before = Date.now();
    const row = await setRow(businessId, 'chat', 'monthly');
    expect(row.changed).toBe(true);
    const start = new Date(row.cycle_start!).getTime();
    expect(start).toBeGreaterThanOrEqual(before - 5_000);
    expect(start).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(new Date(row.expires_at).getTime()).toBe(
      await dbAddInterval(row.cycle_start!, 'monthly'),
    );
    const after = await planOf(businessId);
    expect(after?.plan).toBe('chat');
    expect(new Date(after!.plan_expires_at!).getTime()).toBe(new Date(row.expires_at).getTime());
  });

  it('an annual plan ends exactly twelve Lagos calendar months after its cycle start', async () => {
    const businessId = await seedBusiness();
    const row = await setRow(businessId, 'complete', 'annual');
    expect(row.changed).toBe(true);
    expect(new Date(row.expires_at).getTime()).toBe(
      await dbAddInterval(row.cycle_start!, 'annual'),
    );
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 360 * 86_400_000);
  });

  it('re-posting the plan and interval already in force changes nothing; another interval is a new period', async () => {
    const businessId = await seedBusiness();
    const first = await setRow(businessId, 'chat', 'monthly');
    const again = await setRow(businessId, 'chat', 'monthly');
    expect(again.changed).toBe(false);
    expect(again.expires_at).toBe(first.expires_at);
    expect(await planChangedCount(businessId)).toBe(1);
    const annual = await setRow(businessId, 'chat', 'annual');
    expect(annual.changed).toBe(true);
    expect(new Date(annual.expires_at).getTime()).toBe(
      await dbAddInterval(annual.cycle_start!, 'annual'),
    );
    expect(await planChangedCount(businessId)).toBe(2);
  });

  it('a plan that has ended can be given a fresh period by re-posting it', async () => {
    const businessId = await seedBusiness();
    await setRow(businessId, 'chat', 'monthly');
    await ownerDb.execute(
      sql`UPDATE businesses SET plan_expires_at = now() - interval '1 day' WHERE id = ${businessId}::uuid`,
    );
    const fresh = await setRow(businessId, 'chat', 'monthly');
    expect(fresh.changed).toBe(true);
    expect(new Date(fresh.expires_at).getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
  });

  it("a trial runs exactly to the business's own trial start plus 14 days; no end may be given", async () => {
    const businessId = await seedBusiness();
    const started = new Date((await planOf(businessId))!.trial_started_at);
    const last = new Date(started.getTime() + TRIAL_DAYS * 86_400_000);
    for (const end of [
      new Date(last.getTime() + 1),
      last,
      new Date(started.getTime() + 86_400_000), // ending a trial early is `expired`, not a short trial
    ]) {
      expect(await set(businessId, 'trial', end, null)).toMatch(
        /^22023 .*runs its standard period; give no end date/,
      );
    }
    const row = await setRow(businessId, 'trial', null);
    expect(row.cycle_start).toBeNull();
    expect(new Date(row.expires_at).getTime()).toBe(last.getTime());
  });

  it('a business whose trial is over cannot be given another one', async () => {
    const businessId = await seedBusiness();
    await ownerDb.execute(sql`
      UPDATE businesses SET trial_started_at = now() - interval '15 days',
        plan = 'expired', plan_expires_at = now() - interval '1 day'
      WHERE id = ${businessId}::uuid`);
    expect(await set(businessId, 'trial', null, null)).toMatch(/^22023 .*trial is already over/);
    expect((await planOf(businessId))?.plan).toBe('expired');
  });

  it.each(['app', 'worker', 'settlement', 'operator'] as const)(
    '%s cannot move the trial start, so no credential can stretch the 14 days (OD-50, 0207)',
    async (who) => {
      const businessId = await seedBusiness();
      const before = (await planOf(businessId))!.trial_started_at;
      const moved = await outcome(
        withBusiness(PRINCIPALS[who](), businessId, (tx) =>
          tx.execute(
            sql`UPDATE businesses SET trial_started_at = now() + interval '30 days' WHERE id = ${businessId}::uuid`,
          ),
        ),
      );
      // The worker (0210), the operator (0211) and settlement (0217) hold no write on the column at
      // all; the application meets the guard.
      expect(moved).toMatch(
        who !== 'app'
          ? /42501.*permission denied for table businesses/
          : /42501.*trial start is fixed at signup/,
      );
      expect((await planOf(businessId))!.trial_started_at).toBe(before);
    },
  );
});
