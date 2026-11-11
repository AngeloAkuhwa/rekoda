/**
 * An operator plan change leaves ONE coherent subscription (G-62).
 *
 * `POST /v1/businesses/plan` used to write only plan, plan_expires_at and
 * ever_paid_at. Everything a real paid cycle keeps beside them survived the
 * move: a downgrade scheduled for the old plan, a failed renewal and its
 * grace reminders, the plan-version pin of the OLD plan and the old cycle
 * dates. The renewal sweep and the billing page then read a contradiction.
 *
 * Each case builds the stale state the way production does (a paid cycle,
 * a scheduled downgrade, a failed renewal, a claimed grace reminder), moves
 * the business through the repo the operator route calls, and asserts the
 * row. Nothing here assumes how the fix is written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { addInterval } from '@rekoda/core';
import { createDb, withBusiness, type Db, type TenantDb } from '../client.js';
import { billingRepo, identity, planCatalogueRepo, subscriptionsRepo } from '../index.js';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  resetPlanCatalogue,
  setPlanAsOwner,
  truncateAll,
  type Urls,
} from '../testing.js';
import { operatorDb } from '../testing.js';

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;
let ownerDb: Db;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  // The catalogue tables survive truncateAll; leave them as the migrations seeded them.
  await resetPlanCatalogue(urls);
  await closeApp?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  await resetPlanCatalogue(urls);
});

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481500000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Operator Plan Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const inTenant = <T>(businessId: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> =>
  withBusiness(appDb, businessId, fn);

const CYCLE_START = new Date('2026-08-01T00:00:00Z');
const RENEWS_AT = new Date('2026-09-01T00:00:00Z');
/** Operator dates are relative to today: a paid plan ends in the future and within its interval
 * (owner review of #432, migration 0203), so a fixed calendar date would expire with the calendar. */
const daysFromNow = (days: number, hourUtc = 10) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};
const FUTURE_RENEWS_AT = daysFromNow(300, 0);
/** The 15th of a month at 10:00Z, 2 to 3 months ahead: inside an annual plan's window. */
const fifteenth = (() => {
  const d = new Date(Date.now() + 70 * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15, 10, 0, 0));
})();
/** The last day of a month, 23:30Z, 2 to 3 months ahead: 00:30 on the 1st in Lagos. */
const monthEndLateUtc = (() => {
  const d = new Date(Date.now() + 70 * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 30, 0));
})();
/** The next 28 February (a non-leap year's month end) and the 31 January before it. */
const nextFeb28 = (() => {
  const now = new Date();
  let year = now.getUTCFullYear();
  if (now.getTime() >= Date.UTC(year, 1, 27)) year += 1;
  while ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) year += 1;
  return new Date(Date.UTC(year, 1, 28, 0, 0, 0));
})();
const jan31Before = (feb28: Date) => new Date(Date.UTC(feb28.getUTCFullYear(), 0, 31, 0, 0, 0));

type Row = {
  plan: string;
  plan_expires_at: string | null;
  cycle_started_at: string | null;
  renewal_anchor_day: number | null;
  pending_plan: string | null;
  payment_failed_at: string | null;
  last_grace_reminder_day: number | null;
  plan_version_id: string | null;
  version_plan: string | null;
  ever_paid_at: string | null;
};

async function row(businessId: string): Promise<Row> {
  const rows = await inTenant(businessId, (tx) =>
    tx.execute<Row>(sql`
      SELECT b.plan, b.plan_expires_at, b.cycle_started_at, b.renewal_anchor_day,
             b.pending_plan, b.payment_failed_at, b.last_grace_reminder_day,
             b.plan_version_id, pv.plan_id AS version_plan, b.ever_paid_at
      FROM businesses b LEFT JOIN plan_versions pv ON pv.id = b.plan_version_id
      WHERE b.id = ${businessId}::uuid
    `),
  );
  return [...rows][0]!;
}

/** A paid Complete subscription that has failed a renewal and scheduled Chat. */
async function troubledComplete(): Promise<string> {
  const businessId = await seedBusiness();
  await inTenant(businessId, async (tx) => {
    await applyFixtureCycle(tx, businessId, {
      plan: 'complete',
      cycleStartedAt: CYCLE_START,
      renewsAt: RENEWS_AT,
      anchorDay: 1,
    });
    await subscriptionsRepo.schedulePlanChange(tx, businessId, 'chat');
    await subscriptionsRepo.markRenewalFailed(tx, businessId, new Date('2026-09-01T02:00:00Z'));
    await subscriptionsRepo.claimGraceReminder(tx, businessId, 1);
  });
  const before = await row(businessId);
  expect(before.version_plan).toBe('complete');
  expect(before.pending_plan).toBe('chat');
  expect(before.payment_failed_at).not.toBeNull();
  expect(before.last_grace_reminder_day).toBe(1);
  return businessId;
}

/**
 * Publish a newer catalogue version of a plan, effective now. Grandfathering
 * is only observable when more than one version exists: with a single version
 * per plan a re-pin would select the very row the business already holds.
 */
async function publishNewerVersion(planId: string): Promise<string> {
  return planCatalogueRepo.publishPlanVersion(ownerDb, {
    planId,
    name: `Rekoda ${planId}`,
    seats: 1,
    effectiveFrom: new Date(Date.now() - 60_000),
    entitlements: ['REKODA_CHAT'],
    allowances: { AI_ACTIONS: 300, VOICE_MINUTES: 60, DOCUMENT_GENERATION: 100 },
    prices: [{ currency: 'NGN', billingInterval: 'monthly', amountMinor: 1_490_000 }],
  });
}

const operatorMonthly = (businessId: string, expiresAt: Date) =>
  billingRepo.setPlan(operatorDb(), {
    businessId,
    plan: 'chat',
    expiresAt,
    billingInterval: 'monthly',
    actor: 'operator:test-g62',
  });

/** The real operator path (OD-37): the billing-operator principal, an annual interval for a paid
 * plan so the G-62 cases can use dates a few months out. */
const operator = (businessId: string, plan: string, expiresAt: Date | null) =>
  billingRepo.setPlan(operatorDb(), {
    businessId,
    plan,
    expiresAt,
    ...(plan === 'trial' || plan === 'expired' ? {} : { billingInterval: 'annual' as const }),
    actor: 'operator:test-g62',
  });

describe('an operator move to a paid plan (G-62)', () => {
  it('drops the old subscription state and pins the new plan', async () => {
    const businessId = await troubledComplete();
    const renews = fifteenth;
    const before = Date.now();

    expect(await operator(businessId, 'chat', renews)).toBe(true);

    const after = await row(businessId);
    expect(after.plan).toBe('chat');
    expect(after.plan_expires_at).not.toBeNull();
    expect(new Date(after.plan_expires_at!).toISOString()).toBe(renews.toISOString());
    // The downgrade, the failed renewal and its reminders described the old subscription.
    expect(after.pending_plan).toBeNull();
    expect(after.payment_failed_at).toBeNull();
    expect(after.last_grace_reminder_day).toBeNull();
    // Never Chat carrying Complete's terms.
    expect(after.version_plan).toBe('chat');
    // The cycle the operator started is truthful: it began now, not in August.
    expect(new Date(after.cycle_started_at!).getTime()).toBeGreaterThanOrEqual(before - 1_000);
    // The next renewal is the operator's date, so it anchors to that Lagos day.
    expect(after.renewal_anchor_day).toBe(15);
    expect(after.ever_paid_at).not.toBeNull();
  });

  it('anchors to the Lagos day, not the UTC day', async () => {
    const businessId = await troubledComplete();
    // 23:30Z on a month's last day is 00:30 on the 1st in Lagos.
    await operator(businessId, 'chat', monthEndLateUtc);
    expect((await row(businessId)).renewal_anchor_day).toBe(1);
  });

  it('keeps the grandfathered version when the plan is unchanged', async () => {
    const businessId = await troubledComplete();
    const pinned = (await row(businessId)).plan_version_id;
    // A newer Complete exists and is now current: a re-pin would choose it.
    const v2 = await publishNewerVersion('complete');
    expect(v2).not.toBe(pinned);

    await operator(businessId, 'complete', daysFromNow(80, 0));

    const after = await row(businessId);
    expect(after.plan_version_id).toBe(pinned);
    expect(after.pending_plan).toBeNull();
    expect(after.payment_failed_at).toBeNull();
  });

  it("re-pins to the current version of the new plan, never keeping another plan's pin", async () => {
    const businessId = await troubledComplete();
    const chatV2 = await publishNewerVersion('chat');

    await operator(businessId, 'chat', fifteenth);

    const after = await row(businessId);
    expect(after.version_plan).toBe('chat');
    expect(after.plan_version_id).toBe(chatV2);
  });

  it('re-posting the same plan and expiry keeps the cycle start', async () => {
    const businessId = await troubledComplete();
    // An operator re-post carries a future date (G-114, the route's rule), so the cycle
    // already running is moved to renew in the future first, as it would after a renewal.
    await setPlanAsOwner(urls, businessId, { planExpiresAt: FUTURE_RENEWS_AT });
    // ...on an annual cycle, the interval the operator re-posts (a different interval is a new cycle).
    await ownerDb.execute(
      sql`UPDATE businesses SET billing_interval = 'annual' WHERE id = ${businessId}::uuid`,
    );
    // Same plan, same renewal date as the cycle already running.
    await operator(businessId, 'complete', FUTURE_RENEWS_AT);
    const after = await row(businessId);
    expect(new Date(after.cycle_started_at!).toISOString()).toBe(CYCLE_START.toISOString());
    // The stale bookkeeping is still cleared.
    expect(after.pending_plan).toBeNull();
    expect(after.payment_failed_at).toBeNull();

    // A repeat of an operator grant does not move its start either.
    const renews = fifteenth;
    await operator(businessId, 'chat', renews);
    const first = (await row(businessId)).cycle_started_at;
    await operator(businessId, 'chat', renews);
    expect((await row(businessId)).cycle_started_at).toBe(first);

    // A different expiry is a new cycle: it starts now.
    const before = Date.now();
    await operator(businessId, 'chat', daysFromNow(120));
    const moved = new Date((await row(businessId)).cycle_started_at!).getTime();
    expect(moved).toBeGreaterThanOrEqual(before - 1_000);
  });

  it('re-posting a clamped short-month renewal keeps the cycle anchor day', async () => {
    const businessId = await seedBusiness();
    // Anchored to the 31st, so the January cycle renews on 28 February.
    const renews = nextFeb28;
    await inTenant(businessId, (tx) =>
      applyFixtureCycle(tx, businessId, {
        plan: 'complete',
        cycleStartedAt: jan31Before(renews),
        billingInterval: 'annual',
        renewsAt: renews,
        anchorDay: 31,
      }),
    );

    await operator(businessId, 'complete', renews);

    const after = await row(businessId);
    expect(after.renewal_anchor_day).toBe(31);
    expect(new Date(after.cycle_started_at!).toISOString()).toBe(jan31Before(renews).toISOString());
  });

  it('a paid move starts a fresh cycle when none existed (never-paid trial)', async () => {
    const businessId = await seedBusiness();
    const before = Date.now();
    await operator(businessId, 'chat', fifteenth);
    const after = await row(businessId);
    expect(after.ever_paid_at).not.toBeNull();
    const started = new Date(after.cycle_started_at!).getTime();
    expect(started).toBeGreaterThanOrEqual(before - 1_000);
    expect(started).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('no date asks for exactly one period: an operator can no longer make a paid plan open-ended', async () => {
    const businessId = await troubledComplete();
    const before = new Date();

    await billingRepo.setPlan(operatorDb(), {
      businessId,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test-g62',
    });

    const after = await row(businessId);
    expect(after.plan).toBe('integrate');
    // Monthly by default: one calendar month from now (core addInterval), never null.
    const expected = addInterval(before, 'monthly');
    expect(Math.abs(new Date(after.plan_expires_at!).getTime() - expected.getTime())).toBeLessThan(
      120_000,
    );
    expect(after.renewal_anchor_day).toBe(new Date(expected.getTime() + 3_600_000).getUTCDate());
    expect(after.cycle_started_at).not.toBeNull();
    expect(after.version_plan).toBe('integrate');
    expect(after.pending_plan).toBeNull();
    expect(after.payment_failed_at).toBeNull();
  });
});

describe('an operator re-post that changes only the interval (owner review of #432)', () => {
  const intervalOf = async (businessId: string) =>
    [
      ...(await inTenant(businessId, (tx) =>
        tx.execute<{ interval: string }>(
          sql`SELECT billing_interval AS interval FROM businesses WHERE id = ${businessId}::uuid`,
        ),
      )),
    ][0]!.interval;
  const auditedInterval = async (businessId: string) =>
    [
      ...(await inTenant(businessId, (tx) =>
        tx.execute<{ interval: string | null }>(sql`
          SELECT new_value->>'billingInterval' AS interval FROM audit_events
          WHERE business_id = ${businessId}::uuid AND action = 'plan_changed'
          ORDER BY created_at DESC LIMIT 1`),
      )),
    ][0]!.interval;

  it('records the interval it validated and audited: an annual cycle re-posted as monthly becomes monthly', async () => {
    const businessId = await seedBusiness();
    const renews = daysFromNow(20, 0);
    await inTenant(businessId, (tx) =>
      applyFixtureCycle(tx, businessId, {
        plan: 'complete',
        cycleStartedAt: new Date(renews.getTime() - 345 * 86_400_000),
        renewsAt: renews,
        anchorDay: new Date(renews.getTime() + 3_600_000).getUTCDate(),
        billingInterval: 'annual',
      }),
    );
    expect(await intervalOf(businessId)).toBe('annual');
    // Same plan and expiry, no interval named: the request means monthly (the default).
    await billingRepo.setPlan(operatorDb(), {
      businessId,
      plan: 'complete',
      expiresAt: renews,
      actor: 'operator:test-g62',
    });
    expect(await auditedInterval(businessId)).toBe('monthly');
    expect(await intervalOf(businessId)).toBe('monthly');
  });

  it('a monthly operator plan re-posted as annual becomes annual', async () => {
    const businessId = await seedBusiness();
    const renews = daysFromNow(20, 0);
    await operatorMonthly(businessId, renews);
    expect(await intervalOf(businessId)).toBe('monthly');
    await operator(businessId, 'chat', renews); // annual, same plan, same expiry
    expect(await auditedInterval(businessId)).toBe('annual');
    expect(await intervalOf(businessId)).toBe('annual');
  });
});

describe('an operator move back to trial or expired (G-62, OWN-28)', () => {
  for (const plan of ['trial', 'expired'] as const) {
    it(`${plan}: clears the paid-cycle state but never the paid history`, async () => {
      const businessId = await troubledComplete();
      const everPaid = (await row(businessId)).ever_paid_at;
      const pinned = (await row(businessId)).plan_version_id;
      expect(everPaid).not.toBeNull();
      // A newer Complete is current; the unpaid move must still not re-pin.
      expect(await publishNewerVersion('complete')).not.toBe(pinned);

      // No date: the rule's own (the business's trial end for a trial, now for expired).
      await operator(businessId, plan, null);

      const after = await row(businessId);
      expect(after.plan).toBe(plan);
      expect(after.pending_plan).toBeNull();
      expect(after.payment_failed_at).toBeNull();
      expect(after.last_grace_reminder_day).toBeNull();
      expect(after.cycle_started_at).toBeNull();
      expect(after.renewal_anchor_day).toBeNull();
      // The pin is kept for the day the plan resumes; reads ignore it while unpaid.
      expect(after.plan_version_id).toBe(pinned);
      // OWN-28: once paid, never an abandoned trial again.
      expect(after.ever_paid_at).toBe(everPaid);
    });
  }
});

describe('the audit trail survives', () => {
  it('still records plan_changed with the operator actor', async () => {
    const businessId = await troubledComplete();
    await operator(businessId, 'chat', fifteenth);
    const events = await inTenant(businessId, (tx) =>
      tx.execute<{ actor: string; action: string }>(sql`
        SELECT actor, action FROM audit_events
        WHERE business_id = ${businessId}::uuid AND action = 'plan_changed'
      `),
    );
    expect([...events]).toEqual([{ actor: 'operator:test-g62', action: 'plan_changed' }]);
    const old = await inTenant(businessId, (tx) =>
      tx.execute<{ old_value: { pendingPlan: string | null; paymentFailedAt: string | null } }>(sql`
        SELECT old_value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND action = 'plan_changed'
      `),
    );
    // What the move cleared stays traceable.
    expect([...old][0]!.old_value.pendingPlan).toBe('chat');
    expect([...old][0]!.old_value.paymentFailedAt).not.toBeNull();
  });
});
