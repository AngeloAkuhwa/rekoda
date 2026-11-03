/**
 * The billing surface, end to end: session guard → core arithmetic → contract
 * shape → the grace sweep that runs beside it (ADR 0024).
 *
 * The arithmetic itself is proven in packages/core/src/billing.test.ts and
 * the storage in packages/db/src/billing/subscriptions.integration.test.ts. What this
 * suite pins is everything between them, and three claims in particular:
 *
 *   - §47 refuses a paid change BEFORE opening a charge, so lifting the gate
 *     leaves nothing to reconcile;
 *   - a downgrade costs nothing and waits, while an upgrade costs the
 *     prorated difference and does not move the plan until a provider says so;
 *   - the grace sweep sends one reminder per day and expires on day seven,
 *     and expiring is an ACT with an audit row rather than a date comparison.
 */
// The billing API suite (ADR 0024). Split by concern; the rest of this suite is in
// billing.integration.test.ts, billing-paying.integration.test.ts, billing-
// renewal.integration.test.ts, billing-grandfathering.integration.test.ts.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRACE_DAYS, usagePeriod } from '@rekoda/core';
import { billingOverviewResponse } from '@rekoda/contracts';
import {
  createDb,
  identity,
  marginRepo,
  quotaRepo,
  subscriptionsRepo,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sweepGracePeriods } from './grace-sweep.js';
import { StubSender } from '../channels/sender.stub.js';
import { SendFailed } from '../channels/sender.js';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_REVEAL_OTP'] = '1';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  delete process.env['REKODA_PAYSTACK_PLATFORM_CONFIRMED'];
});

function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode?: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = await post(
    '/v1/businesses',
    { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  const session = created.json() as { sessionToken: string; businessId: string };
  return {
    businessId: session.businessId,
    auth: { authorization: `Bearer ${session.sessionToken}` },
  };
}

/** Put a business on a paid cycle, as a settled first purchase would. */
async function putOnPlan(businessId: string, plan: string, cycleStart: Date, renewsAt: Date) {
  await withBusiness(db, businessId, (tx) =>
    subscriptionsRepo.applyCycle(tx, businessId, {
      plan,
      cycleStartedAt: cycleStart,
      renewsAt,
      anchorDay: renewsAt.getUTCDate(),
    }),
  );
}

const overviewOf = async (auth: Record<string, string>) =>
  billingOverviewResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/billing', headers: auth })).json(),
  );

describe('the grace period', () => {
  /**
   * An hour ago, not a fixed date. The sweep is told what time it is; the
   * overview endpoint reads the real clock, so a failure pinned to a calendar
   * date would drift into "already expired" the week after it was written.
   */
  const FAILED_AT = new Date(Date.now() - 3_600_000);

  async function failedMerchant(phone: string) {
    const { businessId, auth } = await onboard(phone);
    await putOnPlan(businessId, 'chat', new Date(FAILED_AT.getTime() - 30 * 86_400_000), FAILED_AT);
    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.markRenewalFailed(tx, businessId, FAILED_AT),
    );
    return { businessId, auth };
  }

  const dayAfterFailure = (days: number) => new Date(FAILED_AT.getTime() + days * 86_400_000);

  /**
   * The sweep sent a chargeable Meta template and recorded nothing, so the
   * margin view saw a merchant who cost nothing in the month Rekoda paid to
   * warn them seven times. Spec §24 separates the categories precisely so
   * this class of cost is visible.
   */
  it('records the billing reminder as the utility template Rekoda paid for', async () => {
    const { businessId } = await failedMerchant('+2348177100030');
    const sender = new StubSender();
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(sender.billingNotices).toHaveLength(1);

    const rows = await marginRepo.costByUsageType(workerDb, usagePeriod(new Date()));
    const utility = rows.find(
      (row) => row.provider === 'meta' && row.usageType === 'UTILITY_TEMPLATE',
    );
    expect(utility?.events).toBe(1);
    /* ₦9.72 at planning FX, from the external cost stack in pricing-model.md. */
    expect(utility?.costK).toBe(972);

    const own = await withBusiness(db, businessId, (tx) => quotaRepo.usageTotals(tx, 'meta'));
    expect(own.calls).toBeGreaterThanOrEqual(1);
  });

  /* A reminder that never left costs nothing, so nothing is recorded. */
  it('records no cost when the template is missing and the notice never sends', async () => {
    await failedMerchant('+2348177100031');
    const sender = new StubSender();
    sender.failWith();
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    await sweepGracePeriods(deps, dayAfterFailure(1));

    const rows = await marginRepo.costByUsageType(workerDb, usagePeriod(new Date()));
    expect(rows.find((row) => row.usageType === 'UTILITY_TEMPLATE')).toBeUndefined();
  });

  /* SUB-03r (OWN-47). A timeout or dropped connection after the request left may
   * have delivered the notice. The claim must stay, or the next hourly pass sends it again. */
  it('does not resend a reminder whose outcome is unknown', async () => {
    await failedMerchant('+2348177100040');
    const sender = new StubSender();
    sender.failWith(new SendFailed('timeout'));
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    await sweepGracePeriods(deps, dayAfterFailure(1));
    await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(sender.billingNotices).toHaveLength(0);

    // The stub's one-shot failure is spent: had the claim been released, this pass would send.
    await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(sender.billingNotices).toHaveLength(0);
  });

  /* The sweep reads a page, then sends row by row. A merchant who pays while an earlier row
   * is being sent must not then get a "payment failed" notice from the stale page. */
  it('suppresses a reminder when the cycle is paid after the page was read', async () => {
    const a = await failedMerchant('+2348177100042');
    const b = await failedMerchant('+2348177100043');
    const byPhone = new Map([
      ['+2348177100042', b.businessId],
      ['+2348177100043', a.businessId],
    ]);
    const sender = new StubSender();
    const original = sender.sendBillingNotice.bind(sender);
    let paidOther = false;
    sender.sendBillingNotice = async (notice) => {
      const sent = await original(notice);
      if (!paidOther) {
        paidOther = true;
        const other = byPhone.get(notice.to)!;
        await putOnPlan(
          other,
          'chat',
          dayAfterFailure(1),
          new Date(dayAfterFailure(1).getTime() + 30 * 86_400_000),
        );
      }
      return sent;
    };
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(sender.billingNotices).toHaveLength(1);
  });

  /* CodeRabbit on #400: the eligibility read runs after the claim. If it throws, nothing was
   * sent, so the claim must go back or that reminder day is lost. */
  it('rolls the claim back when the final eligibility read fails', async () => {
    await failedMerchant('+2348177100044');
    const sender = new StubSender();
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };
    const real = subscriptionsRepo.graceReminderEligibility;
    const spy = vi
      .spyOn(subscriptionsRepo, 'graceReminderEligibility')
      .mockRejectedValueOnce(new Error('read failed'));
    try {
      await sweepGracePeriods(deps, dayAfterFailure(1));
      expect(sender.billingNotices).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
    expect(subscriptionsRepo.graceReminderEligibility).toBe(real);

    await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(sender.billingNotices).toHaveLength(1);
  });

  /* CodeRabbit on #400: the opt-out flag on the page can be stale. A merchant who sent START
   * after the page was read must still get this reminder day, not have it burnt on the old flag. */
  it('reads STOP/START fresh, not from the page', async () => {
    const m1 = await failedMerchant('+2348177100045');
    const m2 = await failedMerchant('+2348177100046');
    /* Pages run in business-id order: the first is sent to, the second is the opted-out one. */
    const [first, second] =
      m1.businessId < m2.businessId
        ? [
            { ...m1, phone: '+2348177100045' },
            { ...m2, phone: '+2348177100046' },
          ]
        : [
            { ...m2, phone: '+2348177100046' },
            { ...m1, phone: '+2348177100045' },
          ];
    await identity.setOptOut(db, second.phone, new Date());

    const sender = new StubSender();
    const original = sender.sendBillingNotice.bind(sender);
    sender.sendBillingNotice = async (notice) => {
      const sent = await original(notice);
      if (notice.to === first.phone) await identity.setOptOut(db, second.phone, null);
      return sent;
    };
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(sender.billingNotices.map((n) => n.to).sort()).toEqual(
      [first.phone, second.phone].sort(),
    );
  });

  /* CodeRabbit on #400: a failed claim release after a definite non-delivery must not abort the
   * pass for the merchants after it. */
  it('keeps sweeping when a failed claim release follows a definite non-delivery', async () => {
    await failedMerchant('+2348177100047');
    await failedMerchant('+2348177100048');
    const sender = new StubSender();
    sender.failWith(new SendFailed('rejected', 429, true, true));
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };
    const spy = vi
      .spyOn(subscriptionsRepo, 'releaseGraceReminder')
      .mockRejectedValueOnce(new Error('release failed'));
    try {
      await expect(sweepGracePeriods(deps, dayAfterFailure(1))).resolves.toBeDefined();
    } finally {
      spy.mockRestore();
    }
    /* The other merchant was still processed in the same pass. */
    expect(sender.billingNotices).toHaveLength(1);
  });

  it('retries a reminder that definitely did not leave', async () => {
    await failedMerchant('+2348177100041');
    const sender = new StubSender();
    sender.failWith(new SendFailed('rejected', 429, true, true));
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(sender.billingNotices).toHaveLength(0);
    await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(sender.billingNotices).toHaveLength(1);
  });

  it('sends one reminder on day 1 and none the same day twice', async () => {
    const { auth } = await failedMerchant('+2348177100010');
    const sender = new StubSender();
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    const first = await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(first).toEqual({ reminded: 1, expired: 0 });
    expect(sender.billingNotices).toHaveLength(1);
    expect(sender.billingNotices[0]?.daysLeft).toBe('6');

    // A second pass in the same day, or a second worker, sends nothing.
    const second = await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(second).toEqual({ reminded: 0, expired: 0 });
    expect(sender.billingNotices).toHaveLength(1);

    // Paid features still work: the merchant is in grace, not expired.
    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('chat');
    expect(overview.status.state).toBe('grace');
  });

  it('says nothing between reminders once each has been sent', async () => {
    await failedMerchant('+2348177100011');
    const sender = new StubSender();
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    expect((await sweepGracePeriods(deps, dayAfterFailure(0))).reminded).toBe(0);
    expect((await sweepGracePeriods(deps, dayAfterFailure(1))).reminded).toBe(1);
    for (const day of [2, 3, 4]) {
      expect((await sweepGracePeriods(deps, dayAfterFailure(day))).reminded).toBe(0);
    }
    expect((await sweepGracePeriods(deps, dayAfterFailure(5))).reminded).toBe(1);
    expect((await sweepGracePeriods(deps, dayAfterFailure(6))).reminded).toBe(0);
    expect(sender.billingNotices).toHaveLength(2);
  });

  it('sends a missed day-one warning late instead of staying silent until day five', async () => {
    await failedMerchant('+2348177100015');
    const sender = new StubSender();
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    /* The sweep was down through all of day one. Its first pass lands on day
     * two: the merchant still gets the first warning, once, with the days
     * that are actually left, and day five arrives on its own schedule. */
    const late = await sweepGracePeriods(deps, dayAfterFailure(2));
    expect(late).toEqual({ reminded: 1, expired: 0 });
    expect(sender.billingNotices[0]?.daysLeft).toBe('5');

    expect((await sweepGracePeriods(deps, dayAfterFailure(2))).reminded).toBe(0);
    expect((await sweepGracePeriods(deps, dayAfterFailure(5))).reminded).toBe(1);
    expect(sender.billingNotices).toHaveLength(2);
  });

  it('honours STOP: the day is claimed, the message is not sent', async () => {
    await failedMerchant('+2348177100012');
    await identity.setOptOut(db, '+2348177100012', new Date());

    const sender = new StubSender();
    const swept = await sweepGracePeriods(
      { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 },
      dayAfterFailure(1),
    );
    expect(swept.reminded).toBe(1);
    expect(sender.billingNotices).toEqual([]);
  });

  it('expires on day SEVEN, not day six', async () => {
    const { auth } = await failedMerchant('+2348177100013');
    const sender = new StubSender();
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    expect((await sweepGracePeriods(deps, dayAfterFailure(GRACE_DAYS - 1))).expired).toBe(0);
    expect((await overviewOf(auth)).plan).toBe('chat');

    const swept = await sweepGracePeriods(deps, dayAfterFailure(GRACE_DAYS));
    expect(swept.expired).toBe(1);

    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('expired');
    expect(overview.status.state).toBe('expired');
    /* A paid plan that lapsed is not a trial that ended: the page words them differently. */
    expect(overview.status).toMatchObject({ wasTrial: false });

    // And it stops sweeping: an expired merchant is not reminded forever.
    expect(await sweepGracePeriods(deps, dayAfterFailure(GRACE_DAYS + 1))).toEqual({
      reminded: 0,
      expired: 0,
    });
  });

  it('leaves the books readable after expiry', async () => {
    const { auth } = await failedMerchant('+2348177100014');
    await sweepGracePeriods(
      { workerDb, appDb: db, sender: new StubSender(), fxNairaPerUsd: 1_450 },
      dayAfterFailure(GRACE_DAYS),
    );

    // ADR 0024: read-only, not closed. Reporting never checks the plan.
    const statements = await app.inject({
      method: 'GET',
      url: '/v1/reports/statements',
      headers: auth,
    });
    expect(statements.statusCode).toBe(200);
  });

  it('stops reminding the moment a cycle is paid for', async () => {
    const { businessId } = await failedMerchant('+2348177100015');
    const sender = new StubSender();
    const deps = { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450 };

    await sweepGracePeriods(deps, dayAfterFailure(1));
    expect(sender.billingNotices).toHaveLength(1);

    await putOnPlan(
      businessId,
      'chat',
      dayAfterFailure(2),
      new Date(dayAfterFailure(2).getTime() + 30 * 86_400_000),
    );

    expect(await sweepGracePeriods(deps, dayAfterFailure(5))).toEqual({ reminded: 0, expired: 0 });
    expect(sender.billingNotices).toHaveLength(1);
  });

  it('an allowance a merchant no longer has is refused after expiry', async () => {
    const { businessId } = await failedMerchant('+2348177100016');
    await sweepGracePeriods(
      { workerDb, appDb: db, sender: new StubSender(), fxNairaPerUsd: 1_450 },
      dayAfterFailure(GRACE_DAYS),
    );

    // `expired` grants zero of everything, and the gate reads that plan.
    const plan = await withBusiness(db, businessId, (tx) => usageRepo.planFor(tx, businessId));
    expect(plan).toBe('expired');
  });
});
