/**
 * The billing surface, end to end: session guard → core arithmetic → contract
 * shape → the grace sweep that runs beside it (ADR 0024).
 *
 * The arithmetic itself is proven in packages/core/src/billing.test.ts and
 * the storage in packages/db/src/subscriptions.integration.test.ts. What this
 * suite pins is everything between them, and three claims in particular:
 *
 *   - §47 refuses a paid change BEFORE opening a charge, so lifting the gate
 *     leaves nothing to reconcile;
 *   - a downgrade costs nothing and waits, while an upgrade costs the
 *     prorated difference and does not move the plan until a provider says so;
 *   - the grace sweep sends one reminder per day and expires on day seven,
 *     and expiring is an ACT with an audit row rather than a date comparison.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMonth, GRACE_DAYS, PLAN_PRICES_K } from '@rekoda/core';
import { billingOverviewResponse, billingQuoteResponse } from '@rekoda/contracts';
import {
  createDb,
  identity,
  subscriptionsRepo,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sweepGracePeriods } from './grace-sweep.js';
import { sweepRenewals } from './renewal-sweep.js';
import { applySettledCharge, BillingService } from './billing.service.js';
import { CONFIG, type ApiConfig } from '../config.js';
import { StubSender } from '../channels/sender.stub.js';

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

/** The same service the controller uses, with spec §47 confirmed. */
function confirmedBilling(): BillingService {
  const config = app.get<ApiConfig>(CONFIG);
  return new BillingService({ ...config, paystackPlatformConfirmed: true }, db);
}

const overviewOf = async (auth: Record<string, string>) =>
  billingOverviewResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/billing', headers: auth })).json(),
  );

describe('the guardrail', () => {
  it('refuses a caller with no session', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/billing' })).statusCode).toBe(401);
    expect((await post('/v1/billing/plan', { plan: 'chat' })).statusCode).toBe(401);
    expect((await post('/v1/billing/quote', { plan: 'chat' })).statusCode).toBe(401);
    expect((await post('/v1/billing/packs', { packId: 'messages_100' })).statusCode).toBe(401);
  });

  it('refuses a plan nobody sells', async () => {
    const { auth } = await onboard('+2348177100001');
    expect((await post('/v1/billing/quote', { plan: 'enterprise' }, auth)).statusCode).toBe(400);
    expect((await post('/v1/billing/plan', { plan: 'trial' }, auth)).statusCode).toBe(400);
  });
});

describe('what a new merchant sees', () => {
  it('reads as a trial, priced at nothing, with no packs to buy', async () => {
    const { auth } = await onboard('+2348177100002');
    const overview = await overviewOf(auth);

    expect(overview.plan).toBe('trial');
    expect(overview.priceK).toBe(0);
    expect(overview.status.state).toBe('trial');
    expect(overview.charges).toEqual([]);
    // A merchant on trial should convert rather than buy overage.
    expect(overview.packs).toEqual([]);
  });

  it('quotes a first purchase at the full price, starting a fresh cycle', async () => {
    const { auth } = await onboard('+2348177100003');
    const quote = billingQuoteResponse.parse(
      (await post('/v1/billing/quote', { plan: 'chat' }, auth)).json(),
    );
    expect(quote.kind).toBe('first_purchase');
    expect(quote.amountK).toBe(PLAN_PRICES_K.chat);
    expect(quote.effectiveFrom).toBe('now');
  });
});

describe('paying, and the gate in front of it', () => {
  it('refuses a paid change without opening a charge while §47 stands', async () => {
    const { businessId, auth } = await onboard('+2348177100004');
    const answer = (await post('/v1/billing/plan', { plan: 'chat' }, auth)).json() as {
      state: string;
      reason?: string;
    };
    expect(answer).toEqual({ state: 'unavailable', reason: 'awaiting_platform_confirmation' });

    // Nothing to clean up when the gate lifts.
    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges).toEqual({ rows: [], count: 0 });
  });

  it('records an upgrade as a pending charge and does NOT move the plan', async () => {
    const { businessId, auth } = await onboard('+2348177100005');
    const now = new Date();
    await putOnPlan(
      businessId,
      'chat',
      new Date(now.getTime() - 11 * 86_400_000),
      new Date(now.getTime() + 19 * 86_400_000),
    );

    /* Past the gate, which the app read at boot. Built here rather than by
     * restarting the suite with a different environment, so the confirmed
     * path is exercised at all rather than only its refusal. */
    const answer = await confirmedBilling().changePlan(businessId, 'complete', now);
    expect(answer.state).toBe('payment_required');
    if (answer.state !== 'payment_required') throw new Error('unreachable');
    // Chat to Complete with 19 of 30 days left: the prorated difference.
    expect(answer.amountK).toBe(
      Math.floor(((PLAN_PRICES_K.complete - PLAN_PRICES_K.chat) * 19) / 30),
    );

    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges.rows[0]?.status).toBe('pending');

    // Opening a charge is not paying it. Complete stays locked until it is.
    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('chat');
    expect(overview.charges[0]?.reference).toBe(answer.reference);
  });

  it('unlocks the new plan when the provider confirms, keeping the renewal date', async () => {
    const { businessId, auth } = await onboard('+2348177100017');
    const now = new Date();
    const renewsAt = new Date(now.getTime() + 19 * 86_400_000);
    await putOnPlan(businessId, 'chat', new Date(now.getTime() - 11 * 86_400_000), renewsAt);

    const answer = await confirmedBilling().changePlan(businessId, 'complete', now);
    if (answer.state !== 'payment_required') throw new Error('expected a charge');

    await withBusiness(db, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: answer.reference,
        providerReference: 'ps_upgrade',
        when: now,
      }),
    );

    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('complete');
    expect(overview.status).toEqual({ state: 'active', renewsAt: renewsAt.toISOString() });
  });

  it('hands a double-clicked upgrade ONE reference, not two payable charges', async () => {
    const { businessId } = await onboard('+2348177100028');
    const now = new Date();
    await putOnPlan(
      businessId,
      'chat',
      new Date(now.getTime() - 11 * 86_400_000),
      new Date(now.getTime() + 19 * 86_400_000),
    );

    const billing = confirmedBilling();
    const first = await billing.changePlan(businessId, 'complete', now);
    const second = await billing.changePlan(businessId, 'complete', now);
    if (first.state !== 'payment_required' || second.state !== 'payment_required') {
      throw new Error('expected two payment_required answers');
    }
    expect(second.reference).toBe(first.reference);

    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges.rows.filter((c) => c.status === 'pending')).toHaveLength(1);
  });

  it('hands a re-posted pack purchase the pending charge, not a second one', async () => {
    const { businessId } = await onboard('+2348177100029');
    await putOnPlan(businessId, 'complete', new Date(), new Date(Date.now() + 30 * 86_400_000));

    const billing = confirmedBilling();
    const first = await billing.buyPack(businessId, 'documents_50');
    const second = await billing.buyPack(businessId, 'documents_50');
    if (first.state !== 'payment_required' || second.state !== 'payment_required') {
      throw new Error('expected two payment_required answers');
    }
    expect(second.reference).toBe(first.reference);

    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges.rows).toHaveLength(1);
  });

  it('refuses a pack the plan cannot use, before taking any money', async () => {
    const { businessId } = await onboard('+2348177100018');
    await putOnPlan(businessId, 'chat', new Date(), new Date(Date.now() + 30 * 86_400_000));

    const billing = confirmedBilling();
    expect(await billing.buyPack(businessId, 'orders_50')).toEqual({
      state: 'unavailable',
      reason: 'not_available_on_plan',
    });
    expect(await billing.buyPack(businessId, 'nothing_like_this')).toEqual({
      state: 'unavailable',
      reason: 'unknown_pack',
    });

    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges).toEqual({ rows: [], count: 0 });
  });

  it('schedules a downgrade for the next renewal, free, keeping the plan meanwhile', async () => {
    const { businessId, auth } = await onboard('+2348177100006');
    const renewsAt = new Date(Date.now() + 19 * 86_400_000);
    await putOnPlan(businessId, 'complete', new Date(Date.now() - 11 * 86_400_000), renewsAt);

    const answer = (await post('/v1/billing/plan', { plan: 'chat' }, auth)).json() as {
      state: string;
      plan: string;
      effectiveAt: string;
    };
    expect(answer.state).toBe('scheduled');
    expect(answer.plan).toBe('chat');
    expect(new Date(answer.effectiveAt).toISOString()).toBe(renewsAt.toISOString());

    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('complete'); // still has what they paid for
    expect(overview.pendingPlan).toBe('chat');
  });

  it('offers a paid plan its own packs and not those of another plan', async () => {
    const { businessId, auth } = await onboard('+2348177100007');
    await putOnPlan(businessId, 'chat', new Date(), new Date(Date.now() + 30 * 86_400_000));

    const ids = (await overviewOf(auth)).packs.map((pack) => pack.id);
    expect(ids).toContain('messages_100');
    expect(ids).toContain('voice_30min');
    // Chat captures no catalogue orders, so order capacity would buy nothing.
    expect(ids).not.toContain('orders_50');
  });
});

describe('a charge the provider confirmed', () => {
  it('starts a cycle on a first purchase and settles exactly once', async () => {
    const { businessId, auth } = await onboard('+2348177100008');
    const now = new Date('2026-08-15T10:00:00Z');

    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'first_purchase',
        plan: 'chat',
        amountK: PLAN_PRICES_K.chat,
        reference: 'RKD-SUB-20260815-AAAAAA',
        periodStart: now,
        periodEnd: new Date('2026-09-15T10:00:00Z'),
      }),
    );

    const applied = await withBusiness(db, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: 'RKD-SUB-20260815-AAAAAA',
        providerReference: 'ps_1',
        when: now,
      }),
    );
    expect(applied).toBe('applied');

    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('chat');
    expect(overview.status.state).toBe('active');
    expect(overview.charges[0]?.status).toBe('paid');

    // The provider delivering the webhook twice must not extend the cycle.
    const replay = await withBusiness(db, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: 'RKD-SUB-20260815-AAAAAA',
        providerReference: 'ps_1',
        when: new Date('2026-08-15T10:05:00Z'),
      }),
    );
    expect(replay).toBe('already_settled');
    expect((await overviewOf(auth)).status).toEqual(overview.status);
  });

  it('credits an add-on pack to the meter and leaves the plan alone', async () => {
    const { businessId, auth } = await onboard('+2348177100009');
    const now = new Date();
    await putOnPlan(businessId, 'chat', now, new Date(now.getTime() + 30 * 86_400_000));

    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'add_on',
        packId: 'messages_100',
        amountK: 250_000,
        reference: 'RKD-PACK-20260815-BBBBBB',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: 'RKD-PACK-20260815-BBBBBB',
        providerReference: 'ps_2',
        when: now,
      }),
    );

    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('chat');
    const messages = overview.units.find((unit) => unit.unit === 'messages');
    expect(messages?.bonus).toBe(100);
    expect(messages?.used).toBe(0); // bought capacity is not consumption
  });
});

describe('the cycle a payment starts', () => {
  /** Settle a charge of `kind` and read back the cycle it produced. */
  async function settleAndRead(
    businessId: string,
    kind: 'first_purchase' | 'renewal',
    plan: string,
    reference: string,
    when: Date,
  ) {
    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind,
        plan,
        amountK: PLAN_PRICES_K[plan as 'chat'],
        reference,
        periodStart: when,
        periodEnd: new Date(when.getTime() + 30 * 86_400_000),
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      applySettledCharge(tx, { businessId, reference, providerReference: 'ps_x', when }),
    );
    return withBusiness(db, businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId));
  }

  it('gives a RETURNING merchant a full month, not the rest of their old anchor', async () => {
    const { businessId } = await onboard('+2348177100020');

    // They were on a 3rd-of-the-month cycle and let it lapse.
    await putOnPlan(
      businessId,
      'chat',
      new Date('2026-06-03T09:00:00Z'),
      new Date('2026-07-03T09:00:00Z'),
    );
    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep'),
    );

    // And came back on the 20th of August.
    const backOn = new Date('2026-08-20T10:00:00Z');
    const sub = await settleAndRead(
      businessId,
      'first_purchase',
      'chat',
      'RKD-SUB-20260820-CCCCCC',
      backOn,
    );

    /* The stale anchor would have renewed them on 3 September: a full month's
     * price for fourteen days. A first purchase resets it. */
    expect(sub?.renewalAnchorDay).toBe(20);
    expect(sub?.planExpiresAt?.toISOString()).toBe(addMonth(backOn, 20).toISOString());
  });

  it('keeps the anchor on a RENEWAL, so a late payment does not move the date', async () => {
    const { businessId } = await onboard('+2348177100021');
    const cycleEnd = new Date('2026-09-01T09:00:00Z');
    await putOnPlan(businessId, 'chat', new Date('2026-08-01T09:00:00Z'), cycleEnd);

    // Paid three days into the new month.
    const paidLate = new Date('2026-09-04T15:00:00Z');
    const sub = await settleAndRead(
      businessId,
      'renewal',
      'chat',
      'RKD-SUB-20260904-DDDDDD',
      paidLate,
    );

    expect(sub?.planExpiresAt?.toISOString()).toBe(new Date('2026-10-01T09:00:00Z').toISOString());
    /* And the cycle STARTED when the last one ended, not when the money
     * arrived: a later upgrade prorates against a whole month. */
    expect(sub?.cycleStartedAt?.toISOString()).toBe(cycleEnd.toISOString());
  });
});

describe('the renewal sweep', () => {
  const raise = (now: Date) => sweepRenewals({ workerDb, appDb: db }, now);

  it('raises nothing while a cycle is still running', async () => {
    const { businessId } = await onboard('+2348177100022');
    await putOnPlan(
      businessId,
      'chat',
      new Date(Date.now() - 5 * 86_400_000),
      new Date(Date.now() + 25 * 86_400_000),
    );
    expect(await raise(new Date())).toEqual({ raised: 0, skipped: 0 });
  });

  it('raises a charge when the cycle ends and starts the clock AT the renewal date', async () => {
    const { businessId, auth } = await onboard('+2348177100023');
    const renewsAt = new Date(Date.now() - 86_400_000);
    await putOnPlan(businessId, 'chat', new Date(renewsAt.getTime() - 30 * 86_400_000), renewsAt);

    expect(await raise(new Date())).toEqual({ raised: 1, skipped: 0 });

    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges.rows[0]).toMatchObject({ kind: 'renewal', plan: 'chat', status: 'pending' });
    expect(charges.rows[0]?.amountK).toBe(PLAN_PRICES_K.chat);
    // The month bought starts when the last one ended, not when the sweep ran.
    expect(charges.rows[0]?.periodStart?.toISOString()).toBe(renewsAt.toISOString());

    /* A sweep a day late must not hand out an extra day of grace, so the
     * seven days run from the renewal date (floored at two days back: see
     * the outage test below). */
    const sub = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(sub?.paymentFailedAt?.toISOString()).toBe(renewsAt.toISOString());

    const overview = await overviewOf(auth);
    expect(overview.status.state).toBe('grace');
    // Paid features keep working while the merchant settles up.
    expect(overview.plan).toBe('chat');
  });

  it('floors the grace clock after a LONG outage so the ladder still runs', async () => {
    /* Backdating to renewsAt is right for a sweep hours late and pathological
     * after ten days down: the clock would already be past day seven and the
     * next grace pass would expire a paying merchant with zero reminders
     * delivered. The floor guarantees at least five days of dunning. */
    const { businessId } = await onboard('+2348177100027');
    const renewsAt = new Date(Date.now() - 10 * 86_400_000);
    await putOnPlan(businessId, 'chat', new Date(renewsAt.getTime() - 30 * 86_400_000), renewsAt);

    expect(await raise(new Date())).toEqual({ raised: 1, skipped: 0 });

    const sub = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    const failedAt = sub?.paymentFailedAt?.getTime() ?? 0;
    expect(failedAt).toBeGreaterThan(Date.now() - 2 * 86_400_000 - 60_000);
    expect(failedAt).toBeLessThanOrEqual(Date.now());
  });

  it('raises ONE charge per cycle, however many times it runs', async () => {
    const { businessId } = await onboard('+2348177100024');
    const renewsAt = new Date(Date.now() - 86_400_000);
    await putOnPlan(businessId, 'chat', new Date(renewsAt.getTime() - 30 * 86_400_000), renewsAt);

    expect((await raise(new Date())).raised).toBe(1);
    /* The second pass finds nothing: the business is now in grace and drops
     * out of the query, which is the first of two guards. */
    expect(await raise(new Date())).toEqual({ raised: 0, skipped: 0 });

    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges.rows).toHaveLength(1);
    expect(charges.count).toBe(1);
  });

  it('renews onto a scheduled downgrade, which is when it takes effect', async () => {
    const { businessId } = await onboard('+2348177100025');
    const renewsAt = new Date(Date.now() - 86_400_000);
    await putOnPlan(
      businessId,
      'complete',
      new Date(renewsAt.getTime() - 30 * 86_400_000),
      renewsAt,
    );
    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'chat'),
    );

    await raise(new Date());
    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges.rows[0]?.plan).toBe('chat');
    expect(charges.rows[0]?.amountK).toBe(PLAN_PRICES_K.chat);
  });

  it('never renews a trial, which ends rather than lapses', async () => {
    await onboard('+2348177100026');
    expect(await raise(new Date(Date.now() + 400 * 86_400_000))).toEqual({
      raised: 0,
      skipped: 0,
    });
  });

  it('restores everything when the merchant pays the renewal', async () => {
    const { businessId, auth } = await onboard('+2348177100027');
    const renewsAt = new Date(Date.now() - 86_400_000);
    await putOnPlan(businessId, 'chat', new Date(renewsAt.getTime() - 30 * 86_400_000), renewsAt);
    await raise(new Date());

    const [charge] = (
      await withBusiness(db, businessId, (tx) => subscriptionsRepo.chargesFor(tx, businessId))
    ).rows;
    await withBusiness(db, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: charge!.reference,
        providerReference: 'ps_renewal',
        when: new Date(),
      }),
    );

    const overview = await overviewOf(auth);
    expect(overview.status.state).toBe('active');
    expect(overview.charges[0]?.status).toBe('paid');
  });
});

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

  it('sends one reminder on day 1 and none the same day twice', async () => {
    const { auth } = await failedMerchant('+2348177100010');
    const sender = new StubSender();
    const deps = { workerDb, appDb: db, sender };

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
    const deps = { workerDb, appDb: db, sender };

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
    const deps = { workerDb, appDb: db, sender };

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
    const swept = await sweepGracePeriods({ workerDb, appDb: db, sender }, dayAfterFailure(1));
    expect(swept.reminded).toBe(1);
    expect(sender.billingNotices).toEqual([]);
  });

  it('expires on day SEVEN, not day six', async () => {
    const { auth } = await failedMerchant('+2348177100013');
    const sender = new StubSender();
    const deps = { workerDb, appDb: db, sender };

    expect((await sweepGracePeriods(deps, dayAfterFailure(GRACE_DAYS - 1))).expired).toBe(0);
    expect((await overviewOf(auth)).plan).toBe('chat');

    const swept = await sweepGracePeriods(deps, dayAfterFailure(GRACE_DAYS));
    expect(swept.expired).toBe(1);

    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('expired');
    expect(overview.status.state).toBe('expired');

    // And it stops sweeping: an expired merchant is not reminded forever.
    expect(await sweepGracePeriods(deps, dayAfterFailure(GRACE_DAYS + 1))).toEqual({
      reminded: 0,
      expired: 0,
    });
  });

  it('leaves the books readable after expiry', async () => {
    const { auth } = await failedMerchant('+2348177100014');
    await sweepGracePeriods(
      { workerDb, appDb: db, sender: new StubSender() },
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
    const deps = { workerDb, appDb: db, sender };

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
      { workerDb, appDb: db, sender: new StubSender() },
      dayAfterFailure(GRACE_DAYS),
    );

    // `expired` grants zero of everything, and the gate reads that plan.
    const plan = await withBusiness(db, businessId, (tx) => usageRepo.planFor(tx, businessId));
    expect(plan).toBe('expired');
  });
});
