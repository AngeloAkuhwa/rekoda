/**
 * Subscription persistence, against real PostgreSQL (ADR 0024).
 *
 * Three claims here cannot be made against a mock, and each of them is a way
 * a merchant gets billed wrongly:
 *
 *   1. A renewal sweep that runs twice charges once. That is a unique index,
 *      and a unique index either exists in the database or does not.
 *   2. A webhook delivered three times settles once. That is a conditional
 *      UPDATE, and its idempotency is the database's, not the caller's.
 *   3. One merchant cannot see another's charges. That is row-level security
 *      under the application's own credential, which a superuser connection
 *      would make pass for the wrong reason.
 */
// The subscriptions repository suite. Split by concern; the rest of this suite is in
// subscriptions.integration.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db, type TenantDb } from '../client.js';
import { identity, subscriptionsRepo } from '../index.js';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
  setPlanAsOwner,
  startGraceForTest,
} from '../testing.js';
import { settlementDb } from '../testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let phoneSeq = 0;

async function seedBusiness(name = 'Ada Fashion'): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481400000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const CYCLE_START = new Date('2026-08-01T00:00:00Z');
const RENEWS_AT = new Date('2026-09-01T00:00:00Z');

const inTenant = <T>(businessId: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> =>
  withBusiness(appDb, businessId, fn);
/** Charges are opened and paid only as `rekoda_settlement` (OD-37, 0202, 0205). */
const inSettlement = <T>(businessId: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> =>
  withBusiness(settlementDb(), businessId, fn);

describe('the sweeps', () => {
  async function paidBusiness(name: string, renewsAt: Date): Promise<string> {
    const businessId = await seedBusiness(name);
    await inTenant(businessId, (tx) =>
      applyFixtureCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: new Date(renewsAt.getTime() - 30 * 86_400_000),
        renewsAt,
        anchorDay: renewsAt.getUTCDate(),
      }),
    );
    return businessId;
  }

  const NOW = new Date('2026-09-01T06:00:00Z');

  it('finds paid businesses whose cycle has ended, and only those', async () => {
    const due = await paidBusiness('Due', new Date('2026-09-01T00:00:00Z'));
    await paidBusiness('NotYet', new Date('2026-09-20T00:00:00Z'));
    await seedBusiness('StillOnTrial'); // a trial is not a failed payment

    const rows = await subscriptionsRepo.dueForRenewal(workerDb, NOW);
    expect(rows.map((r) => r.businessId)).toEqual([due]);
    expect(rows[0]?.nextPlan).toBe('chat');
  });

  it('renews onto the scheduled downgrade when there is one', async () => {
    const businessId = await paidBusiness('Downgrading', new Date('2026-09-01T00:00:00Z'));
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'chat'),
    );
    await setPlanAsOwner(urls, businessId, { plan: 'complete' });

    const [row] = await subscriptionsRepo.dueForRenewal(workerDb, NOW);
    expect(row?.plan).toBe('complete');
    expect(row?.nextPlan).toBe('chat');
  });

  it('stops sweeping a business once its renewal has failed', async () => {
    const businessId = await paidBusiness('Failed', new Date('2026-09-01T00:00:00Z'));
    // As the sweep leaves it: a renewal charge for the ended cycle AND the
    // grace clock, in one step. This pins that a payable renewal for the cycle
    // keeps the business out of the due set; re-selection of a grace business
    // whose renewals went stale (and the failed-renewal no-spin case) is covered
    // in stale-charge-exceptions.integration.test.ts (G-104).
    await inTenant(businessId, async (tx) => {
      await subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'renewal',
        plan: 'chat',
        amountK: 990_000,
        reference: 'RKD-SUB-20260901-FAILED1',
        periodStart: new Date('2026-09-01T00:00:00Z'),
        periodEnd: new Date('2026-10-01T00:00:00Z'),
      });
      await startGraceForTest(tx, businessId, NOW);
    });

    // Otherwise every pass would open another charge against a card that is
    // already known to be declining.
    expect(await subscriptionsRepo.dueForRenewal(workerDb, NOW)).toHaveLength(0);
    const grace = await subscriptionsRepo.inGrace(workerDb);
    expect(grace.map((r) => r.businessId)).toEqual([businessId]);
    expect(grace[0]?.paymentFailedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('answers the sweep for the WORKER and nothing for the application', async () => {
    await paidBusiness('Due', new Date('2026-09-01T00:00:00Z'));
    expect(await subscriptionsRepo.dueForRenewal(workerDb, NOW)).toHaveLength(1);
    // The application's credential sees nothing without a pinned tenant, which
    // is exactly what stops a request handler running an estate-wide query.
    expect(await subscriptionsRepo.dueForRenewal(appDb, NOW)).toHaveLength(0);
  });

  it('resolves a reference to its tenant for the worker only', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'first_purchase',
        plan: 'chat',
        amountK: 990_000,
        reference: 'RK-NEW-1',
        periodStart: CYCLE_START,
        periodEnd: RENEWS_AT,
      }),
    );

    expect(await subscriptionsRepo.businessForCharge(workerDb, 'RK-NEW-1')).toBe(businessId);
    expect(await subscriptionsRepo.businessForCharge(appDb, 'RK-NEW-1')).toBeNull();
  });
});

describe('stopping a lapsed subscription', () => {
  it('is an ACT, with a row saying which plan was stopped and by what', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, (tx) =>
      applyFixtureCycle(tx, businessId, {
        plan: 'complete',
        cycleStartedAt: CYCLE_START,
        renewsAt: RENEWS_AT,
        anchorDay: 1,
      }),
    );
    await inTenant(businessId, (tx) => startGraceForTest(tx, businessId, RENEWS_AT));

    const previous = await inTenant(businessId, (tx) =>
      subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep', 'grace'),
    );
    expect(previous).toBe('complete');

    const sub = await inTenant(businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(sub?.plan).toBe('expired');

    const audit = await inTenant(businessId, (tx) =>
      tx.execute<{ actor: string; old_value: { plan: string }; source_type: string }>(sql`
        SELECT actor, old_value, source_type FROM audit_events
        WHERE business_id = ${businessId}::uuid AND action = 'subscription_expired'
      `),
    );
    const row = [...audit][0];
    // Which plan to resume is answerable later because it was written down.
    expect(row?.old_value.plan).toBe('complete');
    expect(row?.actor).toBe('system:grace-sweep');
    expect(row?.source_type).toBe('system');
  });

  /* G-106. The sweep reads, decides, then writes. A renewal paid, or a
   * cancel undone, between its read and its write keeps the SAME plan, so
   * re-checking only the plan name expired a merchant who had just paid. */
  it('keeps the plan of a merchant whose renewal is paid between the grace read and the write', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, async (tx) => {
      await applyFixtureCycle(tx, businessId, {
        plan: 'complete',
        cycleStartedAt: CYCLE_START,
        renewsAt: RENEWS_AT,
        anchorDay: 1,
      });
      await startGraceForTest(tx, businessId, RENEWS_AT);
    });
    // The sweep has read this business as out of grace. Now the renewal pays.
    await inTenant(businessId, (tx) =>
      applyFixtureCycle(tx, businessId, {
        plan: 'complete',
        cycleStartedAt: RENEWS_AT,
        renewsAt: new Date('2026-10-01T00:00:00Z'),
        anchorDay: 1,
      }),
    );

    expect(
      await inTenant(businessId, (tx) =>
        subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep', 'grace'),
      ),
    ).toBeNull();
    const sub = await inTenant(businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(sub?.plan).toBe('complete');
  });

  it('keeps the plan of a merchant who undoes a cancel between the renewal read and the write', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, async (tx) => {
      await applyFixtureCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: CYCLE_START,
        renewsAt: RENEWS_AT,
        anchorDay: 1,
      });
      await subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired');
    });
    // The sweep has read the cancel. Now the merchant undoes it.
    await inTenant(businessId, (tx) => subscriptionsRepo.schedulePlanChange(tx, businessId, null));

    expect(
      await inTenant(businessId, (tx) =>
        subscriptionsRepo.expireSubscription(tx, businessId, 'system:renewal_sweep', 'cancelled'),
      ),
    ).toBeNull();
    const sub = await inTenant(businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(sub?.plan).toBe('chat');
  });

  it('does nothing to a trial, which ends rather than lapses', async () => {
    const businessId = await seedBusiness();
    expect(
      await inTenant(businessId, (tx) =>
        subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep', 'grace'),
      ),
    ).toBeNull();
  });

  it('does nothing twice, so a second sweep pass writes no second row', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, (tx) =>
      applyFixtureCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: CYCLE_START,
        renewsAt: RENEWS_AT,
        anchorDay: 1,
      }),
    );
    await inTenant(businessId, (tx) => startGraceForTest(tx, businessId, RENEWS_AT));
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep', 'grace'),
    );
    expect(
      await inTenant(businessId, (tx) =>
        subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep', 'grace'),
      ),
    ).toBeNull();
  });
});

describe('the daily reminder claim', () => {
  it('is won once per day, by one caller', async () => {
    const businessId = await seedBusiness();
    // Two overlapping sweep passes, or two workers, against day 1.
    const races = await Promise.all(
      Array.from({ length: 5 }, () =>
        inTenant(businessId, (tx) => subscriptionsRepo.claimGraceReminder(tx, businessId, 1)),
      ),
    );
    expect(races.filter(Boolean)).toHaveLength(1);

    // Day 5 is a later day and may still be claimed.
    expect(
      await inTenant(businessId, (tx) => subscriptionsRepo.claimGraceReminder(tx, businessId, 5)),
    ).toBe(true);
    // A clock that jumped backwards cannot re-send day 1 afterwards.
    expect(
      await inTenant(businessId, (tx) => subscriptionsRepo.claimGraceReminder(tx, businessId, 1)),
    ).toBe(false);
  });

  it('is reset by a cycle that gets paid for', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, (tx) => subscriptionsRepo.claimGraceReminder(tx, businessId, 5));
    await inTenant(businessId, (tx) =>
      applyFixtureCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: CYCLE_START,
        renewsAt: RENEWS_AT,
        anchorDay: 1,
      }),
    );
    // The next failure is a fresh grace period, starting at day zero again.
    expect(
      await inTenant(businessId, (tx) => subscriptionsRepo.claimGraceReminder(tx, businessId, 1)),
    ).toBe(true);
  });
});
