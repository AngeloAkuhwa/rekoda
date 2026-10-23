/**
 * The 14-day trial from Day 0 to a paid cycle, against real PostgreSQL
 * (OWN-27; backlog row 15).
 *
 * The existing trial tests pin one minute either side of a date they set by
 * hand. This file reads the date a NEW business actually gets and walks the
 * clock across it: Day 0, 1, 7, 13, the last millisecond, the exact expiry
 * and after. It also holds the two halves of "time AND usage bound the
 * trial" against each other, and what an upgrade before, at and after expiry
 * leaves behind (a paid plan, never a second trial).
 *
 * `planFor` takes `now`, so the clock here is a parameter, not a fake timer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { allowanceFor, TRIAL_DAYS } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, subscriptionsRepo, usageRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const DAY = 86_400_000;
const PERIOD = '2026-08';

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348140000007');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** The trial window exactly as the database recorded it for a new business. */
async function trialWindow(businessId: string): Promise<{ start: Date; end: Date }> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ created_at: string; plan_expires_at: string }>(sql`
      SELECT created_at, plan_expires_at FROM businesses WHERE id = ${businessId}::uuid
    `),
  );
  const row = [...rows][0]!;
  return { start: new Date(row.created_at), end: new Date(row.plan_expires_at) };
}

const planAt = (businessId: string, now: Date) =>
  withBusiness(db, businessId, (tx) => usageRepo.planFor(tx, businessId, now));

const lapseAt = (businessId: string, now: Date) =>
  withBusiness(db, businessId, (tx) => usageRepo.lapseOf(tx, businessId, now));

/** One AI action, gated the way the chat path gates it: plan at `now`, then the meter. */
async function spend(businessId: string, now: Date): Promise<boolean> {
  const plan = await planAt(businessId, now);
  return withBusiness(db, businessId, (tx) =>
    usageRepo.consumeUnit(tx, businessId, PERIOD, 'AI_ACTIONS', allowanceFor(plan, 'AI_ACTIONS')),
  );
}

describe('the trial clock across its 14 days', () => {
  it('ends TRIAL_DAYS x 24h after the business started', async () => {
    const businessId = await seedBusiness();
    const { start, end } = await trialWindow(businessId);
    expect(TRIAL_DAYS).toBe(14);
    // The date is stamped by the app a few milliseconds after the row's own
    // created_at default, so this is a window, not an equality.
    expect(Math.abs(end.getTime() - start.getTime() - 14 * DAY)).toBeLessThan(1_000);
  });

  it('is a trial on Day 0, 1, 7, 13 and the last millisecond, and expired from the exact end', async () => {
    const businessId = await seedBusiness();
    const { start, end } = await trialWindow(businessId);

    for (const day of [0, 1, 7, 13]) {
      const at = new Date(start.getTime() + day * DAY);
      expect(await planAt(businessId, at), `day ${day}`).toBe('trial');
      expect(await lapseAt(businessId, at), `day ${day}`).toBeNull();
    }
    const lastMoment = new Date(end.getTime() - 1);
    expect(await planAt(businessId, lastMoment)).toBe('trial');
    expect(await lapseAt(businessId, lastMoment)).toBeNull();

    // The expiry instant itself belongs to the lapsed side: no overlap, no gap.
    expect(await planAt(businessId, end)).toBe('expired');
    expect(await lapseAt(businessId, end)).toBe('trial');
    const justAfter = new Date(end.getTime() + 1);
    expect(await planAt(businessId, justAfter)).toBe('expired');
    expect(await planAt(businessId, new Date(end.getTime() + 30 * DAY))).toBe('expired');
  });
});

describe('time and usage both bound the trial', () => {
  it('refuses at the allowance with days to spare, and does not reopen with time left', async () => {
    const businessId = await seedBusiness();
    const { start } = await trialWindow(businessId);
    const allowance = allowanceFor('trial', 'AI_ACTIONS');
    const dayThree = new Date(start.getTime() + 3 * DAY);

    for (let i = 0; i < allowance; i++) expect(await spend(businessId, dayThree)).toBe(true);
    expect(await spend(businessId, dayThree)).toBe(false);
    // Day 13 is still a trial, and still has nothing left.
    expect(await spend(businessId, new Date(start.getTime() + 13 * DAY))).toBe(false);

    const [row] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(row?.used).toBe(allowance); // refusals leave no residue
  });

  it('refuses after Day 14 though most of the allowance is unused, and leaves the meter alone', async () => {
    const businessId = await seedBusiness();
    const { start, end } = await trialWindow(businessId);
    expect(await spend(businessId, new Date(start.getTime() + DAY))).toBe(true);

    expect(await spend(businessId, new Date(end.getTime() - 1))).toBe(true); // last moment
    expect(await spend(businessId, end)).toBe(false); // expiry instant
    expect(await spend(businessId, new Date(end.getTime() + 7 * DAY))).toBe(false);

    const [row] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(row?.used).toBe(2); // 48 trial units were never spent and nothing was taken
    expect(allowanceFor('trial', 'AI_ACTIONS')).toBeGreaterThan(2);
  });
});

describe('upgrading before, at and after the trial ends', () => {
  const paidCycle = (from: Date) => ({
    plan: 'chat',
    cycleStartedAt: from,
    renewsAt: new Date(from.getTime() + 30 * DAY),
    anchorDay: from.getUTCDate(),
  });

  for (const [label, offsetFromEnd] of [
    ['a week before expiry', -7 * DAY],
    ['in the last millisecond', -1],
    ['at the exact expiry', 0],
    ['a week after expiry', 7 * DAY],
  ] as const) {
    it(`activates the paid plan when the cycle is paid ${label}`, async () => {
      const businessId = await seedBusiness();
      const { end } = await trialWindow(businessId);
      const paidAt = new Date(end.getTime() + offsetFromEnd);

      await withBusiness(db, businessId, (tx) =>
        subscriptionsRepo.applyCycle(tx, businessId, paidCycle(paidAt)),
      );

      expect(await planAt(businessId, paidAt)).toBe('chat');
      expect(await lapseAt(businessId, paidAt)).toBeNull();
      // The old trial date never reaches back and expires what was bought.
      expect(await planAt(businessId, new Date(end.getTime() + 8 * DAY))).toBe('chat');
      const sub = await withBusiness(db, businessId, (tx) =>
        subscriptionsRepo.subscriptionFor(tx, businessId),
      );
      expect(sub?.planExpiresAt?.getTime()).toBe(paidAt.getTime() + 30 * DAY);
    });
  }

  it('never hands a second trial back when the paid plan ends', async () => {
    const businessId = await seedBusiness();
    const { end } = await trialWindow(businessId);
    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, paidCycle(new Date(end.getTime() - DAY))),
    );
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE businesses SET payment_failed_at = now() WHERE id = ${businessId}::uuid`,
      ),
    );
    const expired = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.expireSubscription(tx, businessId, 'test', 'grace'),
    );
    expect(expired).toBe('chat');

    // Well inside what would have been fresh trial days, if one were granted.
    const later = new Date(end.getTime() + 60 * DAY);
    expect(await planAt(businessId, later)).toBe('expired');
    expect(await lapseAt(businessId, later)).toBe('plan'); // told "plan ended", never "trial"
    expect(allowanceFor('expired', 'AI_ACTIONS')).toBe(0);
    expect(await spend(businessId, later)).toBe(false);
  });
});
