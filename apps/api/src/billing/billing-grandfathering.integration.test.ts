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
// renewal.integration.test.ts, billing-grace.integration.test.ts.
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { usagePeriod } from '@rekoda/core';
import { billingOverviewResponse, usageMeterResponse } from '@rekoda/contracts';
import {
  createDb,
  planCatalogueRepo,
  subscriptionsRepo,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  resetPlanCatalogue,
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

/** The same service the controller uses, with spec §47 confirmed. */
function confirmedBilling(): BillingService {
  const config = app.get<ApiConfig>(CONFIG);
  return new BillingService(
    { ...config, paystackSecretKey: 'sk_test_x', paystackPlatformConfirmed: true },
    db,
    settlementDb(),
  );
}

const overviewOf = async (auth: Record<string, string>) =>
  billingOverviewResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/billing', headers: auth })).json(),
  );

describe('grandfathering through the catalogue (BL2, PR-100)', () => {
  /* These tests version the catalogue, which truncateAll deliberately does
   * not touch. Put version 1 back before the next test reads it. */
  afterEach(async () => {
    await resetPlanCatalogue(urls);
  });

  it('a new version does not move a pinned merchant: overview and renewal stay as sold', async () => {
    const { businessId, auth } = await onboard('+2348177100061');
    /* Sold Chat, cycle already over: due for renewal. applyCycle pinned the
     * business to the version on sale at the cycle start. */
    const cycleStart = new Date(Date.now() - 30 * 86_400_000);
    await putOnPlan(businessId, 'chat', cycleStart, new Date(Date.now() - 3_600_000));

    /* Chat v2 goes on sale: fewer AI actions at a higher price. */
    await planCatalogueRepo.publishPlanVersion(ownerDb, {
      planId: 'chat',
      name: 'Rekoda Chat',
      seats: 1,
      effectiveFrom: new Date(),
      entitlements: ['REKODA_CHAT'],
      allowances: { AI_ACTIONS: 300, DOCUMENT_GENERATION: 100 },
      prices: [{ currency: 'NGN', billingInterval: 'monthly', amountMinor: 1_490_000 }],
    });

    /* The billing page still quotes what this merchant was sold... */
    const overview = await overviewOf(auth);
    expect(overview.priceK).toBe(990_000);
    expect(overview.units.find((row) => row.unit === 'AI_ACTIONS')?.allowance).toBe(400);

    /* ...and the renewal is raised at the pinned price, not the new one.
     * This is pricing-model.md commercial rule 5 running as code. */
    expect(await sweepRenewals({ workerDb, appDb: db, config }, new Date())).toEqual({
      raised: 1,
      skipped: 0,
    });
    const charges = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    const renewal = charges.rows.find((charge) => charge.kind === 'renewal');
    expect(renewal?.amountK).toBe(990_000);
  });

  it('a merchant who joins after the repricing pays the new price', async () => {
    /* The other half of grandfathering, and the half that keeps the fix
     * honest (remediation R8). Pinning is only correct if it pins the
     * people who were sold a version and nobody else: a pin that also
     * held NEW merchants to version 1 would read as "grandfathering
     * works" on every test above while quietly making a repricing
     * unshippable. */
    const { businessId: pinned, auth: pinnedAuth } = await onboard('+2348177100091');
    await putOnPlan(
      pinned,
      'chat',
      new Date(Date.now() - 30 * 86_400_000),
      new Date(Date.now() + 86_400_000),
    );

    await planCatalogueRepo.publishPlanVersion(ownerDb, {
      planId: 'chat',
      name: 'Rekoda Chat',
      seats: 1,
      effectiveFrom: new Date(),
      entitlements: ['REKODA_CHAT'],
      allowances: { AI_ACTIONS: 300, DOCUMENT_GENERATION: 100 },
      prices: [{ currency: 'NGN', billingInterval: 'monthly', amountMinor: 1_490_000 }],
    });

    const { businessId: fresh, auth: freshAuth } = await onboard('+2348177100092');
    await putOnPlan(fresh, 'chat', new Date(), new Date(Date.now() + 30 * 86_400_000));

    /* Asserted together, because either figure alone is half the claim. */
    expect({
      pinned: (await overviewOf(pinnedAuth)).priceK,
      fresh: (await overviewOf(freshAuth)).priceK,
    }).toEqual({ pinned: 990_000, fresh: 1_490_000 });
  });

  it('the dashboard meter quotes the same ceiling as the billing page (SUB-05)', async () => {
    /* A merchant who joins after Chat v2 goes on sale is metered at v2's allowance. The dashboard
     * meter reads /v1/payments/usage; if it worked its ceiling out from the code constants it would
     * show v1's 400 while the meter enforces 300. */
    await planCatalogueRepo.publishPlanVersion(ownerDb, {
      planId: 'chat',
      name: 'Rekoda Chat',
      seats: 1,
      effectiveFrom: new Date(),
      entitlements: ['REKODA_CHAT'],
      allowances: { AI_ACTIONS: 300, DOCUMENT_GENERATION: 100 },
      prices: [{ currency: 'NGN', billingInterval: 'monthly', amountMinor: 1_490_000 }],
    });
    const { businessId, auth } = await onboard('+2348177100093');
    await putOnPlan(businessId, 'chat', new Date(), new Date(Date.now() + 30 * 86_400_000));

    const billing = await overviewOf(auth);
    const meter = usageMeterResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/payments/usage', headers: auth })).json(),
    );
    expect(billing.units.find((row) => row.unit === 'AI_ACTIONS')?.allowance).toBe(300);
    for (const row of billing.units) {
      const dashboard = meter.units.find((u) => u.unit === row.unit);
      expect({ unit: row.unit, allowance: dashboard?.allowance }).toEqual({
        unit: row.unit,
        allowance: row.allowance,
      });
    }
  });

  it('the data path and the constant path quote one another exactly', async () => {
    /* The cutover's validation: with the catalogue unversioned, the flag
     * must not be observable. Every figure the overview quotes agrees. */
    const { businessId } = await onboard('+2348177100062');
    const onData = new BillingService({ ...config, planCatalogueReads: true }, db, settlementDb());
    const onConstants = new BillingService(
      { ...config, planCatalogueReads: false },
      db,
      settlementDb(),
    );
    const data = await onData.overview(businessId);
    const constants = await onConstants.overview(businessId);
    expect(data.priceK).toBe(constants.priceK);
    expect(data.units).toEqual(constants.units);
  });

  it('a pack repricing between purchase and settlement credits what was bought', async () => {
    const { businessId } = await onboard('+2348177100063');
    await putOnPlan(
      businessId,
      'chat',
      new Date(Date.now() - 5 * 86_400_000),
      new Date(Date.now() + 25 * 86_400_000),
    );

    const answer = await confirmedBilling().buyPack(businessId, 'messages_100');
    if (answer.state !== 'payment_required') throw new Error('expected a payable pack');
    expect(answer.amountK).toBe(250_000);

    /* The pack is resized and repriced before the webhook lands. A version
     * effective at the very millisecond the charge opened is, correctly, the
     * one in force for it, so leave a real gap or this test is a coin flip. */
    await new Promise((resolve) => setTimeout(resolve, 25));
    await planCatalogueRepo.publishUsagePack(ownerDb, {
      packId: 'messages_100',
      label: '250 extra WhatsApp messages',
      unit: 'AI_ACTIONS',
      quantity: 250,
      priceMinor: 500_000,
      currency: 'NGN',
      effectiveFrom: new Date(),
    });

    await withBusiness(settlementDb(), businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: answer.reference,
        providerReference: 'ps_pack_v1',
        when: new Date(),
        config,
      }),
    );

    /* Credited: the 100 messages of the version the charge was opened
     * under, not the 250 on sale by the time the provider confirmed. */
    const counters = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(counters.find((row) => row.unit === 'AI_ACTIONS')?.bonus).toBe(100);
  });

  it('names the pack in the history instead of calling every pack an add-on (G-107)', async () => {
    const { businessId } = await onboard('+2348177100065');
    await putOnPlan(
      businessId,
      'chat',
      new Date(Date.now() - 5 * 86_400_000),
      new Date(Date.now() + 25 * 86_400_000),
    );
    const answer = await confirmedBilling().buyPack(businessId, 'messages_100');
    if (answer.state !== 'payment_required') throw new Error('expected a payable pack');

    const overview = await confirmedBilling().overview(businessId);

    const charge = overview.charges.find((row) => row.reference === answer.reference);
    expect(charge?.packLabel).toBe('100 extra WhatsApp messages');
    expect(overview.charges.find((row) => row.kind !== 'add_on')?.packLabel ?? null).toBeNull();
  });

  it('shows what a partial refund gave back, so the row does not read as the full amount net (G-111)', async () => {
    const { businessId } = await onboard('+2348177100066');
    await putOnPlan(
      businessId,
      'chat',
      new Date(Date.now() - 5 * 86_400_000),
      new Date(Date.now() + 25 * 86_400_000),
    );
    const answer = await confirmedBilling().buyPack(businessId, 'messages_100');
    if (answer.state !== 'payment_required') throw new Error('expected a payable pack');
    await withBusiness(settlementDb(), businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: answer.reference,
        providerReference: 'ps_refund_1',
        when: new Date(),
        config,
      }),
    );
    // Before any refund the same charge reports nothing returned.
    const before = await confirmedBilling().overview(businessId);
    expect(before.charges.find((row) => row.reference === answer.reference)?.refundedAmountK).toBe(
      0,
    );

    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.refundCharge(tx, answer.reference, 100_000, new Date()),
    );

    const overview = await confirmedBilling().overview(businessId);
    const charge = overview.charges.find((row) => row.reference === answer.reference);

    // Still paid: only part came back. The amount that did is on the row.
    expect(charge?.status).toBe('paid');
    expect(charge?.refundedAmountK).toBe(100_000);
  });

  it('a pack is offered exactly where its unit is sold: Integrate is not sold Chat overage', async () => {
    const { businessId } = await onboard('+2348177100064');
    await putOnPlan(
      businessId,
      'integrate',
      new Date(Date.now() - 5 * 86_400_000),
      new Date(Date.now() + 25 * 86_400_000),
    );

    const overview = await confirmedBilling().overview(businessId);
    const offered = overview.packs.map((pack) => pack.id).sort();
    /* Integrate sells documents and orders; it holds no REKODA_CHAT, so
     * message and voice packs would be capacity the gate refuses. */
    expect(offered).toEqual(['documents_50', 'orders_50']);

    const refused = await confirmedBilling().buyPack(businessId, 'messages_100');
    expect(refused).toEqual({ state: 'unavailable', reason: 'not_available_on_plan' });
  });
});
