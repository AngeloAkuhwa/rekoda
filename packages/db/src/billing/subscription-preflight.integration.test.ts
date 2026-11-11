/**
 * OD-49 (owner instruction, 11 Nov 2026): the release preflight of subscription periods, and the
 * only sanctioned correction (migration 0208).
 *
 * The claims:
 *  - the preflight lists every business whose dates break Rekoda's duration rules, with a reason,
 *    split into ACTIVE (a paid plan or trial that has not ended) and INACTIVE (ended or expired);
 *  - it FAILS when any active record is listed and PASSES when only inactive ones are;
 *  - valid records, including an anchored renewal clamped into a longer month and a shorter
 *    pre-0207 operator period, are not listed;
 *  - it changes nothing, reports no personal detail, and refuses a role that row-level security
 *    would blind (a false PASS);
 *  - a correction happens only by an operator's explicit call with a written reason, only for an
 *    active record that breaks the rules, only to an end that satisfies them, and records the
 *    original and corrected values, the actor and the reason; no runtime role can run it.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { PreflightCannotRun, subscriptionPeriodPreflight } from '../preflight-subscriptions.js';
import {
  outcome,
  ownerDb,
  PRINCIPALS,
  seedBusiness,
  urls,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Write a business's dates directly, as the owner (exempt from the guards), to stage history. */
async function stage(
  businessId: string,
  dates: {
    plan: string;
    expires: string | null;
    cycleStart?: string | null;
    interval?: string;
    trialStart?: string;
  },
): Promise<void> {
  await ownerDb.execute(sql`
    UPDATE businesses SET plan = ${dates.plan},
      plan_expires_at = ${dates.expires}::timestamptz,
      cycle_started_at = ${dates.cycleStart ?? null}::timestamptz,
      billing_interval = ${dates.interval ?? 'monthly'},
      trial_started_at = COALESCE(${dates.trialStart ?? null}::timestamptz, trial_started_at)
    WHERE id = ${businessId}::uuid`);
}

const snapshot = async () => [
  ...(await ownerDb.execute<Record<string, unknown>>(sql`
      SELECT id, plan, plan_expires_at::text, cycle_started_at::text, billing_interval,
             trial_started_at::text, updated_at::text
      FROM businesses ORDER BY id`)),
];

const correct = (businessId: string, end: string, actor: string, reason: string, db = ownerDb) =>
  outcome(
    db.execute(
      sql`SELECT rekoda_private.correct_subscription_period(${businessId}::uuid, ${end}::timestamptz, ${actor}, ${reason})`,
    ),
  );

describe('OD-49: the subscription-period release preflight', () => {
  it('passes, listing nothing, when every record keeps to the rules', async () => {
    const now = Date.now();
    const monthly = await seedBusiness();
    await stage(monthly, {
      plan: 'chat',
      cycleStart: iso(now - 5 * DAY),
      expires: iso(now + 25 * DAY),
    });
    const annual = await seedBusiness();
    await stage(annual, {
      plan: 'complete',
      interval: 'annual',
      cycleStart: iso(now - 30 * DAY),
      expires: iso(now + 330 * DAY),
    });
    // A renewal anchored to the 31st: the cycle that started on 28 February ends on 31 March.
    const anchored = await seedBusiness();
    await stage(anchored, {
      plan: 'integrate',
      cycleStart: '2099-02-28T09:00:00Z',
      expires: '2099-03-31T09:00:00Z',
    });
    // A shorter operator period written before 0207: grants nothing extra, not listed.
    const shorter = await seedBusiness();
    await stage(shorter, {
      plan: 'chat',
      cycleStart: iso(now - DAY),
      expires: iso(now + 10 * DAY),
    });
    await seedBusiness(); // an ordinary trial from signup
    const ended = await seedBusiness();
    await stage(ended, { plan: 'expired', expires: iso(now - DAY) });

    const report = await subscriptionPeriodPreflight(urls.owner);

    expect(report).toMatchObject({
      check: 'subscription_periods',
      result: 'PASS',
      activeViolations: 0,
      inactiveViolations: 0,
      active: [],
      inactive: [],
    });
  });

  it('fails on each active record that breaks the rules, with its reason', async () => {
    const now = Date.now();
    const cases: Array<[string, Parameters<typeof stage>[1]]> = [
      ['paid_open_ended', { plan: 'chat', cycleStart: iso(now - DAY), expires: null }],
      ['paid_no_cycle_start', { plan: 'chat', expires: iso(now + 10 * DAY) }],
      [
        'paid_longer_than_interval',
        { plan: 'complete', cycleStart: iso(now - DAY), expires: iso(now + 90 * DAY) },
      ],
      [
        'paid_longer_than_interval',
        {
          plan: 'integrate',
          interval: 'annual',
          cycleStart: iso(now - DAY),
          expires: iso(now + 500 * DAY),
        },
      ],
      [
        'paid_ends_before_start',
        { plan: 'chat', cycleStart: iso(now + 20 * DAY), expires: iso(now + 10 * DAY) },
      ],
      ['trial_open_ended', { plan: 'trial', expires: null }],
      [
        'trial_longer_than_14_days',
        { plan: 'trial', trialStart: iso(now - DAY), expires: iso(now + 20 * DAY) },
      ],
    ];
    const ids: string[] = [];
    for (const [, dates] of cases) {
      const id = await seedBusiness();
      await stage(id, dates);
      ids.push(id);
    }

    const report = await subscriptionPeriodPreflight(urls.owner);

    expect(report.result).toBe('FAIL');
    expect(report.activeViolations).toBe(cases.length);
    expect(report.inactiveViolations).toBe(0);
    const byId = new Map(report.active.map((r) => [r.businessId, r]));
    cases.forEach(([reason, dates], i) => {
      expect(byId.get(ids[i]!), reason).toMatchObject({
        status: 'active',
        reason,
        plan: dates.plan,
      });
    });
  });

  it('reports inactive historical records without failing the release', async () => {
    const now = Date.now();
    const longAgo = await seedBusiness();
    // A paid plan that ran longer than its interval, but ended last week.
    await stage(longAgo, {
      plan: 'chat',
      cycleStart: iso(now - 200 * DAY),
      expires: iso(now - 7 * DAY),
    });
    const futureExpired = await seedBusiness();
    await stage(futureExpired, { plan: 'expired', expires: iso(now + 30 * DAY) });

    const report = await subscriptionPeriodPreflight(urls.owner);

    expect(report.result).toBe('PASS');
    expect(report.activeViolations).toBe(0);
    expect(report.inactive.map((r) => [r.businessId, r.reason]).sort()).toEqual(
      [
        [longAgo, 'paid_longer_than_interval'],
        [futureExpired, 'expired_future_end'],
      ].sort(),
    );
  });

  it('changes nothing, and reports ids and dates only', async () => {
    const id = await seedBusiness();
    await stage(id, { plan: 'chat', cycleStart: iso(Date.now() - DAY), expires: null });
    const before = await snapshot();

    const report = await subscriptionPeriodPreflight(urls.owner);

    expect(await snapshot()).toEqual(before);
    const text = JSON.stringify(report);
    expect(text).not.toContain('Ada Fashion'); // the seeded business name
    expect(text).not.toMatch(/\+234/); // the owner's phone
  });

  it('refuses a role that row-level security would blind, rather than pass for the wrong reason', async () => {
    const id = await seedBusiness();
    await stage(id, { plan: 'chat', cycleStart: iso(Date.now() - DAY), expires: null });
    for (const url of [urls.app, urls.worker, urls.settlement, urls.operator]) {
      await expect(subscriptionPeriodPreflight(url)).rejects.toBeInstanceOf(PreflightCannotRun);
    }
  });
});

describe('OD-49: the audited correction', () => {
  const REASON = 'open-ended paid plan found by the release preflight; owner decided one month';

  it('corrects only on an explicit call, records the original and corrected values, and the preflight then passes', async () => {
    const now = Date.now();
    const id = await seedBusiness();
    const start = iso(now - DAY);
    await stage(id, { plan: 'chat', cycleStart: start, expires: null });
    const [bound] = await ownerDb.execute<{ at: string }>(
      sql`SELECT (${start}::timestamptz + interval '20 days')::text AS at`,
    );
    const end = new Date(bound!.at).toISOString();

    expect(await correct(id, end, 'operator:angelo', REASON)).toBe('allowed');

    const [row] = await ownerDb.execute<{ plan: string; ends: string }>(
      sql`SELECT plan, plan_expires_at::text AS ends FROM businesses WHERE id = ${id}::uuid`,
    );
    expect(row!.plan).toBe('chat'); // the plan and its status never change here
    expect(new Date(row!.ends).toISOString()).toBe(end);
    const [audit] = await ownerDb.execute<{
      actor: string;
      reason: string;
      source_type: string;
      old_value: { plan: string; violation: string; expiresAt: string | null };
      new_value: { plan: string; expiresAt: string };
    }>(sql`
      SELECT actor, reason, source_type, old_value, new_value FROM audit_events
      WHERE business_id = ${id}::uuid AND action = 'subscription_period_corrected'`);
    expect(audit).toMatchObject({
      actor: 'operator:angelo',
      reason: REASON,
      source_type: 'operator',
      old_value: { plan: 'chat', violation: 'paid_open_ended', expiresAt: null },
      new_value: { plan: 'chat' },
    });
    expect(new Date(audit!.new_value.expiresAt).toISOString()).toBe(end);
    expect((await subscriptionPeriodPreflight(urls.owner)).result).toBe('PASS');
  });

  it('refuses without an operator actor or a written reason', async () => {
    const id = await seedBusiness();
    await stage(id, { plan: 'chat', cycleStart: iso(Date.now() - DAY), expires: null });
    const end = iso(Date.now() + 10 * DAY);
    expect(await correct(id, end, 'system:x', REASON)).toMatch(/^22023 .*operator actor/);
    expect(await correct(id, end, 'operator:angelo', 'short')).toMatch(/^22023 .*written reason/);
  });

  it('refuses a record that already keeps to the rules, an inactive one, and an end that still breaks them', async () => {
    const now = Date.now();
    const fine = await seedBusiness();
    await stage(fine, { plan: 'chat', cycleStart: iso(now - DAY), expires: iso(now + 20 * DAY) });
    expect(await correct(fine, iso(now + 10 * DAY), 'operator:a', REASON)).toMatch(
      /already satisfies the rules/,
    );

    const gone = await seedBusiness();
    await stage(gone, { plan: 'chat', cycleStart: iso(now - 200 * DAY), expires: iso(now - DAY) });
    expect(await correct(gone, iso(now + 10 * DAY), 'operator:a', REASON)).toMatch(
      /only an active paid plan or trial/,
    );

    const open = await seedBusiness();
    await stage(open, { plan: 'chat', cycleStart: iso(now - DAY), expires: null });
    expect(await correct(open, iso(now + 90 * DAY), 'operator:a', REASON)).toMatch(
      /still breaks the rules \(paid_longer_than_interval\)/,
    );
    expect(await correct(open, iso(now - 60_000), 'operator:a', REASON)).toMatch(
      /must be in the future/,
    );
    const [row] = await ownerDb.execute<{ ends: string | null }>(
      sql`SELECT plan_expires_at::text AS ends FROM businesses WHERE id = ${open}::uuid`,
    );
    expect(row!.ends).toBeNull();
  });

  it.each(['app', 'worker', 'settlement', 'operator'] as const)(
    '%s cannot run the correction or the preflight function',
    async (who) => {
      const id = await seedBusiness();
      await stage(id, { plan: 'chat', cycleStart: iso(Date.now() - DAY), expires: null });
      const db = PRINCIPALS[who]();
      expect(
        await outcome(
          withBusiness(db, id, (tx) =>
            tx.execute(
              sql`SELECT rekoda_private.correct_subscription_period(${id}::uuid, ${iso(Date.now() + 10 * DAY)}::timestamptz, 'operator:x', ${REASON})`,
            ),
          ),
        ),
      ).toMatch(/42501/);
      expect(
        await outcome(
          db.execute(sql`SELECT * FROM rekoda_private.subscription_period_preflight()`),
        ),
      ).toMatch(/42501/);
    },
  );
});
