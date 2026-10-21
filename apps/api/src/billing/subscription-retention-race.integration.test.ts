/**
 * A merchant paying Rekoda while the retention sweep is deciding whether to
 * delete them (G-103).
 *
 * Both run the REAL production code: `applySettledCharge` is what the
 * billing job calls, and `deleteForRetention` is what the sweep calls. What
 * the test adds is a barrier, so the overlap is not left to timing. A
 * AFTER UPDATE trigger on `subscription_charges` waits on an advisory lock the
 * test holds, which parks the payment at the one place that matters: after
 * it has written the charge row and before `applyCycle` writes the business.
 * (A trigger on `businesses` would not do: a BEFORE ROW trigger locks the
 * row before it fires, which is not the window being tested.)
 *
 * The invariant is that however the two interleave, a business whose payment
 * succeeds is never deleted, neither transaction is lost to a deadlock, and
 * the plan, charge and `ever_paid_at` all land.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  identity,
  retentionRepo,
  sql,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { applySettledCharge } from './billing.service.js';

const BARRIER_KEY = 7_770_161;
const REFERENCE = 'RKD-SUB-20260101-RACE01';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

afterEach(async () => {
  await ownerDb.execute(sql`DROP TRIGGER IF EXISTS test_race_barrier ON subscription_charges`);
  await ownerDb.execute(sql`DROP FUNCTION IF EXISTS test_race_barrier()`);
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const config = { planCatalogueReads: false };

/** An abandoned trial, warned, with a pending first-purchase charge. */
async function warnedTrialWithPendingCharge(
  kind: 'first_purchase' | 'add_on' = 'first_purchase',
): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, '+2348170000001');
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const businessId = business.id;
  await withBusiness(appDb, businessId, async (tx) => {
    await tx.execute(sql`
      UPDATE businesses SET plan_expires_at = ${daysAgo(400).toISOString()}::timestamptz
      WHERE id = ${businessId}::uuid
    `);
    await retentionRepo.claimRetentionNotice(tx, businessId, daysAgo(200));
    await subscriptionsRepo.openCharge(tx, {
      businessId,
      kind,
      ...(kind === 'first_purchase' ? { plan: 'chat' as const } : {}),
      amountK: 990_000,
      reference: REFERENCE,
      periodStart: daysAgo(1),
      periodEnd: new Date(Date.now() + 29 * 86_400_000),
    });
    // A checkout opened in the last 14 days defers deletion (migration 0161),
    // which would end the race before it began. This one was abandoned weeks
    // ago, so the business is genuinely due.
    await tx.execute(sql`
      UPDATE subscription_charges SET created_at = ${daysAgo(30).toISOString()}::timestamptz
      WHERE reference = ${REFERENCE}
    `);
  });
  return businessId;
}

/** Backends currently waiting on a lock. */
async function lockWaiters(): Promise<number> {
  const rows = await ownerDb.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND datname = current_database()
  `);
  return [...rows][0]?.n ?? 0;
}

async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('a subscription payment racing the retention sweep', () => {
  it('settles the payment and refuses the deletion, with no deadlock', async () => {
    const businessId = await warnedTrialWithPendingCharge();
    expect(await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30))).toHaveLength(1);

    // The barrier: whoever updates a charge row waits, afterwards, for this lock.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const holder = ownerDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BARRIER_KEY})`);
      holding();
      await gate;
    });
    // A failed wait must still open the barrier, or the parked payment and the
    // holder outlive the test and hide the real failure behind a hung teardown.
    try {
      await held;
      await ownerDb.execute(sql`
      CREATE FUNCTION test_race_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${sql.raw(String(BARRIER_KEY))}); RETURN NEW; END $$
    `);
      await ownerDb.execute(sql`
      CREATE TRIGGER test_race_barrier AFTER UPDATE ON subscription_charges
      FOR EACH STATEMENT EXECUTE FUNCTION test_race_barrier()
    `);

      // The payment, exactly as the billing job runs it.
      const payment = withBusiness(appDb, businessId, (tx) =>
        applySettledCharge(tx, {
          businessId,
          reference: REFERENCE,
          providerReference: 'ps_race',
          when: new Date(),
          config,
        }),
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await until(async () => (await lockWaiters()) >= 1, 'the payment to reach the barrier');

      // Retention starts while the payment is parked mid-settlement.
      let retentionSettled = false;
      const deletion = retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90)).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      void deletion.then(() => (retentionSettled = true));
      await until(
        async () => retentionSettled || (await lockWaiters()) >= 2,
        'retention to run into the payment',
      );

      release();
      await holder;
      const [paid, deleted] = await Promise.all([payment, deletion]);

      expect(paid).toEqual({ ok: true, value: 'applied' });
      expect(deleted).toEqual({ ok: true, value: -1 });

      const state = await withBusiness(appDb, businessId, async (tx) => {
        const rows = await tx.execute<{
          plan: string;
          ever_paid_at: string | null;
          charge_status: string | null;
        }>(sql`
          SELECT b.plan, b.ever_paid_at,
                 (SELECT c.status FROM subscription_charges c WHERE c.reference = ${REFERENCE}) AS charge_status
          FROM businesses b WHERE b.id = ${businessId}::uuid
        `);
        return [...rows][0];
      });
      expect(state?.plan).toBe('chat');
      expect(state?.ever_paid_at).not.toBeNull();
      expect(state?.charge_status).toBe('paid');
    } finally {
      release();
      await holder;
    }
  });

  it('answers a payment for a business retention already deleted without throwing', async () => {
    const businessId = await warnedTrialWithPendingCharge();
    expect(
      await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90)),
    ).toBeGreaterThan(0);

    const outcome = await withBusiness(appDb, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: REFERENCE,
        providerReference: 'ps_late',
        when: new Date(),
        config,
      }),
    );
    expect(outcome).toBe('business_gone');
  });

  it('refuses the deletion when a pack payment commits while retention waits on the lock', async () => {
    // A pack settles without applyCycle, so it sets neither plan nor ever_paid_at:
    // retention must see the committed PAID charge, not its pre-lock snapshot.
    const businessId = await warnedTrialWithPendingCharge('add_on');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let parked!: () => void;
    const settledUncommitted = new Promise<void>((resolve) => (parked = resolve));
    const payment = withBusiness(appDb, businessId, async (tx) => {
      const outcome = await applySettledCharge(tx, {
        businessId,
        reference: REFERENCE,
        providerReference: 'ps_pack',
        when: new Date(),
        config,
      });
      parked();
      await gate;
      return outcome;
    });
    try {
      await settledUncommitted;
      const deletion = retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90));
      await until(async () => (await lockWaiters()) >= 1, 'retention to wait on the payment');
      release();
      expect(await payment).toBe('applied');
      expect(await deletion).toBe(-1);
      const rows = await ownerDb.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM businesses WHERE id = ${businessId}::uuid`,
      );
      expect([...rows][0]?.n).toBe(1);
    } finally {
      release();
      await payment.catch(() => undefined);
    }
  });
});
