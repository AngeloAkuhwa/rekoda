/**
 * OD-51 (owner instruction, 11 Nov 2026): settlement verifies what a charge costs, so the API holds
 * no settlement credential (migration 0209).
 *
 * Settlement recomputes a charge's kind and amount at the instant it was priced, from the plan
 * catalogue (or the constant table), the pinned version, the guarded cycle columns and the charge's
 * frozen terms, with the openers' own pricing. The claims pinned here, each through the real
 * principals (the CI database authenticates by trust, so each URL is its own role):
 *
 *  - honest charges opened by the application (a first purchase, an upgrade, a pack) and by the
 *    renewal sweep settle and apply exactly as before;
 *  - a charge the application credential opened with the wrong price, interval, quantity or kind is
 *    recorded as paid (payment truth) and set aside for an operator (`price_not_verified`); nothing
 *    is applied and no unit is credited;
 *  - the application can open only a pristine pending charge: never one already paid, failed,
 *    refunded or credited; its creation time is the database's; its pricing time is bounded;
 *  - a zero-priced upgrade is applied by the worker after it re-prices the charge to zero, and one
 *    the application opened at zero with days still left is refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { subscriptionReference } from '@rekoda/core';
import { createDb, identity, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  settlementDb,
  truncateAll,
  type Urls,
  setPricingSource,
} from '@rekoda/db/testing';
import { applyNoChargeUpgradeHandler } from '../jobs/apply-no-charge-upgrade.handler.js';
import { applySettledCharge, BillingService, expectedChargeTerms } from './billing.service.js';
import { sweepRenewals } from './renewal-sweep.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 4 });
    set(db);
    closers.push(close);
  }
});

afterAll(async () => {
  for (const close of closers) await close();
});

beforeEach(async () => {
  await truncateAll(urls);
  /* This suite prices from the compiled constants; the database is told so (OD-51.6, 0215). */
  await setPricingSource(urls, 'constants');
});

const DAY = 86_400_000;
const config = {
  planCatalogueReads: false,
  paystackSecretKey: 'sk_test_x',
  paystackPlatformConfirmed: true,
};
const billing = () => {
  const service = new BillingService(config as never, appDb);
  service.zeroChargeWaitMs = 0;
  return service;
};

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481760${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Verify Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** A provider-bought monthly cycle that renews `msLeft` from now. */
async function onPlan(businessId: string, plan: string, msLeft: number): Promise<void> {
  const renewsAt = new Date(Date.now() + msLeft);
  await withBusiness(appDb, businessId, (tx) =>
    applyFixtureCycle(tx, businessId, {
      plan,
      cycleStartedAt: new Date(renewsAt.getTime() - 30 * DAY),
      renewsAt,
      anchorDay: new Date(renewsAt.getTime() + 3_600_000).getUTCDate(),
    }),
  );
  await ownerDb.execute(
    sql`UPDATE businesses SET subscription_origin = 'provider' WHERE id = ${businessId}::uuid`,
  );
}

const settle = (businessId: string, reference: string) =>
  withBusiness(settlementDb(), businessId, (tx) =>
    applySettledCharge(tx, {
      businessId,
      reference,
      providerReference: `ps_${reference}`,
      when: new Date(),
      config: config as never,
    }),
  );

const chargeOf = async (businessId: string, reference: string) =>
  [
    ...(await ownerDb.execute<{
      status: string;
      unapplied_reason: string | null;
      applied_period_start: string | null;
      created_at: string;
      priced_at: string | null;
    }>(sql`
      SELECT status, unapplied_reason, applied_period_start, created_at::text, priced_at::text
      FROM subscription_charges WHERE business_id = ${businessId}::uuid AND reference = ${reference}`)),
  ][0];

const planOf = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{ plan: string; ends: string | null }>(
      sql`SELECT plan, plan_expires_at::text AS ends FROM businesses WHERE id = ${businessId}::uuid`,
    )),
  ][0]!;

/** Open a charge directly as the application credential, as a stolen credential could. */
async function forge(
  businessId: string,
  terms: {
    kind: 'first_purchase' | 'upgrade' | 'renewal' | 'add_on';
    amountK: number;
    plan?: string | null;
    packId?: string | null;
    quantity?: number;
    billingInterval?: 'monthly' | 'annual';
    periodStart?: Date | null;
    periodEnd?: Date | null;
  },
): Promise<string> {
  const reference = subscriptionReference(new Date(), randomBytes);
  const id = await withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, { businessId, reference, ...terms }),
  );
  if (!id) throw new Error('the forged charge did not open');
  return reference;
}

describe('OD-51: honest charges opened by the application settle as before', () => {
  it('a first purchase opened by the API (as rekoda_app) settles and applies', async () => {
    const businessId = await seedBusiness();
    const answer = await billing().changePlan(businessId, 'chat');
    if (answer.state !== 'payment_required') throw new Error('payable');
    const row = await chargeOf(businessId, answer.reference);
    expect(row?.priced_at).not.toBeNull();

    expect(await settle(businessId, answer.reference)).toBe('applied');
    expect((await planOf(businessId)).plan).toBe('chat');
  });

  it('a prorated upgrade settles and applies', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', 12 * DAY);
    const answer = await billing().changePlan(businessId, 'complete');
    if (answer.state !== 'payment_required') throw new Error('payable');
    expect(answer.amountK).toBeGreaterThan(0);

    expect(await settle(businessId, answer.reference)).toBe('applied');
    expect((await planOf(businessId)).plan).toBe('complete');
  });

  it('a renewal the sweep opened settles and applies', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', -DAY);
    await sweepRenewals({
      settlementDb: settlementDb(),
      workerDb,
      appDb,
      config: config as never,
    });
    const [renewal] = [
      ...(await ownerDb.execute<{ reference: string }>(
        sql`SELECT reference FROM subscription_charges WHERE business_id = ${businessId}::uuid AND kind = 'renewal'`,
      )),
    ];
    expect(await settle(businessId, renewal!.reference)).toBe('applied');
  });
});

describe('OD-51: a mis-priced charge is recorded and never applied', () => {
  const refused = async (businessId: string, reference: string) => {
    expect(await settle(businessId, reference)).toBe('superseded');
    expect(await chargeOf(businessId, reference)).toMatchObject({
      status: 'paid',
      unapplied_reason: 'price_not_verified',
      applied_period_start: null,
    });
  };

  it('a first purchase of Complete for 1 kobo', async () => {
    const businessId = await seedBusiness();
    const reference = await forge(businessId, {
      kind: 'first_purchase',
      plan: 'complete',
      amountK: 1,
    });
    await refused(businessId, reference);
    expect((await planOf(businessId)).plan).toBe('trial');
  });

  it('a year of Chat at the monthly price', async () => {
    const businessId = await seedBusiness();
    const honest = await billing().changePlan(businessId, 'chat');
    if (honest.state !== 'payment_required') throw new Error('payable');
    const reference = await forge(businessId, {
      kind: 'first_purchase',
      plan: 'chat',
      amountK: honest.amountK,
      billingInterval: 'annual',
    });
    await refused(businessId, reference);
    expect((await planOf(businessId)).plan).toBe('trial');
  });

  it('an upgrade to Integrate opened at 1 kobo', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', 12 * DAY);
    const honest = await billing().changePlan(businessId, 'complete');
    if (honest.state !== 'payment_required') throw new Error('payable');
    const [cycle] = [
      ...(await ownerDb.execute<{ start: string; ends: string }>(
        sql`SELECT cycle_started_at::text AS start, plan_expires_at::text AS ends FROM businesses WHERE id = ${businessId}::uuid`,
      )),
    ];
    const reference = await forge(businessId, {
      kind: 'upgrade',
      plan: 'integrate',
      amountK: 1,
      periodStart: new Date(cycle!.start),
      periodEnd: new Date(cycle!.ends),
    });
    await refused(businessId, reference);
    expect((await planOf(businessId)).plan).toBe('chat');
  });

  it('a renewal priced as the cheaper plan for the dearer one', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'complete', -DAY);
    const { ends } = await planOf(businessId);
    const chat = await withBusiness(appDb, businessId, (tx) =>
      expectedChargeTerms(
        tx,
        config,
        businessId,
        {
          kind: 'renewal',
          plan: 'chat',
          billingInterval: 'monthly',
          createdAt: new Date(),
          pricedAt: new Date(),
        } as never,
        null,
      ),
    );
    const reference = await forge(businessId, {
      kind: 'renewal',
      plan: 'complete',
      amountK: chat!.amountK,
      periodStart: new Date(ends!),
      periodEnd: new Date(new Date(ends!).getTime() + 30 * DAY),
    });
    await refused(businessId, reference);
  });

  it('the right amount under the wrong kind: a first purchase opened for a business already paying', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', 20 * DAY);
    // Complete's full monthly price is what a FIRST purchase of it costs, so the amount alone
    // passes; for a business on Chat this is an upgrade (prorated), so only the kind refuses it.
    const honest = await withBusiness(appDb, businessId, (tx) =>
      expectedChargeTerms(
        tx,
        config,
        businessId,
        {
          kind: 'first_purchase',
          plan: 'complete',
          billingInterval: 'monthly',
          createdAt: new Date(),
          pricedAt: new Date(),
        } as never,
        null,
      ),
    );
    expect(honest).toMatchObject({ kind: 'upgrade' });
    const [{ price }] = [{ price: 2_990_000 }]; // Complete's monthly price (the constant table)
    const reference = await forge(businessId, {
      kind: 'first_purchase',
      plan: 'complete',
      amountK: price,
    });
    await refused(businessId, reference);
    expect((await planOf(businessId)).plan).toBe('chat');
  });

  it('ten packs for the price of one credit nothing', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'complete', 20 * DAY);
    const [pack] = [
      ...(await ownerDb.execute<{ pack_id: string; price_minor: string }>(
        sql`SELECT pack_id, price_minor::text FROM usage_packs ORDER BY pack_id LIMIT 1`,
      )),
    ];
    const reference = await forge(businessId, {
      kind: 'add_on',
      packId: pack!.pack_id,
      quantity: 10,
      amountK: Number(pack!.price_minor),
    });
    await refused(businessId, reference);
    const [bonus] = [
      ...(await ownerDb.execute<{ n: string }>(
        sql`SELECT coalesce(sum(bonus), 0)::text AS n FROM usage_counters WHERE business_id = ${businessId}::uuid`,
      )),
    ];
    expect(bonus!.n).toBe('0');
  });
});

describe('OD-51: the application opens only a pristine pending charge (0209)', () => {
  const attempt = async (businessId: string, column: string, value: string) => {
    const reference = subscriptionReference(new Date(), randomBytes);
    return withBusiness(appDb, businessId, (tx) =>
      tx.execute(
        sql.raw(`INSERT INTO subscription_charges (business_id, kind, plan, amount_k, reference, ${column})
                 VALUES ('${businessId}', 'first_purchase', 'chat', 990000, '${reference}', ${value})`),
      ),
    ).then(
      () => 'allowed',
      (error: { cause?: { message?: string } }) => error.cause?.message ?? String(error),
    );
  };

  it.each([
    ['status', "'paid'"],
    ['status', "'refunded'"],
    ['paid_at', 'now()'],
    ['paid_amount_k', '990000'],
    ['provider_reference', "'ps_forged'"],
    ['units_credited_at', 'now()'],
    ['applied_period_start', 'now()'],
    ['unapplied_reason', "'x'"],
    ['blocked_at', 'now()'],
    // 0212: nor any review text a resolved charge would carry.
    ['unapplied_resolution', "'x'"],
    ['unapplied_resolved_by', "'x'"],
    ['blocked_resolution', "'x'"],
    ['blocked_resolved_by', "'x'"],
  ])('refuses an insert with %s = %s', async (column, value) => {
    const businessId = await seedBusiness();
    expect(await attempt(businessId, column, value)).toMatch(
      /the application opens only a new pending charge/,
    );
  });

  it('sets the creation time itself and bounds the pricing time', async () => {
    const businessId = await seedBusiness();
    expect(await attempt(businessId, 'created_at', "now() - interval '30 days'")).toBe('allowed');
    const [row] = [
      ...(await ownerDb.execute<{ age: number }>(
        sql`SELECT extract(epoch FROM now() - created_at)::int AS age FROM subscription_charges WHERE business_id = ${businessId}::uuid`,
      )),
    ];
    expect(row!.age).toBeLessThan(60);
    expect(
      await attempt(businessId, 'priced_at', "clock_timestamp() + interval '2 minutes'"),
    ).toMatch(/priced at most five minutes before it is opened/);
    expect(
      await attempt(businessId, 'priced_at', "clock_timestamp() - interval '6 minutes'"),
    ).toMatch(/priced at most five minutes before it is opened/);
  });

  it('the worker cannot open a charge at all', async () => {
    const businessId = await seedBusiness();
    const reference = subscriptionReference(new Date(), randomBytes);
    await expect(
      withBusiness(workerDb, businessId, (tx) =>
        subscriptionsRepo.openCharge(tx, {
          businessId,
          reference,
          kind: 'first_purchase',
          plan: 'chat',
          amountK: 1,
        }),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/permission denied for table subscription_charges/) },
    });
  });

  it('nobody but settlement and the owner may move the pricing time after opening', async () => {
    const businessId = await seedBusiness();
    const answer = await billing().changePlan(businessId, 'chat');
    if (answer.state !== 'payment_required') throw new Error('payable');
    await expect(
      withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE subscription_charges SET priced_at = priced_at - interval '1 minute'
                       WHERE reference = ${answer.reference}`),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/what a charge buys is set when it is opened/) },
    });
  });
});

describe('OD-51: a zero-priced upgrade is applied by the worker, after it re-prices it', () => {
  const runJob = (businessId: string, reference: string) =>
    withBusiness(settlementDb(), businessId, (tx) =>
      applyNoChargeUpgradeHandler({ config: config as never })({
        tx,
        jobId: '00000000-0000-0000-0000-000000000000',
        businessId,
        payload: { reference },
        attempt: 1,
        maxAttempts: 5,
      }),
    );
  const queued = async (businessId: string) => [
    ...(await ownerDb.execute<{ reference: string }>(sql`
        SELECT payload->>'reference' AS reference FROM jobs
        WHERE business_id = ${businessId}::uuid AND kind = 'billing.apply_no_charge'`)),
  ];

  it('the API answers processing and queues one job; the worker applies it', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', 10 * 3_600_000);

    expect(await billing().changePlan(businessId, 'complete')).toEqual({
      state: 'processing',
      plan: 'complete',
    });
    const jobs = await queued(businessId);
    expect(jobs).toHaveLength(1);
    expect((await planOf(businessId)).plan).toBe('chat');

    await runJob(businessId, jobs[0]!.reference);
    expect((await planOf(businessId)).plan).toBe('complete');
    expect((await chargeOf(businessId, jobs[0]!.reference))?.status).toBe('paid');
  });

  it('the API answers applied when the worker switched it within the wait', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', 10 * 3_600_000);
    const service = billing();
    service.zeroChargeWaitMs = 5_000;
    const pending = service.changePlan(businessId, 'complete');
    for (let i = 0; i < 25; i += 1) {
      const jobs = await queued(businessId);
      if (jobs[0]) {
        await runJob(businessId, jobs[0].reference);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await pending).toEqual({ state: 'applied', plan: 'complete' });
  });

  it('a second click before the worker runs applies one upgrade and sets nothing aside', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', 10 * 3_600_000);

    expect((await billing().changePlan(businessId, 'complete')).state).toBe('processing');
    expect((await billing().changePlan(businessId, 'complete')).state).toBe('processing');
    const jobs = await queued(businessId);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) await runJob(businessId, job.reference);

    expect((await planOf(businessId)).plan).toBe('complete');
    const rows = [
      ...(await ownerDb.execute<{ status: string; unapplied_reason: string | null }>(sql`
        SELECT status, unapplied_reason FROM subscription_charges
        WHERE business_id = ${businessId}::uuid AND kind = 'upgrade' ORDER BY created_at`)),
    ];
    expect(rows.filter((r) => r.status === 'paid')).toHaveLength(1);
    expect(rows.filter((r) => r.unapplied_reason !== null)).toEqual([]);
  });

  it('a zero-priced upgrade the application opened with twelve days left is refused', async () => {
    const businessId = await seedBusiness();
    await onPlan(businessId, 'chat', 12 * DAY);
    const { ends } = await planOf(businessId);
    const [cycle] = [
      ...(await ownerDb.execute<{ start: string }>(
        sql`SELECT cycle_started_at::text AS start FROM businesses WHERE id = ${businessId}::uuid`,
      )),
    ];
    const reference = await forge(businessId, {
      kind: 'upgrade',
      plan: 'complete',
      amountK: 0,
      periodStart: new Date(cycle!.start),
      periodEnd: new Date(ends!),
    });

    await runJob(businessId, reference);

    expect((await planOf(businessId)).plan).toBe('chat');
    expect(await chargeOf(businessId, reference)).toMatchObject({
      status: 'paid',
      unapplied_reason: 'price_not_verified',
    });
  });
});

describe('OD-51: a planted charge is never offered for payment', () => {
  it('checkout refuses a pending charge whose price is not Rekoda own, and asks Paystack nothing', async () => {
    const businessId = await seedBusiness();
    const reference = await forge(businessId, {
      kind: 'first_purchase',
      plan: 'complete',
      amountK: 1,
    });
    const { BillingCheckoutService } = await import('./billing-checkout.service.js');
    const { StubPaymentProvider } = await import('../payments/provider.stub.js');
    const provider = new StubPaymentProvider();
    const answer = await new BillingCheckoutService(
      { ...config, vaultKey: 'a'.repeat(64), webUrl: null } as never,
      appDb,
      provider,
    ).checkout(businessId, reference, 'ada@shop.example.ng');
    expect(answer).toEqual({ state: 'unavailable', reason: 'superseded' });
    expect(provider.initialized).toEqual([]);
  });

  it('a plan change never hands back a pending charge at another price as what is owed', async () => {
    const businessId = await seedBusiness();
    const planted = await forge(businessId, {
      kind: 'first_purchase',
      plan: 'chat',
      amountK: 1,
      // The Lagos day's start, as the opener records a first purchase: the planted charge takes the
      // merchant's own cycle slot.
      periodStart: new Date(Math.floor((Date.now() + 3_600_000) / DAY) * DAY - 3_600_000),
    });
    const answer = await billing().changePlan(businessId, 'chat');
    /* The planted charge is retired and the merchant is asked for today's price instead. */
    expect(answer.state).toBe('payment_required');
    if (answer.state !== 'payment_required') return;
    expect(answer.reference).not.toBe(planted);
    expect(answer.amountK).not.toBe(1);
  });
});
