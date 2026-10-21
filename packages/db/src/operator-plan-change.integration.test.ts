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
import { createDb, withBusiness, type Db, type TenantDb } from './client.js';
import { billingRepo, identity, planCatalogueRepo, subscriptionsRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

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
  await closeApp?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
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
    await subscriptionsRepo.applyCycle(tx, businessId, {
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

const operator = (businessId: string, plan: string, expiresAt: Date | null) =>
  billingRepo.setPlan(appDb, { businessId, plan, expiresAt, actor: 'operator:test-g62' });

describe('an operator move to a paid plan (G-62)', () => {
  it('drops the old subscription state and pins the new plan', async () => {
    const businessId = await troubledComplete();
    const renews = new Date('2027-01-15T10:00:00Z');
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
    // 23:30Z on the 31st is 00:30 on 1 February in Lagos.
    await operator(businessId, 'chat', new Date('2027-01-31T23:30:00Z'));
    expect((await row(businessId)).renewal_anchor_day).toBe(1);
  });

  it('keeps the grandfathered version when the plan is unchanged', async () => {
    const businessId = await troubledComplete();
    const pinned = (await row(businessId)).plan_version_id;
    // A newer Complete exists and is now current: a re-pin would choose it.
    const v2 = await publishNewerVersion('complete');
    expect(v2).not.toBe(pinned);

    await operator(businessId, 'complete', new Date('2027-02-01T00:00:00Z'));

    const after = await row(businessId);
    expect(after.plan_version_id).toBe(pinned);
    expect(after.pending_plan).toBeNull();
    expect(after.payment_failed_at).toBeNull();
  });

  it("re-pins to the current version of the new plan, never keeping another plan's pin", async () => {
    const businessId = await troubledComplete();
    const chatV2 = await publishNewerVersion('chat');

    await operator(businessId, 'chat', new Date('2027-01-15T10:00:00Z'));

    const after = await row(businessId);
    expect(after.version_plan).toBe('chat');
    expect(after.plan_version_id).toBe(chatV2);
  });

  it('re-posting the same plan and expiry keeps the cycle start', async () => {
    const businessId = await troubledComplete();
    // Same plan, same renewal date as the cycle already running.
    await operator(businessId, 'complete', RENEWS_AT);
    const after = await row(businessId);
    expect(new Date(after.cycle_started_at!).toISOString()).toBe(CYCLE_START.toISOString());
    // The stale bookkeeping is still cleared.
    expect(after.pending_plan).toBeNull();
    expect(after.payment_failed_at).toBeNull();

    // A repeat of an operator grant does not move its start either.
    const renews = new Date('2027-01-15T10:00:00Z');
    await operator(businessId, 'chat', renews);
    const first = (await row(businessId)).cycle_started_at;
    await operator(businessId, 'chat', renews);
    expect((await row(businessId)).cycle_started_at).toBe(first);

    // A different expiry is a new cycle: it starts now.
    const before = Date.now();
    await operator(businessId, 'chat', new Date('2027-03-15T10:00:00Z'));
    const moved = new Date((await row(businessId)).cycle_started_at!).getTime();
    expect(moved).toBeGreaterThanOrEqual(before - 1_000);
  });

  it('a paid move starts a fresh cycle when none existed (never-paid trial)', async () => {
    const businessId = await seedBusiness();
    const before = Date.now();
    await operator(businessId, 'chat', new Date('2027-01-15T10:00:00Z'));
    const after = await row(businessId);
    expect(after.ever_paid_at).not.toBeNull();
    const started = new Date(after.cycle_started_at!).getTime();
    expect(started).toBeGreaterThanOrEqual(before - 1_000);
    expect(started).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('an open-ended paid plan has no renewal anchor and invents no renewal date', async () => {
    const businessId = await troubledComplete();

    await operator(businessId, 'integrate', null);

    const after = await row(businessId);
    expect(after.plan).toBe('integrate');
    expect(after.plan_expires_at).toBeNull();
    expect(after.renewal_anchor_day).toBeNull();
    // No dated cycle: a start that never advances would age the upgrade proration.
    expect(after.cycle_started_at).toBeNull();
    expect(after.version_plan).toBe('integrate');
    expect(after.pending_plan).toBeNull();
    expect(after.payment_failed_at).toBeNull();
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

      await operator(businessId, plan, new Date('2026-12-01T00:00:00Z'));

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
    await operator(businessId, 'chat', new Date('2027-01-15T10:00:00Z'));
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
