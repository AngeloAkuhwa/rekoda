/**
 * OD-50 (owner ruling, 11 Nov 2026; migration 0207): the generic operator plan writer assigns
 * Rekoda's STANDARD periods only, and an early end is the explicit, audited `expired` operation.
 *
 *   monthly  exactly one Lagos calendar month from the change (month ends clamp: 31 Jan -> 28/29 Feb)
 *   annual   exactly twelve calendar months
 *   trial    exactly the business's ORIGINAL trial start + 14 days; never re-opened once ended
 *   expired  ends now, needs a reason, audited with it; nothing refunded or credited
 *
 * Every assertion is on a live connection as the principal named; the read-back is as the owner.
 * The calendar cases call the database's own rule with fixed instants (month ends, leap years,
 * year ends, the Lagos day boundary), because the writer's clock is the transaction's `now()`.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { addInterval } from '@rekoda/core';
import { withBusiness } from '../client.js';
import { billingRepo } from '../index.js';
import {
  appDb,
  operatorDb,
  outcome,
  ownerDb,
  planOf,
  PRINCIPALS,
  seedBusiness,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const ACTOR = 'operator:od50-test';

/** The SQL writer, called directly as `db` (the boundary, not the TypeScript validation). */
const writer = (
  businessId: string,
  plan: string,
  interval: string | null,
  reason: string | null = null,
  db = operatorDb,
) =>
  outcome(
    withBusiness(db, businessId, (tx) =>
      tx.execute(sql`SELECT subscription_operator_set_plan(${businessId}::uuid, ${plan},
        ${interval}, ${ACTOR}, ${reason})`),
    ),
  );

const row = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{
      plan: string;
      ends: string | null;
      cycle: string | null;
      txnow: string;
      interval: string;
    }>(sql`SELECT plan, to_char(plan_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ends,
             to_char(cycle_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cycle,
             now()::text AS txnow, billing_interval AS interval
           FROM businesses WHERE id = ${businessId}::uuid`)),
  ][0]!;

const audits = async (businessId: string) => [
  ...(await ownerDb.execute<{ action: string; reason: string | null; new_value: { plan: string } }>(
    sql`SELECT action, reason, new_value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'business' ORDER BY created_at`,
  )),
];

/** The database's own standard end for `from` (the writer's rule, called at a fixed instant). */
const dbEnd = async (from: string, interval: 'monthly' | 'annual') =>
  [
    ...(await ownerDb.execute<{ at: string }>(sql`
      SELECT to_char(rekoda_private.add_billing_interval(${from}::timestamptz, ${interval})
        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at`)),
  ][0]!.at;

describe('OD-50: the operator writer assigns the standard period, never a chosen date (0207)', () => {
  it('has no date argument: the five-argument date writer of 0203 no longer exists', async () => {
    const businessId = await seedBusiness();
    const shorter = new Date(Date.now() + 20 * 86_400_000).toISOString();
    expect(
      await outcome(
        withBusiness(operatorDb, businessId, (tx) =>
          tx.execute(sql`SELECT subscription_operator_set_plan(${businessId}::uuid, 'chat',
            ${shorter}::timestamptz, 'monthly', ${ACTOR})`),
        ),
      ),
    ).toMatch(/42883|function .* does not exist/);
    expect((await planOf(businessId))?.plan).toBe('trial');
  });

  /** Runs the writer and reads, in the SAME transaction, the `now()` it computed from. */
  const writeAndClock = async (businessId: string, plan: string, interval: string) =>
    [
      ...(await withBusiness(operatorDb, businessId, (tx) =>
        tx.execute<{ ends: string; at: string }>(sql`
          SELECT to_char(subscription_operator_set_plan(${businessId}::uuid, ${plan}, ${interval},
                   ${ACTOR}, NULL) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ends,
                 now()::text AS at`),
      )),
    ][0]!;

  const ruleFrom = async (at: string, interval: string) =>
    [
      ...(await ownerDb.execute<{ end: string }>(sql`
        SELECT to_char(date_trunc('milliseconds',
                 rekoda_private.add_billing_interval(${at}::timestamptz, ${interval}))
               AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end`)),
    ][0]!.end;

  it.each(['monthly', 'annual'] as const)(
    'a %s plan ends exactly one interval after the change, on the database clock',
    async (interval) => {
      const businessId = await seedBusiness();
      const { ends, at } = await writeAndClock(businessId, 'complete', interval);
      expect(ends).toBe(await ruleFrom(at, interval));
      expect((await row(businessId)).ends).toBe(ends);
      // The core rule agrees to the minute (core drops seconds).
      expect(
        Math.abs(new Date(ends).getTime() - addInterval(new Date(at), interval).getTime()),
      ).toBeLessThan(60_000);
    },
  );

  it.each([
    // [from, interval, expected]: month ends clamp, leap years, year ends, the Lagos day boundary.
    ['2027-01-31T09:00:00Z', 'monthly', '2027-02-28T09:00:00Z'],
    ['2028-01-31T09:00:00Z', 'monthly', '2028-02-29T09:00:00Z'],
    ['2028-02-29T09:00:00Z', 'annual', '2029-02-28T09:00:00Z'],
    ['2027-12-31T09:00:00Z', 'monthly', '2028-01-31T09:00:00Z'],
    ['2027-12-15T09:00:00Z', 'annual', '2028-12-15T09:00:00Z'],
    // 23:30Z on 31 March is 00:30 on 1 April in Lagos: a month later is 1 May in Lagos.
    ['2027-03-31T23:30:00Z', 'monthly', '2027-04-30T23:30:00Z'],
  ] as const)(
    'the standard end of %s (%s) is %s, as core computes',
    async (from, interval, end) => {
      expect(await dbEnd(from, interval)).toBe(end);
      expect(addInterval(new Date(from), interval).toISOString()).toBe(
        new Date(end).toISOString().replace(/:\d\d\.\d{3}Z$/, ':00.000Z'),
      );
    },
  );

  it('a trial ends exactly at the ORIGINAL trial start plus 14 days', async () => {
    const businessId = await seedBusiness();
    await writer(businessId, 'chat', 'monthly');
    expect(await writer(businessId, 'trial', null)).toBe('allowed');
    const p = (await planOf(businessId))!;
    expect(p.plan).toBe('trial');
    expect(new Date(p.plan_expires_at!).getTime() - new Date(p.trial_started_at).getTime()).toBe(
      336 * 3_600_000,
    );
  });

  it('a trial that has ended cannot be re-opened, and moving the start is not an operator power', async () => {
    const businessId = await seedBusiness();
    // The business signed up 15 days ago (set as the owner: no runtime role may move it).
    await ownerDb.execute(sql`UPDATE businesses
      SET trial_started_at = now() - interval '15 days',
          plan_expires_at = now() - interval '1 day' WHERE id = ${businessId}::uuid`);
    expect(await writer(businessId, 'trial', null)).toMatch(
      /22023.*trial has ended; a trial cannot be re-opened/,
    );
    expect((await planOf(businessId))?.plan).toBe('trial');
    expect(new Date((await planOf(businessId))!.plan_expires_at!).getTime()).toBeLessThan(
      Date.now(),
    );
    // The application and the operator cannot move the trial start (the cycle-input guard of 0206
    // covers the plan fields; the start itself is not writable outside signup).
    for (const db of [appDb, operatorDb]) {
      expect(
        await outcome(
          withBusiness(db, businessId, (tx) =>
            tx.execute(
              sql`UPDATE businesses SET trial_started_at = now() WHERE id = ${businessId}::uuid`,
            ),
          ),
        ),
      ).not.toBe('allowed');
    }
  });

  it('expired is the explicit early end: needs a reason, ends now, keeps history, audits it', async () => {
    const businessId = await seedBusiness();
    await writer(businessId, 'integrate', 'monthly');
    const paid = await row(businessId);
    expect(await writer(businessId, 'expired', null)).toMatch(/22023.*needs a reason/);
    expect(await writer(businessId, 'expired', null, '   ')).toMatch(/22023.*needs a reason/);
    expect(await writer(businessId, 'expired', null, 'bad\u0007reason')).toMatch(
      /22023.*invalid input/,
    );
    expect((await row(businessId)).plan).toBe('integrate');

    expect(await writer(businessId, 'expired', null, 'Customer asked to stop; ticket 4411')).toBe(
      'allowed',
    );
    const after = await row(businessId);
    expect(after.plan).toBe('expired');
    expect(new Date(after.ends!).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    const trail = await audits(businessId);
    const last = trail[trail.length - 1]!;
    expect(last.action).toBe('plan_changed');
    expect(last.reason).toBe('Customer asked to stop; ticket 4411');
    expect(last.new_value.plan).toBe('expired');
    // The previous cycle is kept in the audit row (the dates are history, not erased).
    const old = [
      ...(await ownerDb.execute<{ old_value: { cycleStartedAt: string; expiresAt: string } }>(
        sql`SELECT old_value FROM audit_events WHERE business_id = ${businessId}::uuid
            AND reason IS NOT NULL`,
      )),
    ][0]!.old_value;
    expect(old.cycleStartedAt).toBe(paid.cycle);
    expect(old.expiresAt).toBe(paid.ends);
    // Nothing was refunded or credited: no charge exists, none was written.
    const charges = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM subscription_charges WHERE business_id = ${businessId}::uuid`,
    );
    expect([...charges][0]!.n).toBe(0);
  });

  it.each(['app', 'worker', 'settlement'] as const)(
    '%s cannot run the operator writer, the period function or the refusal log',
    async (who) => {
      const businessId = await seedBusiness();
      const db = PRINCIPALS[who]();
      expect(await writer(businessId, 'complete', 'annual', null, db)).toMatch(
        /42501.*permission denied for function subscription_operator_set_plan/,
      );
      expect(
        await outcome(
          withBusiness(db, businessId, (tx) =>
            tx.execute(
              sql`SELECT subscription_operator_period_end(${businessId}::uuid, 'chat', 'monthly')`,
            ),
          ),
        ),
      ).toMatch(/42501/);
      expect(
        await outcome(
          db.execute(sql`SELECT operator_record_refusal(NULL, ${ACTOR}, 'plan_change', 'x')`),
        ),
      ).toMatch(/42501/);
      expect(
        await outcome(db.execute(sql`SELECT count(*) FROM rekoda_private.operator_refusals`)),
      ).toMatch(/42501/);
      expect((await planOf(businessId))?.plan).toBe('trial');
    },
  );

  it('the operator cannot change another business than the one pinned', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    expect(
      await outcome(
        withBusiness(operatorDb, a, (tx) =>
          tx.execute(sql`SELECT subscription_operator_set_plan(${b}::uuid, 'complete', 'annual',
            ${ACTOR}, NULL)`),
        ),
      ),
    ).toMatch(/42501.*not the pinned tenant/);
    expect((await planOf(b))?.plan).toBe('trial');
  });
});

describe('OD-50 through the repository the route calls (billingRepo.setPlan)', () => {
  it('refuses expired without a reason and a trial past its end, before writing', async () => {
    const businessId = await seedBusiness();
    await expect(
      billingRepo.setPlan(operatorDb, { businessId, plan: 'expired', actor: ACTOR }),
    ).rejects.toThrow(/needs a reason/);
    await ownerDb.execute(sql`UPDATE businesses SET trial_started_at = now() - interval '20 days',
      plan_expires_at = now() - interval '6 days' WHERE id = ${businessId}::uuid`);
    await expect(
      billingRepo.setPlan(operatorDb, { businessId, plan: 'trial', actor: ACTOR }),
    ).rejects.toThrow(/trial has ended/);
    expect((await audits(businessId)).length).toBe(0);
  });

  it('a refused attempt is recorded in its own transaction', async () => {
    const businessId = await seedBusiness();
    // The log lives outside the tenant tables, so the suite's truncation keeps it: read only ours.
    const ACTOR = `operator:od50-${randomUUID()}`;
    const refusals = async () => [
      ...(await ownerDb.execute<{ business_id: string | null; actor: string; refusal: string }>(
        sql`SELECT business_id, actor, refusal FROM rekoda_private.operator_refusals
            WHERE actor = ${ACTOR} ORDER BY id`,
      )),
    ];
    await billingRepo.recordOperatorRefusal(operatorDb, {
      businessId,
      actor: ACTOR,
      action: 'plan_change',
      refusal: 'ending a plan early needs a reason',
    });
    await billingRepo.recordOperatorRefusal(operatorDb, {
      businessId: null,
      actor: ACTOR,
      action: 'plan_change',
      refusal: 'no business\nwith that id',
    });
    expect(await refusals()).toEqual([
      { business_id: businessId, actor: ACTOR, refusal: 'ending a plan early needs a reason' },
      { business_id: null, actor: ACTOR, refusal: 'no business with that id' },
    ]);
    await expect(
      billingRepo.recordOperatorRefusal(operatorDb, {
        businessId: null,
        actor: 'system',
        action: 'plan_change',
        refusal: 'x',
      }),
    ).rejects.toThrow();
  });

  it('writes the cycle beside the standard end: same instant, Lagos anchor day', async () => {
    const businessId = await seedBusiness();
    expect(
      await billingRepo.setPlan(operatorDb, {
        businessId,
        plan: 'complete',
        billingInterval: 'annual',
        actor: ACTOR,
        reason: 'Paid by bank transfer, receipt 99',
      }),
    ).toBe(true);
    const after = [
      ...(await ownerDb.execute<{
        ends: string;
        anchor: number;
        origin: string;
        reason: string;
      }>(sql`
        SELECT to_char(b.plan_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ends, b.renewal_anchor_day AS anchor,
               b.subscription_origin AS origin,
               (SELECT reason FROM audit_events a WHERE a.business_id = b.id
                  ORDER BY created_at DESC LIMIT 1) AS reason
        FROM businesses b WHERE b.id = ${businessId}::uuid`)),
    ][0]!;
    const ends = new Date(after.ends);
    expect(after.anchor).toBe(new Date(ends.getTime() + 3_600_000).getUTCDate());
    expect(after.origin).toBe('operator');
    expect(after.reason).toBe('Paid by bank transfer, receipt 99');
  });
});
