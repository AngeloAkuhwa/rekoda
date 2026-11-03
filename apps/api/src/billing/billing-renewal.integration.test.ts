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
// grace.integration.test.ts, billing-grandfathering.integration.test.ts.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_PRICES_K } from '@rekoda/core';
import { billingOverviewResponse } from '@rekoda/contracts';
import { createDb, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sweepRenewals } from './renewal-sweep.js';
import { applySettledCharge } from './billing.service.js';
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

describe('the renewal sweep', () => {
  const raise = (now: Date) => sweepRenewals({ workerDb, appDb: db, config }, now);

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
        config,
      }),
    );

    const overview = await overviewOf(auth);
    expect(overview.status.state).toBe('active');
    expect(overview.charges[0]?.status).toBe('paid');
  });
});

describe('the lock order of a settling payment (G-103)', () => {
  /* Retention deletion locks the business row, then deletes its charges. A
   * settling payment must therefore take the business row BEFORE it touches
   * the charge, or the two can each hold what the other wants and Postgres
   * aborts the payment. The probe is deterministic: while something else
   * holds the business row, a payment that has already updated the charge
   * has locked it, and one that locks the business first has not. */
  it('takes the business row before it touches the charge', async () => {
    const { businessId } = await onboard('+2348177100090');
    const reference = 'sub_lockorder_1';
    const when = new Date('2026-08-20T10:00:00Z');
    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'first_purchase',
        plan: 'chat',
        amountK: PLAN_PRICES_K.chat,
        reference,
        periodStart: when,
        periodEnd: new Date(when.getTime() + 30 * 86_400_000),
      }),
    );

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = withBusiness(db, businessId, async (tx) => {
      await tx.execute(sql`SELECT 1 FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`);
      locked();
      await held;
    });
    await holding;

    // Whatever happens below, the holder must let go, or a failed wait would
    // leave the business row locked and hang the next test's teardown.
    let payment!: Promise<Awaited<ReturnType<typeof applySettledCharge>>>;
    let probe: Error | null = null;
    try {
      payment = withBusiness(db, businessId, (tx) =>
        applySettledCharge(tx, { businessId, reference, providerReference: 'ps_x', when, config }),
      );
      // Wait until the payment is actually parked on the business row, not for
      // a guessed interval that a loaded runner could outlast.
      for (let waited = 0; ; waited += 25) {
        const rows = await ownerDb.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database()
        `);
        if (([...rows][0]?.n ?? 0) >= 1) break;
        if (waited > 8_000) throw new Error('the payment never waited on the business row');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      try {
        await ownerDb.execute(sql`
          SELECT 1 FROM subscription_charges WHERE reference = ${reference} FOR UPDATE NOWAIT
        `);
      } catch (e) {
        probe = e as Error;
      }
    } finally {
      release();
      await holder;
    }
    expect(probe, 'the payment touched the charge before it held the business').toBeNull();
    // A payment that returned early (gone, already settled) would pass the probe for free.
    expect(await payment).toBe('applied');
  });
});
