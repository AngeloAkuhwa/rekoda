/**
 * OD-49 (owner ruling, 11 Nov 2026; migration 0208): subscription rows that break Rekoda's plan
 * durations are found, reported without customer detail, block the release while active, are
 * never silently rewritten, and grant no entitlement through any path that asks the gate.
 *
 * Non-conforming rows can only be written as the table owner since 0203 (the writers refuse them),
 * so each case writes one that way, as a row from before 0203 or a hand edit would look.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { billingRepo, entitlementsRepo, usageRepo } from '../index.js';
import {
  appDb,
  operatorDb,
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const ACTOR = 'operator:od49-test';

/** What the release preflight reads (scripts/deploy-staging.sh): the owner-only report. */
const report = async () => [
  ...(await ownerDb.execute<{ business_id: string; plan: string; reason: string; active: boolean }>(
    sql`SELECT * FROM rekoda_private.subscription_conformance_report()`,
  )),
];
/** The preflight's verdict: the number of ACTIVE non-conforming rows (0 = may start). */
const blocking = async () => (await report()).filter((r) => r.active).length;

const snapshot = async (businessId: string) =>
  [
    ...(await ownerDb.execute(sql`SELECT plan, plan_expires_at::text, cycle_started_at::text,
      billing_interval, trial_started_at::text, updated_at::text
      FROM businesses WHERE id = ${businessId}::uuid`)),
  ][0];

const asOwner = (businessId: string, set: ReturnType<typeof sql>) =>
  ownerDb.execute(sql`UPDATE businesses SET ${set} WHERE id = ${businessId}::uuid`);

const gate = (businessId: string) =>
  withBusiness(appDb, businessId, async (tx) => ({
    plan: await usageRepo.planFor(tx, businessId),
    lapse: await usageRepo.lapseOf(tx, businessId),
    entitlements: await entitlementsRepo.resolve(tx, businessId),
  }));

describe('OD-49: the conformance report and the release preflight (0208)', () => {
  it('a clean database passes: fresh trials and standard paid plans are not listed', async () => {
    const trial = await seedBusiness();
    const paid = await seedBusiness();
    await billingRepo.setPlan(operatorDb, { businessId: paid, plan: 'complete', actor: ACTOR });
    expect(await report()).toEqual([]);
    expect(await blocking()).toBe(0);
    expect((await gate(trial)).plan).toBe('trial');
    expect((await gate(paid)).plan).toBe('complete');
  });

  it.each([
    [
      'open_ended_paid_plan',
      sql`plan = 'complete', plan_expires_at = NULL, cycle_started_at = now()`,
    ],
    [
      'paid_plan_without_cycle_start',
      sql`plan = 'chat', plan_expires_at = now() + interval '10 days', cycle_started_at = NULL`,
    ],
    [
      'paid_plan_longer_than_its_interval',
      sql`plan = 'integrate', billing_interval = 'monthly', cycle_started_at = now(),
          plan_expires_at = now() + interval '45 days'`,
    ],
    [
      'paid_plan_longer_than_its_interval',
      sql`plan = 'complete', billing_interval = 'annual', cycle_started_at = now(),
          plan_expires_at = now() + interval '13 months'`,
    ],
    [
      'trial_longer_than_14_days',
      sql`plan = 'trial', plan_expires_at = trial_started_at + interval '30 days'`,
    ],
    ['open_ended_trial', sql`plan = 'trial', plan_expires_at = NULL`],
    [
      'expired_plan_with_future_end',
      sql`plan = 'expired', plan_expires_at = now() + interval '5 days'`,
    ],
  ] as const)('an active %s row is listed and blocks the release', async (reason, set) => {
    const businessId = await seedBusiness();
    await asOwner(businessId, set);
    const listed = await report();
    expect(listed).toEqual([
      { business_id: businessId, plan: expect.any(String), reason, active: true },
    ]);
    expect(await blocking()).toBe(1);
  });

  it('the report names the business by id and plan only: no customer detail', async () => {
    const businessId = await seedBusiness();
    await asOwner(businessId, sql`plan = 'complete', plan_expires_at = NULL`);
    const [listed] = await report();
    expect(Object.keys(listed!).sort()).toEqual(['active', 'business_id', 'plan', 'reason']);
    const name = [
      ...(await ownerDb.execute<{ name: string }>(
        sql`SELECT name FROM businesses WHERE id = ${businessId}::uuid`,
      )),
    ][0]!.name;
    expect(JSON.stringify(listed)).not.toContain(name);
    expect(JSON.stringify(listed)).not.toMatch(/\+234|080/);
  });

  it('a long trial whose end has passed is history: listed, not blocking', async () => {
    const businessId = await seedBusiness();
    await asOwner(
      businessId,
      sql`trial_started_at = now() - interval '60 days', plan_expires_at = now() - interval '30 days'`,
    );
    expect(await report()).toEqual([
      {
        business_id: businessId,
        plan: 'trial',
        reason: 'trial_longer_than_14_days',
        active: false,
      },
    ]);
    expect(await blocking()).toBe(0);
  });

  it('nothing rewrites a listed row: the report, the gate and a deploy read it unchanged', async () => {
    const businessId = await seedBusiness();
    await asOwner(
      businessId,
      sql`plan = 'complete', plan_expires_at = NULL, cycle_started_at = now()`,
    );
    const before = await snapshot(businessId);
    await report();
    await gate(businessId);
    await blocking();
    expect(await snapshot(businessId)).toEqual(before);
  });

  it('a row corrected through the audited operator writer passes', async () => {
    const businessId = await seedBusiness();
    await asOwner(
      businessId,
      sql`plan = 'complete', plan_expires_at = NULL, cycle_started_at = now()`,
    );
    expect(await blocking()).toBe(1);
    await billingRepo.setPlan(operatorDb, {
      businessId,
      plan: 'complete',
      billingInterval: 'monthly',
      actor: ACTOR,
      reason: 'OD-49 correction: open-ended arrangement moved to a standard monthly period',
    });
    expect(await report()).toEqual([]);
    const audited = [
      ...(await ownerDb.execute<{ reason: string }>(
        sql`SELECT reason FROM audit_events WHERE business_id = ${businessId}::uuid
            AND action = 'plan_changed'`,
      )),
    ];
    expect(audited.map((a) => a.reason)).toEqual([
      'OD-49 correction: open-ended arrangement moved to a standard monthly period',
    ]);
  });

  it('the application and worker cannot read the report', async () => {
    for (const db of [appDb]) {
      await expect(
        db.execute(sql`SELECT * FROM rekoda_private.subscription_conformance_report()`),
      ).rejects.toThrow();
    }
  });
});

describe('OD-49: a non-conforming row grants no entitlement through the gate', () => {
  it.each([
    [
      'open-ended paid plan',
      sql`plan = 'complete', plan_expires_at = NULL, cycle_started_at = now()`,
    ],
    [
      'paid plan with no cycle start',
      sql`plan = 'complete', plan_expires_at = now() + interval '10 days', cycle_started_at = NULL`,
    ],
    [
      'paid plan longer than its interval',
      sql`plan = 'complete', billing_interval = 'monthly', cycle_started_at = now() - interval '1 day',
          plan_expires_at = now() + interval '90 days'`,
    ],
  ] as const)('a %s reads as a lapsed plan (no paid entitlement)', async (_label, set) => {
    const businessId = await seedBusiness();
    await asOwner(businessId, set);
    const g = await gate(businessId);
    expect(g.plan).toBe('expired');
    expect(g.lapse).toBe('plan');
    expect(g.entitlements).not.toContain('REKODA_INTEGRATE');
    expect(g.entitlements).not.toContain('REKODA_CHAT');
  });

  it('an over-long trial ends 14 days after its own start, whatever date it carries', async () => {
    const businessId = await seedBusiness();
    await asOwner(
      businessId,
      sql`trial_started_at = now() - interval '15 days', plan_expires_at = now() + interval '15 days'`,
    );
    const g = await gate(businessId);
    expect(g.plan).toBe('expired');
    expect(g.lapse).toBe('trial');
    // Within its 14 days the same row still works as a trial.
    await asOwner(businessId, sql`trial_started_at = now() - interval '2 days'`);
    expect((await gate(businessId)).plan).toBe('trial');
  });

  it('a conforming paid plan past its date keeps its allowances until grace lapses it (unchanged)', async () => {
    const businessId = await seedBusiness();
    await asOwner(
      businessId,
      sql`plan = 'chat', billing_interval = 'monthly', cycle_started_at = now() - interval '32 days',
          plan_expires_at = now() - interval '1 day'`,
    );
    expect((await gate(businessId)).plan).toBe('chat');
  });
});
