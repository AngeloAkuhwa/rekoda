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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db, type TenantDb } from './client.js';
import { identity, subscriptionsRepo, usageRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

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

/**
 * Assert a rejection by REASON, walking the cause chain.
 *
 * Drizzle wraps a driver error in one that names the statement, so matching
 * only the top-level message would pass for any failure at all, including a
 * typo in the SQL.
 */
async function expectRejectionBecause(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const reasons: string[] = [];
    for (let e: unknown = error, depth = 0; e && depth < 10; depth++) {
      if (!(e instanceof Error)) {
        reasons.push(String(e));
        break;
      }
      reasons.push(e.message);
      e = (e as Error & { cause?: unknown }).cause;
    }
    expect(reasons.join(' | ')).toMatch(pattern);
    return;
  }
  throw new Error(`expected a rejection matching ${String(pattern)}, but it resolved`);
}

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

describe('the cycle on a business row', () => {
  it('writes plan, dates and anchor as one fact', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: CYCLE_START,
        renewsAt: RENEWS_AT,
        anchorDay: 1,
      }),
    );

    const sub = await inTenant(businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(sub?.plan).toBe('chat');
    expect(sub?.cycleStartedAt?.toISOString()).toBe(CYCLE_START.toISOString());
    expect(sub?.planExpiresAt?.toISOString()).toBe(RENEWS_AT.toISOString());
    expect(sub?.renewalAnchorDay).toBe(1);
    expect(sub?.pendingPlan).toBeNull();
  });

  it('clears the grace clock when a cycle is paid for', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: CYCLE_START,
        renewsAt: RENEWS_AT,
        anchorDay: 1,
      }),
    );
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.markRenewalFailed(tx, businessId, new Date('2026-09-01T02:00:00Z')),
    );
    expect(
      (await inTenant(businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId)))
        ?.paymentFailedAt,
    ).not.toBeNull();

    await inTenant(businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: RENEWS_AT,
        renewsAt: new Date('2026-10-01T00:00:00Z'),
        anchorDay: 1,
      }),
    );

    // A merchant who has paid must not keep receiving grace reminders.
    const sub = await inTenant(businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(sub?.paymentFailedAt).toBeNull();
  });

  it('runs the grace clock from the FIRST failure, not the latest retry', async () => {
    const businessId = await seedBusiness();
    const first = new Date('2026-09-01T02:00:00Z');
    await inTenant(businessId, (tx) => subscriptionsRepo.markRenewalFailed(tx, businessId, first));
    // A card retried daily must not push the deadline forward a day at a time.
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.markRenewalFailed(tx, businessId, new Date('2026-09-04T02:00:00Z')),
    );

    const sub = await inTenant(businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(sub?.paymentFailedAt?.toISOString()).toBe(first.toISOString());
  });

  it('parks a downgrade until the next renewal without moving anything else', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, {
        plan: 'complete',
        cycleStartedAt: CYCLE_START,
        renewsAt: RENEWS_AT,
        anchorDay: 1,
      }),
    );
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'chat'),
    );

    const sub = await inTenant(businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(sub?.plan).toBe('complete'); // still has what they paid for
    expect(sub?.pendingPlan).toBe('chat');
    expect(sub?.planExpiresAt?.toISOString()).toBe(RENEWS_AT.toISOString());
  });
});

describe('charges', () => {
  const charge = (businessId: string, reference: string, overrides = {}) =>
    inTenant(businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'renewal',
        plan: 'chat',
        amountK: 990_000,
        reference,
        periodStart: CYCLE_START,
        periodEnd: RENEWS_AT,
        ...overrides,
      }),
    );

  it('opens once for one reference, however many times it is asked', async () => {
    const businessId = await seedBusiness();
    expect(await charge(businessId, 'RK-SUB-1')).not.toBeNull();
    expect(await charge(businessId, 'RK-SUB-1')).toBeNull();

    const { rows } = await inTenant(businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a SECOND subscription charge for the same cycle', async () => {
    const businessId = await seedBusiness();
    expect(await charge(businessId, 'RK-SUB-1')).not.toBeNull();

    // A sweep that runs twice, or two workers that both claim this business.
    // Different reference, same cycle: the index is what stops the merchant
    // being billed twice for one month.
    expect(await charge(businessId, 'RK-SUB-2')).toBeNull();

    const { rows } = await inTenant(businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(rows).toHaveLength(1);
  });

  it('allows more than one UPGRADE inside a cycle', async () => {
    const businessId = await seedBusiness();
    // Chat to Integrate on day 3, Integrate to Complete on day 9. Both real.
    expect(
      await charge(businessId, 'RK-UP-1', { kind: 'upgrade', plan: 'integrate' }),
    ).not.toBeNull();
    expect(
      await charge(businessId, 'RK-UP-2', { kind: 'upgrade', plan: 'complete' }),
    ).not.toBeNull();
  });

  it('settles once, however many times the provider delivers the webhook', async () => {
    const businessId = await seedBusiness();
    await charge(businessId, 'RK-SUB-1');

    const settle = () =>
      inTenant(businessId, (tx) =>
        subscriptionsRepo.settleCharge(tx, {
          reference: 'RK-SUB-1',
          status: 'paid',
          providerReference: 'ps_123',
          when: new Date('2026-09-01T00:05:00Z'),
        }),
      );

    const first = await settle();
    expect(first?.status).toBe('paid');
    expect(first?.amountK).toBe(990_000);
    // The replays. Null is what lets the caller apply the cycle exactly once.
    expect(await settle()).toBeNull();
    expect(await settle()).toBeNull();
  });

  it('records a failure with its reason, and will not then settle as paid', async () => {
    const businessId = await seedBusiness();
    await charge(businessId, 'RK-SUB-1');
    const failed = await inTenant(businessId, (tx) =>
      subscriptionsRepo.settleCharge(tx, {
        reference: 'RK-SUB-1',
        status: 'failed',
        failureReason: 'insufficient funds',
        when: new Date('2026-09-01T00:05:00Z'),
      }),
    );
    expect(failed?.status).toBe('failed');

    const late = await inTenant(businessId, (tx) =>
      subscriptionsRepo.settleCharge(tx, {
        reference: 'RK-SUB-1',
        status: 'paid',
        when: new Date('2026-09-01T00:06:00Z'),
      }),
    );
    // A retry is a NEW charge. Flipping a settled one would lose the failure.
    expect(late).toBeNull();
  });

  it('accumulates partial refunds and only then reads as refunded', async () => {
    const businessId = await seedBusiness();
    await charge(businessId, 'RK-SUB-1');
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.settleCharge(tx, {
        reference: 'RK-SUB-1',
        status: 'paid',
        when: new Date('2026-09-01T00:05:00Z'),
      }),
    );

    const half = await inTenant(businessId, (tx) =>
      subscriptionsRepo.refundCharge(tx, 'RK-SUB-1', 490_000, new Date('2026-09-10T00:00:00Z')),
    );
    // Half back is still a charge that happened, not a charge that did not.
    expect(half?.status).toBe('paid');

    const rest = await inTenant(businessId, (tx) =>
      subscriptionsRepo.refundCharge(tx, 'RK-SUB-1', 500_000, new Date('2026-09-11T00:00:00Z')),
    );
    expect(rest?.status).toBe('refunded');

    // And never more than was charged.
    const over = await inTenant(businessId, (tx) =>
      subscriptionsRepo.refundCharge(tx, 'RK-SUB-1', 1, new Date('2026-09-12T00:00:00Z')),
    );
    expect(over).toBeNull();
  });

  it('will not let the application delete a charge', async () => {
    const businessId = await seedBusiness();
    await charge(businessId, 'RK-SUB-1');
    // A charge that turned out to be wrong is refunded. Removing the fact
    // that it happened is not one of the outcomes ADR 0024 offers.
    await expectRejectionBecause(
      inTenant(businessId, (tx) =>
        tx.execute(sql`DELETE FROM subscription_charges WHERE reference = 'RK-SUB-1'`),
      ),
      /permission denied/i,
    );
  });

  it('shows one merchant nothing of another merchant', async () => {
    const ada = await seedBusiness('Ada Fashion');
    const bola = await seedBusiness('Bola Stores');
    await charge(ada, 'RK-ADA-1');

    /* Zero rows AND a count of zero: another merchant's billing history is
     * invisible, not merely off this page of it. */
    const seen = await inTenant(bola, (tx) => subscriptionsRepo.chargesFor(tx, ada));
    expect(seen).toEqual({ rows: [], count: 0 });
  });
});

describe('the sweeps', () => {
  async function paidBusiness(name: string, renewsAt: Date): Promise<string> {
    const businessId = await seedBusiness(name);
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, {
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
    await inTenant(businessId, (tx) =>
      tx.execute(sql`UPDATE businesses SET plan = 'complete' WHERE id = ${businessId}::uuid`),
    );

    const [row] = await subscriptionsRepo.dueForRenewal(workerDb, NOW);
    expect(row?.plan).toBe('complete');
    expect(row?.nextPlan).toBe('chat');
  });

  it('stops sweeping a business once its renewal has failed', async () => {
    const businessId = await paidBusiness('Failed', new Date('2026-09-01T00:00:00Z'));
    await inTenant(businessId, (tx) => subscriptionsRepo.markRenewalFailed(tx, businessId, NOW));

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
      subscriptionsRepo.applyCycle(tx, businessId, {
        plan: 'complete',
        cycleStartedAt: CYCLE_START,
        renewsAt: RENEWS_AT,
        anchorDay: 1,
      }),
    );

    const previous = await inTenant(businessId, (tx) =>
      subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep'),
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

  it('does nothing to a trial, which ends rather than lapses', async () => {
    const businessId = await seedBusiness();
    expect(
      await inTenant(businessId, (tx) =>
        subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep'),
      ),
    ).toBeNull();
  });

  it('does nothing twice, so a second sweep pass writes no second row', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: CYCLE_START,
        renewsAt: RENEWS_AT,
        anchorDay: 1,
      }),
    );
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep'),
    );
    expect(
      await inTenant(businessId, (tx) =>
        subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep'),
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
      subscriptionsRepo.applyCycle(tx, businessId, {
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

describe('an add-on pack', () => {
  const PERIOD = '2026-08';

  it('raises the ceiling for the month it was bought in, and accumulates', async () => {
    const businessId = await seedBusiness();
    const consume = (allowance: number) =>
      inTenant(businessId, (tx) =>
        usageRepo.consumeUnit(tx, businessId, PERIOD, 'AI_ACTIONS', allowance),
      );

    expect(await consume(1)).toBe(true);
    expect(await consume(1)).toBe(false);

    await inTenant(businessId, (tx) =>
      usageRepo.creditBonus(tx, businessId, PERIOD, 'AI_ACTIONS', 2),
    );
    expect(await consume(1)).toBe(true);
    expect(await consume(1)).toBe(true);
    expect(await consume(1)).toBe(false);

    // A second pack adds to the first rather than replacing it.
    await inTenant(businessId, (tx) =>
      usageRepo.creditBonus(tx, businessId, PERIOD, 'AI_ACTIONS', 2),
    );
    const [row] = await inTenant(businessId, (tx) => usageRepo.usageFor(tx, businessId, PERIOD));
    expect(row?.bonus).toBe(4);
    expect(row?.used).toBe(3); // and never nets against what was consumed
  });

  it('does not roll over into the next month', async () => {
    const businessId = await seedBusiness();
    await inTenant(businessId, (tx) =>
      usageRepo.creditBonus(tx, businessId, PERIOD, 'AI_ACTIONS', 5),
    );

    // September is a fresh meter with a fresh ceiling: the pack was bought for
    // August and August is where it stays (ADR 0024).
    const september = await inTenant(businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, '2026-09', 'AI_ACTIONS', 0),
    );
    expect(september).toBe(false);
  });
});

describe('recording a refund', () => {
  async function paidCharge(businessId: string, reference: string): Promise<void> {
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'first_purchase',
        plan: 'chat',
        amountK: 990_000,
        reference,
        periodStart: CYCLE_START,
        periodEnd: RENEWS_AT,
      }),
    );
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.settleCharge(tx, { reference, status: 'paid', when: CYCLE_START }),
    );
  }

  it('writes WHO decided and under which of the published rows', async () => {
    const businessId = await seedBusiness();
    await paidCharge(businessId, 'RKD-SUB-20260821-EEEEEE');

    await inTenant(businessId, (tx) =>
      subscriptionsRepo.refundCharge(tx, 'RKD-SUB-20260821-EEEEEE', 990_000, new Date(), {
        actor: 'operator:angelo',
        reason: 'unused_add_on',
      }),
    );

    const audit = await inTenant(businessId, (tx) =>
      tx.execute<{ actor: string; new_value: { reason: string; amountK: number } }>(sql`
        SELECT actor, new_value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND action = 'refunded'
      `),
    );
    const row = [...audit][0];
    /* A refund policy that is a published table and an audit trail that is a
     * sentence somebody typed cannot be reconciled with each other later. */
    expect(row?.actor).toBe('operator:angelo');
    expect(row?.new_value.reason).toBe('unused_add_on');
    expect(row?.new_value.amountK).toBe(990_000);
  });

  it('writes no audit row when the refund was refused', async () => {
    const businessId = await seedBusiness();
    await paidCharge(businessId, 'RKD-SUB-20260821-FFFFFF');

    // More than was ever charged.
    expect(
      await inTenant(businessId, (tx) =>
        subscriptionsRepo.refundCharge(tx, 'RKD-SUB-20260821-FFFFFF', 990_001, new Date(), {
          actor: 'operator:angelo',
          reason: 'duplicate_charge',
        }),
      ),
    ).toBeNull();

    const audit = await inTenant(businessId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM audit_events
        WHERE business_id = ${businessId}::uuid AND action = 'refunded'
      `),
    );
    expect(Number([...audit][0]?.n)).toBe(0);
  });
});
