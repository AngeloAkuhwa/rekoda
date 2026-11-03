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
// billing.integration.test.ts, billing-renewal.integration.test.ts, billing-
// grace.integration.test.ts, billing-grandfathering.integration.test.ts.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_PRICES_K } from '@rekoda/core';
import { billingOverviewResponse } from '@rekoda/contracts';
import { billingRepo, createDb, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { applySettledCharge, BillingService } from './billing.service.js';
import { CONFIG, type ApiConfig } from '../config.js';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let ownerDb: Db;
let config: ApiConfig;
let closeOwner: () => Promise<void>;
let closeDb: () => Promise<void>;

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
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
  config = app.get<ApiConfig>(CONFIG);
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
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
  return new BillingService(
    { ...config, paystackSecretKey: 'sk_test_x', paystackPlatformConfirmed: true },
    db,
  );
}

const overviewOf = async (auth: Record<string, string>) =>
  billingOverviewResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/billing', headers: auth })).json(),
  );

describe('paying, and the gate in front of it', () => {
  it('refuses a paid change over HTTP without opening a charge when no Paystack key is set', async () => {
    /* The suite's app boots with no PAYSTACK_SECRET_KEY. A live key without the
     * §47 confirmation is refused the same way, with its own reason: see
     * "the §47 charge gate, by Paystack key kind" above. */
    const { businessId, auth } = await onboard('+2348177100004');
    const answer = (await post('/v1/billing/plan', { plan: 'chat' }, auth)).json() as {
      state: string;
      reason?: string;
    };
    expect(answer).toEqual({ state: 'unavailable', reason: 'payments_not_configured' });

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

  it('refuses to prorate a one-year operator arrangement and changes nothing (OWN-33, G-115)', async () => {
    const { businessId } = await onboard('+2348177100099');
    const now = new Date();
    await putOnPlan(
      businessId,
      'chat',
      new Date(now.getTime() - 182 * 86_400_000),
      new Date(now.getTime() + 183 * 86_400_000),
    );
    const before = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );

    const billing = confirmedBilling();
    const quote = await billing.quote(businessId, 'complete', now);
    expect(quote.supportReview).toBe(true);
    expect(quote.amountK).toBe(0);

    const answer = await billing.changePlan(businessId, 'complete', now);
    expect(answer).toEqual({ state: 'unavailable', reason: 'support_review' });

    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges.count).toBe(0);
    const after = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(after).toEqual(before);
  });

  it('treats a dated plan with no recorded cycle start as custom, not prorated (OWN-33)', async () => {
    const { businessId } = await onboard('+2348177100098');
    const now = new Date();
    await putOnPlan(
      businessId,
      'chat',
      new Date(now.getTime() - 10 * 86_400_000),
      new Date(now.getTime() + 300 * 86_400_000),
    );
    await ownerDb.execute(sql`UPDATE businesses SET cycle_started_at = NULL`);

    const answer = await confirmedBilling().changePlan(businessId, 'complete', now);
    expect(answer).toEqual({ state: 'unavailable', reason: 'support_review' });
    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges.count).toBe(0);
  });

  it('treats an open-ended paid plan (no expiry) as custom, not prorated (OWN-33)', async () => {
    const { businessId } = await onboard('+2348177100097');
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'chat',
      expiresAt: null,
      actor: 'operator:test-g115',
    });

    const billing = confirmedBilling();
    const quote = await billing.quote(businessId, 'complete', new Date());
    expect(quote.supportReview).toBe(true);
    const answer = await billing.changePlan(businessId, 'complete', new Date());
    expect(answer).toEqual({ state: 'unavailable', reason: 'support_review' });
    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges.count).toBe(0);
  });

  describe('an operator-defined arrangement is never prorated, whatever its length (OWN-33 Option B)', () => {
    const DAY = 86_400_000;
    const expectNoCharge = async (businessId: string) => {
      const charges = await withBusiness(db, businessId, (tx) =>
        subscriptionsRepo.chargesFor(tx, businessId),
      );
      expect(charges.count).toBe(0);
    };

    it.each([
      ['a 30-day cycle', 30],
      ['a custom 45-day cycle', 45],
      ['an annual cycle', 365],
    ])('sends %s granted by an operator to support review', async (_label, days) => {
      const { businessId } = await onboard(`+23481771${String(2000 + days).padStart(5, '0')}`);
      const now = new Date();
      await billingRepo.setPlan(db, {
        businessId,
        plan: 'chat',
        expiresAt: new Date(now.getTime() + days * DAY),
        actor: 'operator:test-g115',
      });
      const before = await withBusiness(db, businessId, (tx) =>
        subscriptionsRepo.subscriptionFor(tx, businessId),
      );
      expect(before?.origin).toBe('operator');

      const billing = confirmedBilling();
      const quote = await billing.quote(businessId, 'complete', now);
      const answer = await billing.changePlan(businessId, 'complete', now);
      // The preview and the execution agree.
      expect(quote.supportReview).toBe(true);
      expect(quote.amountK).toBe(0);
      expect(answer).toEqual({ state: 'unavailable', reason: 'support_review' });

      await expectNoCharge(businessId);
      const after = await withBusiness(db, businessId, (tx) =>
        subscriptionsRepo.subscriptionFor(tx, businessId),
      );
      expect(after).toEqual(before);
    });

    it('sends a paid cycle of unknown origin to support review, however standard it looks', async () => {
      const { businessId } = await onboard('+2348177100301');
      const now = new Date();
      await putOnPlan(
        businessId,
        'chat',
        new Date(now.getTime() - 11 * DAY),
        new Date(now.getTime() + 19 * DAY),
      );
      await ownerDb.execute(
        sql`UPDATE businesses SET subscription_origin = NULL WHERE id = ${businessId}::uuid`,
      );
      const billing = confirmedBilling();
      expect((await billing.quote(businessId, 'complete', now)).supportReview).toBe(true);
      expect(await billing.changePlan(businessId, 'complete', now)).toEqual({
        state: 'unavailable',
        reason: 'support_review',
      });
      await expectNoCharge(businessId);
    });

    it('still prorates a provider-bought standard monthly cycle, and quote and change agree', async () => {
      const { businessId } = await onboard('+2348177100302');
      const now = new Date();
      await putOnPlan(
        businessId,
        'chat',
        new Date(now.getTime() - 11 * DAY),
        new Date(now.getTime() + 19 * DAY),
      );
      const billing = confirmedBilling();
      const quote = await billing.quote(businessId, 'complete', now);
      expect(quote.supportReview).toBe(false);
      const answer = await billing.changePlan(businessId, 'complete', now);
      expect(answer.state).toBe('payment_required');
      if (answer.state !== 'payment_required') throw new Error('unreachable');
      expect(answer.amountK).toBe(quote.amountK);
    });

    it('a provider payment, then an operator move, then a request: the operator move wins', async () => {
      const { businessId } = await onboard('+2348177100303');
      const now = new Date();
      await putOnPlan(
        businessId,
        'chat',
        new Date(now.getTime() - 11 * DAY),
        new Date(now.getTime() + 19 * DAY),
      );
      await billingRepo.setPlan(db, {
        businessId,
        plan: 'chat',
        expiresAt: new Date(now.getTime() + 30 * DAY),
        actor: 'operator:test-g115',
      });
      expect(await confirmedBilling().changePlan(businessId, 'complete', now)).toEqual({
        state: 'unavailable',
        reason: 'support_review',
      });
    });

    it('concurrent and repeated requests open no charge and cannot slip past the rule', async () => {
      const { businessId } = await onboard('+2348177100304');
      const now = new Date();
      await billingRepo.setPlan(db, {
        businessId,
        plan: 'chat',
        expiresAt: new Date(now.getTime() + 30 * DAY),
        actor: 'operator:test-g115',
      });
      const billing = confirmedBilling();
      const answers = await Promise.all(
        Array.from({ length: 6 }, () => billing.changePlan(businessId, 'complete', now)),
      );
      for (const answer of answers) {
        expect(answer).toEqual({ state: 'unavailable', reason: 'support_review' });
      }
      expect(await billing.changePlan(businessId, 'complete', now)).toEqual({
        state: 'unavailable',
        reason: 'support_review',
      });
      await expectNoCharge(businessId);
    });
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
        config,
      }),
    );

    const overview = await overviewOf(auth);
    expect(overview.plan).toBe('complete');
    expect(overview.status).toEqual({ state: 'active', renewsAt: renewsAt.toISOString() });
  });

  it('does not let a settling upgrade turn a non-provider cycle into a provider one (OWN-34)', async () => {
    const { businessId } = await onboard('+2348177100305');
    const now = new Date();
    await putOnPlan(
      businessId,
      'chat',
      new Date(now.getTime() - 11 * 86_400_000),
      new Date(now.getTime() + 19 * 86_400_000),
    );
    const answer = await confirmedBilling().changePlan(businessId, 'complete', now);
    if (answer.state !== 'payment_required') throw new Error('expected a charge');
    // A charge opened before the origin rule existed, against a cycle whose origin is unknown.
    await ownerDb.execute(
      sql`UPDATE businesses SET subscription_origin = NULL WHERE id = ${businessId}::uuid`,
    );

    const result = await withBusiness(db, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: answer.reference,
        providerReference: 'ps_old_upgrade',
        when: now,
        config,
      }),
    );
    expect(result).toBe('superseded');
    const after = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(after?.plan).toBe('chat');
    expect(after?.origin).toBeNull();
  });

  it('settlement applies the same rule as the quote: a provider cycle that is no longer a standard month is refused (OWN-34)', async () => {
    const { businessId } = await onboard('+2348177100306');
    const now = new Date();
    await putOnPlan(
      businessId,
      'chat',
      new Date(now.getTime() - 11 * 86_400_000),
      new Date(now.getTime() + 19 * 86_400_000),
    );
    const answer = await confirmedBilling().changePlan(businessId, 'complete', now);
    if (answer.state !== 'payment_required') throw new Error('expected a charge');
    await ownerDb.execute(
      sql`UPDATE businesses SET plan_expires_at = cycle_started_at + interval '365 days' WHERE id = ${businessId}::uuid`,
    );

    const result = await withBusiness(db, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: answer.reference,
        providerReference: 'ps_nonstandard',
        when: now,
        config,
      }),
    );
    expect(result).toBe('superseded');
    const after = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.subscriptionFor(tx, businessId),
    );
    expect(after?.plan).toBe('chat');
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
