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
// The billing API suite (ADR 0024). Split by concern; the rest of this suite is in billing-
// paying.integration.test.ts, billing-renewal.integration.test.ts, billing-
// grace.integration.test.ts, billing-grandfathering.integration.test.ts.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMonth, PLAN_PRICES_K } from '@rekoda/core';
import {
  billingCancelResponse,
  billingOverviewResponse,
  billingQuoteResponse,
} from '@rekoda/contracts';
import { createDb, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
import { settlementDb } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sweepRenewals } from './renewal-sweep.js';
import { applySettledCharge, BillingService } from './billing.service.js';
import { CONFIG, type ApiConfig } from '../config.js';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let workerDb: Db;
let ownerDb: Db;
let config: ApiConfig;
let closeOwner: () => Promise<void>;
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
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
  config = app.get<ApiConfig>(CONFIG);
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await closeWorker?.();
  await closeOwner?.();
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
    applyFixtureCycle(tx, businessId, {
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
  it('says a trial that ran out without a payment ended as a trial, not as a subscription', async () => {
    const { businessId, auth } = await onboard('+2348177100094');
    await withBusiness(ownerDb, businessId, (tx) =>
      tx.execute(
        sql`UPDATE businesses SET plan_expires_at = now() - interval '1 day' WHERE id = ${businessId}::uuid`,
      ),
    );
    const overview = await overviewOf(auth);
    expect(overview.status).toMatchObject({ state: 'expired', wasTrial: true });
  });

  it('never tells a merchant who paid that their free trial ended, whatever the origin column says', async () => {
    /* subscription_origin can be NULL for a payer: an operator move to expired clears it, and rows
     * lapsed before migration 0167 were never backfilled. The stored plan decides (G-65, lapseOf). */
    const { businessId, auth } = await onboard('+2348177100095');
    await putOnPlan(
      businessId,
      'chat',
      new Date(Date.now() - 40 * 86_400_000),
      new Date(Date.now() - 86_400_000),
    );
    await withBusiness(ownerDb, businessId, (tx) =>
      tx.execute(
        sql`UPDATE businesses SET plan = 'expired', subscription_origin = NULL WHERE id = ${businessId}::uuid`,
      ),
    );
    const overview = await overviewOf(auth);
    expect(overview.status).toMatchObject({ state: 'expired', wasTrial: false });
  });

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

/*
 * §47 by key kind (OWN-70, 3 Nov 2026). The platform-confirmation flag means the
 * written Paystack confirmation was received: it gates every LIVE-key charge and is irrelevant to a
 * TEST key. A missing or unrecognised key fails closed. Every refusal happens before a charge row
 * exists, so each case also reads the charges table.
 */
describe('the §47 charge gate, by Paystack key kind', () => {
  const billingWith = (paystackSecretKey: string, paystackPlatformConfirmed: boolean) =>
    new BillingService(
      { ...app.get<ApiConfig>(CONFIG), paystackSecretKey, paystackPlatformConfirmed },
      db,
      settlementDb(),
    );
  const chargesOf = (businessId: string) =>
    withBusiness(db, businessId, (tx) => subscriptionsRepo.chargesFor(tx, businessId));
  const onPlan = async (phone: string, plan: string) => {
    const { businessId } = await onboard(phone);
    await putOnPlan(businessId, plan, new Date(), new Date(Date.now() + 30 * 86_400_000));
    return businessId;
  };

  it('opens a plan charge with a test key while §47 is not confirmed', async () => {
    const { businessId } = await onboard('+2348177100201');
    const answer = await billingWith('sk_test_x', false).changePlan(businessId, 'chat');
    expect(answer.state).toBe('payment_required');
    const charges = await chargesOf(businessId);
    expect(charges.count).toBe(1);
    expect(charges.rows[0]?.status).toBe('pending');
  });

  it('opens a pack charge with a test key while §47 is not confirmed', async () => {
    const businessId = await onPlan('+2348177100202', 'complete');
    const answer = await billingWith('sk_test_x', false).buyPack(businessId, 'documents_50');
    expect(answer.state).toBe('payment_required');
    expect((await chargesOf(businessId)).count).toBe(1);
  });

  it('refuses a live-key plan or pack charge until §47 is confirmed, opening nothing', async () => {
    const trial = (await onboard('+2348177100203')).businessId;
    const billing = billingWith('sk_live_x', false);
    expect(await billing.changePlan(trial, 'chat')).toEqual({
      state: 'unavailable',
      reason: 'awaiting_platform_confirmation',
    });
    expect(await chargesOf(trial)).toEqual({ rows: [], count: 0 });

    const paying = await onPlan('+2348177100204', 'complete');
    expect(await billing.buyPack(paying, 'documents_50')).toEqual({
      state: 'unavailable',
      reason: 'awaiting_platform_confirmation',
    });
    expect(await chargesOf(paying)).toEqual({ rows: [], count: 0 });
  });

  it('opens a live-key plan or pack charge once §47 is confirmed', async () => {
    const billing = billingWith('sk_live_x', true);
    const trial = (await onboard('+2348177100205')).businessId;
    expect((await billing.changePlan(trial, 'chat')).state).toBe('payment_required');
    const paying = await onPlan('+2348177100206', 'complete');
    expect((await billing.buyPack(paying, 'documents_50')).state).toBe('payment_required');
  });

  it('fails closed for a missing or unrecognised key even with §47 confirmed, opening nothing', async () => {
    let n = 207;
    for (const key of ['', 'sk_livex', 'pk_test_x', 'garbage']) {
      const billing = billingWith(key, true);
      const trial = (await onboard(`+2348177100${n++}`)).businessId;
      expect(await billing.changePlan(trial, 'chat'), `plan/${key}`).toEqual({
        state: 'unavailable',
        reason: 'payments_not_configured',
      });
      expect(await chargesOf(trial)).toEqual({ rows: [], count: 0 });

      const paying = await onPlan(`+2348177100${n++}`, 'complete');
      expect(await billing.buyPack(paying, 'documents_50'), `pack/${key}`).toEqual({
        state: 'unavailable',
        reason: 'payments_not_configured',
      });
      expect(await chargesOf(paying)).toEqual({ rows: [], count: 0 });
    }
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

    const applied = await withBusiness(settlementDb(), businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: 'RKD-SUB-20260815-AAAAAA',
        providerReference: 'ps_1',
        when: now,
        config,
      }),
    );
    expect(applied).toBe('applied');

    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('chat');
    expect(overview.status.state).toBe('active');
    expect(overview.charges[0]?.status).toBe('paid');

    // The provider delivering the webhook twice must not extend the cycle.
    const replay = await withBusiness(settlementDb(), businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: 'RKD-SUB-20260815-AAAAAA',
        providerReference: 'ps_1',
        when: new Date('2026-08-15T10:05:00Z'),
        config,
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
    await withBusiness(settlementDb(), businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: 'RKD-PACK-20260815-BBBBBB',
        providerReference: 'ps_2',
        when: now,
        config,
      }),
    );

    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('chat');
    const messages = overview.units.find((unit) => unit.unit === 'AI_ACTIONS');
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
    await withBusiness(settlementDb(), businessId, (tx) =>
      applySettledCharge(tx, { businessId, reference, providerReference: 'ps_x', when, config }),
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
    await withBusiness(db, businessId, async (tx) => {
      await subscriptionsRepo.markRenewalFailed(tx, businessId, new Date('2026-07-03T09:00:00Z'));
      await subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep', 'grace');
    });

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

describe('cancelling the subscription', () => {
  const cancel = async (auth: Record<string, string>) =>
    billingCancelResponse.parse((await post('/v1/billing/cancel', {}, auth)).json());

  it('schedules the stop for the day already paid to, and can be undone', async () => {
    const { businessId, auth } = await onboard('+2348177100031');
    const renewsAt = new Date(Date.now() + 20 * 86_400_000);
    await putOnPlan(businessId, 'chat', new Date(Date.now() - 10 * 86_400_000), renewsAt);

    const scheduled = await cancel(auth);
    expect(scheduled).toEqual({ state: 'scheduled', endsAt: renewsAt.toISOString() });
    /* Idempotent: a second click is told what the first one did. */
    expect(await cancel(auth)).toEqual({
      state: 'already_scheduled',
      endsAt: renewsAt.toISOString(),
    });
    expect((await overviewOf(auth)).pendingPlan).toBe('expired');

    /* Changing back to the current plan clears it, the same road that
     * clears a scheduled downgrade. */
    const kept = (await post('/v1/billing/plan', { plan: 'chat' }, auth)).json() as {
      state: string;
    };
    expect(kept.state).toBe('scheduled');
    expect((await overviewOf(auth)).pendingPlan).toBeNull();
  });

  it('ends the cycle with no charge and no grace clock', async () => {
    const { businessId, auth } = await onboard('+2348177100032');
    const renewsAt = new Date(Date.now() - 86_400_000);
    await putOnPlan(businessId, 'chat', new Date(renewsAt.getTime() - 30 * 86_400_000), renewsAt);
    expect(await cancel(auth)).toEqual({ state: 'scheduled', endsAt: renewsAt.toISOString() });

    /* The sweep applies the cancellation instead of raising a renewal. */
    expect(await sweepRenewals({ workerDb, appDb: db, config }, new Date())).toEqual({
      raised: 0,
      skipped: 1,
    });

    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges.rows.filter((c) => c.kind === 'renewal')).toEqual([]);
    const sub = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(sub?.plan).toBe('expired');
    expect(sub?.paymentFailedAt).toBeNull();
    expect((await overviewOf(auth)).plan).toBe('expired');
  });

  it('a trial is answered, not cancelled: it charges nothing and ends by itself', async () => {
    const { auth } = await onboard('+2348177100033');
    const answer = await cancel(auth);
    expect(answer.state).toBe('trial');
  });
});
