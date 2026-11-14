/**
 * The retention sweep's storage and its one privileged function (ADR 0024).
 *
 * Deleting a tenant is the most dangerous thing this system can do, so what
 * these tests pin is mostly what it REFUSES:
 *
 *   - a business that ever paid us, however long its trial has been over;
 *   - a business nobody warned;
 *   - a business whose trial has not been over long enough;
 *   - the same business twice.
 *
 * And when it does go ahead, that it goes ahead COMPLETELY. The last test
 * seeds a fully traded month, deletes it, then scans every table in the
 * database carrying a business_id for anything left behind. A hand-written
 * list of tables goes stale the first time somebody adds one; a scan does
 * not.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { paymentReference } from '@rekoda/core';
import { createDb, withBusiness, type Db, type TenantDb } from '../client.js';
import {
  identity,
  issueRepo,
  paymentsHub,
  retentionRepo,
  settleRepo,
  spendRepo,
  subscriptionsRepo,
  usageRepo,
} from '../index.js';
import { applyFixtureCycle, migrate, requireUrls, truncateAll, type Urls } from '../testing.js';
import { setPlanAsOwner, setPlanForTest, settlementDb } from '../testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let ownerDb: Db;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let phoneSeq = 0;

const inTenant = <T>(businessId: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> =>
  withBusiness(appDb, businessId, fn);
/** Payments and pack units are recorded only as `rekoda_settlement` (OD-37). */
const inSettlement = <T>(businessId: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> =>
  withBusiness(settlementDb(), businessId, fn);

/** A business whose trial ended `daysAgo`, with nobody warned yet. */
async function abandonedTrial(daysAgo: number): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481600000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await setPlanAsOwner(urls, business.id, {
    planExpiresAt: new Date(Date.now() - daysAgo * 86_400_000),
  });
  return business.id;
}

/**
 * Claim the warning. A notice sent now goes through the application credential, as the sweep's
 * does; one in the past is history staged as the owner, because no runtime role may backdate a
 * notice (0210: that would shorten the notice period).
 */
const warn = (businessId: string, when = new Date()) =>
  withBusiness(when.getTime() >= Date.now() - 30_000 ? appDb : ownerDb, businessId, (tx) =>
    retentionRepo.claimRetentionNotice(tx, businessId, when),
  );

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe('who is due', () => {
  it('finds a trial that ended long enough ago and nobody has warned', async () => {
    const old = await abandonedTrial(70);
    await abandonedTrial(10); // ended last week: far too soon

    const due = await retentionRepo.dueForNotice(workerDb, daysAgo(60));
    expect(due.map((row) => row.businessId)).toEqual([old]);
    expect(due[0]?.ownerPhone).toMatch(/^\+234/);
  });

  it('NEVER touches a business that has ever paid us', async () => {
    const businessId = await abandonedTrial(400);
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'first_purchase',
        plan: 'chat',
        amountK: 990_000,
        reference: 'RKD-SUB-20260101-AAAAAA',
        periodStart: daysAgo(400),
        periodEnd: daysAgo(370),
      }),
    );
    await inSettlement(businessId, (tx) =>
      subscriptionsRepo.settleCharge(tx, {
        reference: 'RKD-SUB-20260101-AAAAAA',
        status: 'paid',
        when: daysAgo(400),
      }),
    );

    // Their books belong to the financial retention period instead, and no
    // abandoned-trial rule may reach them.
    expect(await retentionRepo.dueForNotice(workerDb, daysAgo(60))).toEqual([]);
    await warn(businessId);
    expect(await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30))).toEqual([]);
    expect(await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90))).toBe(-1);
  });

  /* G-103. A plan set by hand (the operator path the billing page sends
   * merchants to) leaves no charge row. Once it lapses, the business must
   * still never be read as an abandoned trial: deleting it deletes the books
   * of a merchant who paid. */
  it('NEVER touches a business moved onto a paid plan by hand, once it lapses', async () => {
    const businessId = await abandonedTrial(400);
    expect(
      await setPlanForTest(appDb, {
        businessId,
        plan: 'complete',
        expiresAt: new Date(Date.now() + 30 * 86_400_000), // a paid plan's date is in the future (G-114)
        actor: 'operator:test',
      }),
    ).toBe(true);
    // The paid plan then lapsed long ago (renewal unpaid, grace run out): time moved on.
    await setPlanAsOwner(urls, businessId, { plan: 'expired', planExpiresAt: daysAgo(380) });

    expect(await retentionRepo.dueForNotice(workerDb, daysAgo(60))).toEqual([]);
    await warn(businessId, daysAgo(200));
    expect(await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30))).toEqual([]);
    expect(await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90))).toBe(-1);
  });

  /* G-103 post-merge review. A merchant who answers the warning by opening
   * checkout has not paid YET, so no charge is `paid` and `ever_paid_at` is
   * unset. The sweep must not delete them in the minutes before the money
   * lands, or while the billing job for it is still retrying. A checkout
   * opened and left for weeks protects nobody: the exemption is bounded. */
  describe('a checkout in flight', () => {
    const pendingCharge = async (businessId: string, reference: string, ageDays: number) => {
      await inTenant(businessId, async (tx) => {
        await subscriptionsRepo.openCharge(tx, {
          businessId,
          kind: 'first_purchase',
          plan: 'chat',
          amountK: 990_000,
          reference,
          periodStart: daysAgo(ageDays),
          periodEnd: daysAgo(ageDays - 30),
        });
      });
      /* Backdated as the table owner: a charge's opening time is frozen for every runtime role. */
      await ownerDb.execute(sql`
        UPDATE subscription_charges
        SET created_at = ${daysAgo(ageDays).toISOString()}::timestamptz
        WHERE reference = ${reference}
      `);
    };

    it('is neither warned nor deleted while a recent charge is still pending', async () => {
      const unwarned = await abandonedTrial(400);
      await pendingCharge(unwarned, 'RKD-SUB-20260101-PEND01', 1);
      expect(await retentionRepo.dueForNotice(workerDb, daysAgo(60))).toEqual([]);

      const warned = await abandonedTrial(400);
      await warn(warned, daysAgo(200));
      await pendingCharge(warned, 'RKD-SUB-20260101-PEND02', 1);
      expect(await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30))).toEqual([]);
      expect(await retentionRepo.deleteForRetention(workerDb, warned, daysAgo(90))).toBe(-1);
    });

    /* The window is written twice, in the candidate queries and inside the
     * SECURITY DEFINER function. Pinning both sides of it makes a drift show
     * up here rather than as a sweep that picks a business the function then
     * refuses on every run (or the reverse). The charges sit half a day
     * either side of the boundary, so a drift of a day or more in either
     * copy fails here. */
    it('holds the 14-day window in the queries and in the function alike', async () => {
      const inside = await abandonedTrial(400);
      await warn(inside, daysAgo(200));
      await pendingCharge(inside, 'RKD-SUB-20260101-EDGE13', 13.5);
      const outside = await abandonedTrial(400);
      await warn(outside, daysAgo(200));
      await pendingCharge(outside, 'RKD-SUB-20260101-EDGE15', 14.5);

      const due = await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30));
      expect(due.map((row) => row.businessId)).toEqual([outside]);
      expect(await retentionRepo.deleteForRetention(workerDb, inside, daysAgo(90))).toBe(-1);
      expect(
        await retentionRepo.deleteForRetention(workerDb, outside, daysAgo(90)),
      ).toBeGreaterThan(0);
    });

    it('does not protect a business whose checkout was abandoned long ago', async () => {
      const businessId = await abandonedTrial(400);
      await warn(businessId, daysAgo(200));
      await pendingCharge(businessId, 'RKD-SUB-20260101-PEND03', 30);
      const due = await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30));
      expect(due.map((row) => row.businessId)).toEqual([businessId]);
      expect(
        await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90)),
      ).toBeGreaterThan(0);
    });
  });

  /* G-103 post-merge review. "Never cleared" is the rule, and it has to hold
   * on the paths an operator can actually take: back to trial, to expired,
   * and onto a paid plan again. A reset such as
   * `everPaidAt: paid ? now() : null` would pass every other test here. */
  it('NEVER forgets a paid plan when the operator moves the business back to trial or expired', async () => {
    const businessId = await abandonedTrial(400);
    const everPaidAt = () =>
      inTenant(businessId, async (tx) => {
        const rows = await tx.execute<{ ever_paid_at: string | null }>(
          sql`SELECT ever_paid_at FROM businesses WHERE id = ${businessId}::uuid`,
        );
        return [...rows][0]?.ever_paid_at ?? null;
      });
    const change = (plan: string, expiresAt: Date) =>
      setPlanForTest(appDb, { businessId, plan, expiresAt, actor: 'operator:test' });

    await change('complete', new Date(Date.now() + 30 * 86_400_000)); // future: G-114
    const first = await everPaidAt();
    expect(first).not.toBeNull();

    await change('trial', daysAgo(380));
    expect(await everPaidAt()).toEqual(first);
    await change('chat', new Date(Date.now() + 30 * 86_400_000));
    expect(await everPaidAt()).toEqual(first); // the first date stands
    await change('expired', daysAgo(380));
    expect(await everPaidAt()).toEqual(first);

    expect(await retentionRepo.dueForNotice(workerDb, daysAgo(60))).toEqual([]);
    await warn(businessId, daysAgo(200));
    expect(await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30))).toEqual([]);
    expect(await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90))).toBe(-1);
  });

  /* G-103 post-merge review. The function decides "due" from a plain read.
   * A payment that is applied but not yet committed when it looks used to be
   * invisible to it, so a merchant who paid inside that window could be
   * deleted. The function must wait for the row and judge the committed
   * state. */
  it('refuses a business that pays while the deletion is deciding', async () => {
    const businessId = await abandonedTrial(400);
    await warn(businessId, daysAgo(200));
    expect(await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30))).toHaveLength(1);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let applied!: () => void;
    const appliedPayment = new Promise<void>((resolve) => (applied = resolve));

    // The payment path: plan and ever_paid_at change in one transaction that
    // has not committed yet.
    const payment = inTenant(businessId, async (tx) => {
      /* The real writer (OD-37): plan, expiry and ever_paid_at in one transaction. */
      const renewsAt = new Date(Date.now() + 30 * 86_400_000);
      await applyFixtureCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: new Date(),
        renewsAt,
        anchorDay: renewsAt.getUTCDate(),
      });
      applied();
      await held;
    });
    await appliedPayment;

    const deletion = retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90));
    try {
      // Wait until the deletion is actually parked behind the payment.
      for (let waited = 0; ; waited += 25) {
        const rows = await ownerDb.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database()
        `);
        if (([...rows][0]?.n ?? 0) >= 1) break;
        if (waited > 8_000) throw new Error('the deletion never waited on the payment');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      release();
      await payment;
    }

    expect(await deletion).toBe(-1);
    const rows = await inTenant(businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM businesses WHERE id = ${businessId}::uuid`,
      ),
    );
    expect([...rows][0]?.n).toBe(1);
  });

  it('warns once, so the notice period runs from the FIRST warning', async () => {
    const businessId = await abandonedTrial(120);
    const first = daysAgo(5);
    expect(await warn(businessId, first)).toBe(true);
    expect(await warn(businessId, new Date())).toBe(false);

    const [row] = await retentionRepo.dueForDeletion(workerDb, daysAgo(90), new Date());
    expect(row?.notifiedAt?.toISOString().slice(0, 16)).toBe(first.toISOString().slice(0, 16));
  });

  it('leaves a warned business alone until the notice period has run', async () => {
    const businessId = await abandonedTrial(95);
    await warn(businessId, daysAgo(3));
    // Warned three days ago, and the schedule promises thirty.
    expect(await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30))).toEqual([]);
  });
});
