/**
 * One merchant's subscription from trial to reactivation, against real
 * PostgreSQL (backlog row 15, second slice).
 *
 * The lifecycle is already covered rule by rule (`subscriptions`, `usage`,
 * `operator-plan-change`, the api billing suites). What none of them does is
 * walk ONE business through the whole sequence and read the entitlement and
 * the meter at every step, which is where a state that is right in isolation
 * can still leave the next step wrong:
 *
 *   trial -> first paid plan -> mid-cycle upgrade -> scheduled downgrade
 *   -> renewal onto the downgrade -> cancel -> expiry -> reactivation
 *
 * It uses the same repo calls the settlement and sweep paths use
 * (`applyCycle`, `schedulePlanChange`, `dueForRenewal`, `expireSubscription`),
 * with an injected clock, so no payment provider is involved.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allowanceFor, addMonth, usagePeriod } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, subscriptionsRepo, usageRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let worker: Db;
let closeDb: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  ({ db: worker, close: closeWorker } = createDb(urls.worker, { max: 2 }));
});

afterAll(async () => {
  await closeDb?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const DOCS = 'DOCUMENT_GENERATION' as const;

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348140000011');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const inTenant = <T>(businessId: string, fn: Parameters<typeof withBusiness<T>>[2]) =>
  withBusiness(db, businessId, fn);

const planAt = (businessId: string, now: Date) =>
  inTenant(businessId, (tx) => usageRepo.planFor(tx, businessId, now));

/** One generated document, gated the way the document path gates it: plan at `now`, then the meter. */
async function generate(businessId: string, now: Date): Promise<boolean> {
  const plan = await planAt(businessId, now);
  return inTenant(businessId, (tx) =>
    usageRepo.consumeUnit(tx, businessId, usagePeriod(now), DOCS, allowanceFor(plan, DOCS)),
  );
}

/** What settling a paid plan charge writes (a first purchase or a renewal). */
async function payCycle(businessId: string, plan: string, start: Date, anchorDay: number) {
  await inTenant(businessId, (tx) =>
    subscriptionsRepo.applyCycle(tx, businessId, {
      plan,
      cycleStartedAt: start,
      renewsAt: addMonth(start, anchorDay),
      anchorDay,
    }),
  );
}

const subOf = (businessId: string) =>
  inTenant(businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId));

describe('one merchant, trial to reactivation', () => {
  it('keeps plan, entitlement, renewal date and meter coherent at every step', async () => {
    const businessId = await seedBusiness();

    // Trial: the trial allowance, and it is the smallest of the paid ladder.
    const now = new Date();
    expect(await planAt(businessId, now)).toBe('trial');
    expect(allowanceFor('trial', DOCS)).toBeGreaterThan(0);

    // First paid plan, mid-trial: Chat, with a cycle of its own.
    const start = new Date('2026-11-02T09:00:00Z');
    const anchor = 2;
    await payCycle(businessId, 'chat', start, anchor);
    const chat = await subOf(businessId);
    expect(chat?.plan).toBe('chat');
    expect(chat?.planExpiresAt?.toISOString()).toBe(addMonth(start, anchor).toISOString());
    expect(await planAt(businessId, start)).toBe('chat');

    // Mid-cycle upgrade to Complete: the new plan's allowance, the SAME renewal date.
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, {
        plan: 'complete',
        cycleStartedAt: start,
        renewsAt: addMonth(start, anchor),
        anchorDay: anchor,
      }),
    );
    const complete = await subOf(businessId);
    expect(complete?.plan).toBe('complete');
    expect(complete?.planExpiresAt?.toISOString()).toBe(addMonth(start, anchor).toISOString());
    expect(allowanceFor('complete', DOCS)).toBeGreaterThan(allowanceFor('chat', DOCS));

    // Use the meter this month, then schedule a downgrade: nothing moves yet.
    const midCycle = new Date('2026-11-10T09:00:00Z');
    expect(await generate(businessId, midCycle)).toBe(true);
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'integrate'),
    );
    const parked = await subOf(businessId);
    expect(parked?.plan).toBe('complete');
    expect(parked?.pendingPlan).toBe('integrate');
    expect(parked?.planExpiresAt?.toISOString()).toBe(addMonth(start, anchor).toISOString());

    // Not due before the cycle ends; due, naming the downgrade, once it has.
    const renewsAt = addMonth(start, anchor);
    expect(
      (await subscriptionsRepo.dueForRenewal(worker, new Date(renewsAt.getTime() - 1))).filter(
        (d) => d.businessId === businessId,
      ),
    ).toHaveLength(0);
    const [due] = (await subscriptionsRepo.dueForRenewal(worker, renewsAt)).filter(
      (d) => d.businessId === businessId,
    );
    expect(due?.plan).toBe('complete');
    expect(due?.nextPlan).toBe('integrate');

    // The renewal is paid: the downgrade takes effect, the schedule clears, the date moves a month on.
    await payCycle(businessId, 'integrate', renewsAt, anchor);
    const renewed = await subOf(businessId);
    expect(renewed?.plan).toBe('integrate');
    expect(renewed?.pendingPlan).toBeNull();
    expect(renewed?.planExpiresAt?.toISOString()).toBe(addMonth(renewsAt, anchor).toISOString());

    // A new billing month is a fresh meter: this month's use does not follow the merchant.
    const nextMonth = new Date(renewsAt.getTime() + 86_400_000);
    expect(usagePeriod(nextMonth)).not.toBe(usagePeriod(midCycle));
    const used = await inTenant(businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(nextMonth)),
    );
    expect(used.find((r) => r.unit === DOCS)?.used ?? 0).toBe(0);
    expect(await generate(businessId, nextMonth)).toBe(true);

    // Cancel: the stop is scheduled, the plan stays until the cycle ends, then the sweep expires it.
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
    );
    expect((await subOf(businessId))?.plan).toBe('integrate');
    const stopped = await inTenant(businessId, (tx) =>
      subscriptionsRepo.expireSubscription(tx, businessId, 'test', 'cancelled'),
    );
    expect(stopped).toBe('integrate');

    // Expired: no allowance, and the trial does not come back however long it has been.
    const later = new Date(renewsAt.getTime() + 90 * 86_400_000);
    expect(await planAt(businessId, later)).toBe('expired');
    expect(await generate(businessId, later)).toBe(false);

    // Reactivation: paying again buys a plan and a full cycle from the day paid, and the meter works.
    await payCycle(businessId, 'chat', later, 1);
    const back = await subOf(businessId);
    expect(back?.plan).toBe('chat');
    expect(back?.pendingPlan).toBeNull();
    expect(back?.cycleStartedAt?.toISOString()).toBe(later.toISOString());
    expect(back?.planExpiresAt?.getTime()).toBeGreaterThan(later.getTime());
    expect(await planAt(businessId, later)).toBe('chat');
    expect(await generate(businessId, later)).toBe(true);
  });
});
