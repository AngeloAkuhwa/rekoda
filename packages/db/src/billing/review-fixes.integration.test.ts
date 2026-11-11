/**
 * The independent review of the PR #432 remediation (11 Nov 2026, at 5a5ee75), each finding
 * reproduced as the real principal and fixed by migration 0212:
 *
 *   B1  settlement rewrote a charge's terms after the price check and settled the cheap version
 *   I1  an upgrade prorated over a caller-chosen period (from 1900) cost almost nothing
 *   I1' (financial) two voice notes of different lengths: the second refund was lost
 *   I2  any role released another role's consumption
 *   M2  the grandfathering pin could be set to an older, cheaper version
 *   R3  the staging date tool left a row 0208 calls non-conforming
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness, type Db } from '../client.js';
import { planCatalogueRepo, stagingToolsRepo, usageRepo } from '../index.js';
import { migrate, resetPlanCatalogue } from '../testing.js';
import {
  appDb,
  operatorDb,
  outcome,
  ownerDb,
  seedBusiness,
  settlementDb,
  urls,
  usePlanWriterHarness,
  workerDb,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();
afterEach(async () => {
  await resetPlanCatalogue(urls);
  await ownerDb.execute(sql`DELETE FROM staging_environment`);
});

const DAY = 86_400_000;
let seq = 0;

async function onCycle(plan: string, daysIn: number, length = 30) {
  const id = await seedBusiness();
  const start = new Date(Date.now() - daysIn * DAY);
  const end = new Date(start.getTime() + length * DAY);
  await ownerDb.execute(sql`UPDATE businesses SET plan = ${plan}, billing_interval = 'monthly',
    cycle_started_at = ${start.toISOString()}::timestamptz,
    plan_expires_at = ${end.toISOString()}::timestamptz,
    plan_version_id = (SELECT id FROM plan_versions WHERE plan_id = ${plan} ORDER BY version DESC LIMIT 1)
    WHERE id = ${id}::uuid`);
  return { id, start, end };
}

const asSettlement = (businessId: string, statement: ReturnType<typeof sql>) =>
  outcome(withBusiness(settlementDb, businessId, (tx) => tx.execute(statement)));

describe('B1: what a charge buys is fixed for settlement too (0212)', () => {
  it('settlement cannot rewrite the amount, plan, interval or period of a charge it opened', async () => {
    const { id } = await onCycle('chat', 29);
    seq += 1;
    const ref = `RKD-REV-${seq}`;
    expect(
      await asSettlement(
        id,
        sql`INSERT INTO subscription_charges
        (business_id, kind, plan, amount_k, reference, period_start, period_end, billing_interval)
        VALUES (${id}::uuid, 'renewal', 'complete', 29900000, ${ref}, now(), now() + interval '1 year', 'annual')`,
      ),
    ).toBe('allowed');
    for (const set of [
      sql`amount_k = 100`,
      sql`plan = 'complete', amount_k = 100`,
      sql`billing_interval = 'monthly'`,
      sql`period_end = now() + interval '10 years'`,
      sql`kind = 'first_purchase'`,
      sql`created_at = now() - interval '1 year'`,
    ]) {
      expect(
        await asSettlement(
          id,
          sql`UPDATE subscription_charges SET ${set} WHERE reference = ${ref}`,
        ),
      ).toMatch(/42501.*fixed when it is opened/);
    }
    const [row] = await ownerDb.execute<{ amount_k: string }>(
      sql`SELECT amount_k::text FROM subscription_charges WHERE reference = ${ref}`,
    );
    expect(row?.amount_k).toBe('29900000');
  });
});

describe('I1: an upgrade is priced for the business’s current cycle (0212)', () => {
  it('an upgrade over an invented period is refused, however its amount is chosen', async () => {
    const { id, end } = await onCycle('chat', 10);
    seq += 1;
    expect(
      await asSettlement(
        id,
        sql`INSERT INTO subscription_charges
        (business_id, kind, plan, amount_k, reference, period_start, period_end)
        VALUES (${id}::uuid, 'upgrade', 'complete', 800, ${`RKD-REV-${seq}`},
          '1900-01-01T00:00:00Z'::timestamptz, ${end.toISOString()}::timestamptz)`,
      ),
    ).toMatch(/42501.*current cycle/);
  });
});

describe('the meter release (0212)', () => {
  const PERIOD = '2026-11';
  const meter = usageRepo.monthMeter(PERIOD);
  const used = async (id: string) =>
    [
      ...(await ownerDb.execute<{ used: number }>(sql`SELECT used FROM usage_counters
        WHERE business_id = ${id}::uuid AND period = ${PERIOD} AND unit = 'VOICE_MINUTES'`)),
    ][0]?.used;
  const reserve = (db: Db, id: string, n: number) =>
    withBusiness(db, id, (tx) => usageRepo.reserveUnit(tx, id, PERIOD, 'VOICE_MINUTES', 1000, n));
  const release = (db: Db, id: string, n: number) =>
    withBusiness(db, id, (tx) => usageRepo.refundUnit(tx, id, meter, 'VOICE_MINUTES', n));

  it('two voice notes of different lengths, both failed, are both given back in full', async () => {
    const { id } = await onCycle('complete', 1);
    await reserve(appDb, id, 45);
    await reserve(appDb, id, 60);
    expect(await used(id)).toBe(105);
    expect(await release(appDb, id, 45)).toBe(true);
    expect(await release(appDb, id, 60)).toBe(true);
    expect(await used(id)).toBe(0);
    expect(await release(appDb, id, 1)).toBe(false);
  });

  it('a role gives back only its own recorded consumption', async () => {
    const { id } = await onCycle('complete', 1);
    await reserve(workerDb, id, 10);
    expect(await release(appDb, id, 10)).toBe(false);
    expect(await used(id)).toBe(10);
    expect(await release(workerDb, id, 10)).toBe(true);
    expect(await used(id)).toBe(0);
  });

  it('a release larger than the open consumption changes nothing', async () => {
    const { id } = await onCycle('complete', 1);
    await reserve(appDb, id, 5);
    await reserve(appDb, id, 5);
    expect(await release(appDb, id, 11)).toBe(false);
    expect(await used(id)).toBe(10);
  });
});

describe('M2: the grandfathering pin is kept or set to the version in effect at the cycle start (0212)', () => {
  const publishChat = (from: Date) =>
    planCatalogueRepo.publishPlanVersion(ownerDb, {
      planId: 'chat',
      name: 'Rekoda chat',
      seats: 1,
      effectiveFrom: from,
      entitlements: ['REKODA_CHAT'],
      allowances: { AI_ACTIONS: 300, VOICE_MINUTES: 60, DOCUMENT_GENERATION: 100 },
      prices: [{ currency: 'NGN', billingInterval: 'monthly', amountMinor: 1_490_000 }],
    });
  const versions = async () =>
    [
      ...(await ownerDb.execute<{ id: string }>(
        sql`SELECT id FROM plan_versions WHERE plan_id = 'chat' ORDER BY version`,
      )),
    ].map((r) => r.id);
  /* As each principal, with the fixture writer dropped (its presence is the harness exemption). */
  async function withoutFixture(fn: () => Promise<void>) {
    await ownerDb.execute(
      sql`DROP FUNCTION IF EXISTS public.test_fixture_set_plan(uuid, text, timestamptz)`,
    );
    try {
      await fn();
    } finally {
      await migrate(urls); // reinstalls the harness writer
    }
  }
  const pin = (db: Db, id: string, version: string, cycleStart: Date) =>
    outcome(
      withBusiness(db, id, (tx) =>
        tx.execute(sql`UPDATE businesses SET plan_version_id = ${version}::uuid,
          cycle_started_at = ${cycleStart.toISOString()}::timestamptz WHERE id = ${id}::uuid`),
      ),
    );

  it('an older, cheaper version than the one in effect at the cycle start is refused', async () => {
    const { id } = await onCycle('chat', 0);
    await publishChat(new Date(Date.now() - 60 * 60_000));
    const [v1, v2] = await versions();
    await ownerDb.execute(sql`UPDATE businesses SET plan_version_id = NULL WHERE id = ${id}::uuid`);
    const now = new Date();
    await withoutFixture(async () => {
      for (const db of [settlementDb, operatorDb]) {
        expect(await pin(db, id, v1!, now)).toMatch(/42501.*in effect at the cycle start/);
        expect(await pin(db, id, v2!, now)).toBe('allowed');
        await ownerDb.execute(
          sql`UPDATE businesses SET plan_version_id = NULL WHERE id = ${id}::uuid`,
        );
      }
    });
  });

  it('an upgrade keeping a cycle that began before a repricing pins the version of that cycle', async () => {
    // Cycle started 20 days ago; a new version took effect 5 days ago (the delta review's case).
    const { id, start } = await onCycle('chat', 20);
    await publishChat(new Date(Date.now() - 5 * DAY));
    const [v1, v2] = await versions();
    await ownerDb.execute(sql`UPDATE businesses SET plan_version_id = NULL WHERE id = ${id}::uuid`);
    await withoutFixture(async () => {
      expect(await pin(settlementDb, id, v2!, start)).toMatch(/42501/);
      expect(await pin(settlementDb, id, v1!, start)).toBe('allowed');
    });
  });
});

describe('R3: the staging date tool keeps the row conforming (0212)', () => {
  it('moving a paid-to date into the past moves the cycle start with it', async () => {
    const { id } = await onCycle('complete', 2);
    await ownerDb.execute(sql`INSERT INTO staging_environment (marked_by) VALUES ('owner:test')`);
    await withBusiness(appDb, id, (tx) =>
      stagingToolsRepo.designateTestBusiness(tx, {
        businessId: id,
        operator: 'owner:test',
        reason: 'review R3',
      }),
    );
    const before = (await withBusiness(appDb, id, (tx) =>
      stagingToolsRepo.currentDate(tx, id, 'paid_to'),
    ))!.value!;
    await withBusiness(appDb, id, (tx) =>
      stagingToolsRepo.moveDate(tx, {
        businessId: id,
        field: 'paid_to',
        expected: before,
        to: new Date(Date.now() - 3 * DAY),
        operator: 'owner:test',
        reason: 'test grace on a just-bought plan',
      }),
    );
    const [row] = await ownerDb.execute<{ reason: string | null }>(sql`
      SELECT subscription_nonconformity(plan, plan_expires_at, cycle_started_at, billing_interval,
        trial_started_at, now()) AS reason FROM businesses WHERE id = ${id}::uuid`);
    expect(row?.reason).toBeNull();
  });

  it('moving a trial end moves the trial start with it: still exactly 14 days', async () => {
    const id = await seedBusiness();
    await ownerDb.execute(sql`INSERT INTO staging_environment (marked_by) VALUES ('owner:test')`);
    await withBusiness(appDb, id, (tx) =>
      stagingToolsRepo.designateTestBusiness(tx, {
        businessId: id,
        operator: 'owner:test',
        reason: 'review R3 trial',
      }),
    );
    const before = (await withBusiness(appDb, id, (tx) =>
      stagingToolsRepo.currentDate(tx, id, 'trial_end'),
    ))!.value!;
    await withBusiness(appDb, id, (tx) =>
      stagingToolsRepo.moveDate(tx, {
        businessId: id,
        field: 'trial_end',
        expected: before,
        to: new Date(Date.now() + 20 * DAY),
        operator: 'owner:test',
        reason: 'test a trial ending later',
      }),
    );
    const [row] = await ownerDb.execute<{ reason: string | null; hours: number }>(sql`
      SELECT subscription_nonconformity(plan, plan_expires_at, cycle_started_at, billing_interval,
               trial_started_at, now()) AS reason,
             round(extract(epoch FROM plan_expires_at - trial_started_at) / 3600)::int AS hours
      FROM businesses WHERE id = ${id}::uuid`);
    expect(row).toEqual({ reason: null, hours: 336 });
  });
});
