/**
 * The operator health surface, over a real application and a real database.
 *
 * Two things are being asserted and only one of them is the numbers. The
 * other is that this endpoint is shut: it answers a question that spans every
 * tenant, so a merchant session reaching it would be a cross-tenant read with
 * a friendly name.
 */
import { randomBytes } from 'node:crypto';
import { usagePeriod } from '@rekoda/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  billingRepo,
  createDb,
  customersRepo,
  events,
  identity,
  issueRepo,
  jobsRepo,
  planCatalogueRepo,
  quotaRepo,
  sql,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import {
  migrate,
  requireUrls,
  resetPlanCatalogue,
  storedEventId,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';

const SECRET = 'test-secret-at-least-32-characters-long';
/* Deliberately different from REKODA_API_SECRET, which is the point of it
 * existing: this one travels in a plaintext header and must not be the key
 * that signs setup grants. Config refuses to boot if they match. */
const OPERATOR_SECRET = `operator-${SECRET}`;

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let ownerDb: Db;
let closeDb: () => Promise<void>;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  // The queue and the event counts both span tenants, so the endpoint needs
  // the worker credential to count either. Given here WITHOUT REKODA_WORKER,
  // which is the arrangement worth testing: a web process that runs no jobs
  // still reports both.
  process.env['WORKER_DATABASE_URL'] = urls.worker;
  delete process.env['REKODA_WORKER'];
  process.env['OTP_PEPPER'] = 'test-pepper-at-least-32-characters-long';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = SECRET;
  process.env['REKODA_OPERATOR_SECRET'] = OPERATOR_SECRET;
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

function health(headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: '/v1/ops/health', headers });
}

function margin(query = '', headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: `/v1/ops/margin${query}`, headers });
}

function exceptions(query = '', headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: `/v1/ops/exceptions${query}`, headers });
}

function resolveException(id: string, body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: `/v1/ops/exceptions/${id}/resolve`,
    payload: body as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/* 401 throughout, not 403. The operator guard separates the two questions
 * the old blanket status ran together: no credential, or one that does not
 * verify, is a failure of AUTHENTICATION, and 401 is what says so. 403 now
 * means something narrower and more useful — the guard DID identify the
 * caller, and the identity it read lacks the scope this route declares. */
describe('who can read the operator health surface', () => {
  it('refuses a request with no secret', async () => {
    expect((await health()).statusCode).toBe(401);
  });

  it('refuses a wrong secret of the same length', async () => {
    const wrong = 'x'.repeat(OPERATOR_SECRET.length);
    expect((await health({ 'x-rekoda-operator-secret': wrong })).statusCode).toBe(401);
  });

  it('refuses a secret that is merely a prefix', async () => {
    const short = OPERATOR_SECRET.slice(0, 8);
    expect((await health({ 'x-rekoda-operator-secret': short })).statusCode).toBe(401);
  });

  it('answers the right secret', async () => {
    expect((await health({ 'x-rekoda-operator-secret': OPERATOR_SECRET })).statusCode).toBe(200);
  });
});

describe('what the operator health surface says', () => {
  it('is all zeros on a quiet platform', async () => {
    const res = await health({ 'x-rekoda-operator-secret': OPERATOR_SECRET });

    expect(res.json()).toEqual({
      queue: { dead: 0, pending: 0, running: 0, oldestPendingSeconds: 0 },
      meta: { unprocessed: 0, flagged: 0, badSignatures: 0 },
      paystack: { unprocessed: 0, flagged: 0, badSignatures: 0 },
      // The live rejected-signature counters (PR-108): zero on a quiet
      // platform, and the number that actually moves when someone probes.
      rejectedSignatures: { meta: 0, paystack: 0 },
    });
  });

  it('counts a queued job even though this process claims none', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348030000001');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Stores',
      businessType: null,
      ownerUserId: user.id,
    });
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, { businessId: business.id, kind: 'inbound.message' }),
    );

    const body = await health({ 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) =>
      r.json(),
    );

    expect(body.queue.pending).toBe(1);
  });

  it('counts webhook intake per provider', async () => {
    await events.recordEvent(db, {
      provider: 'paystack',
      eventType: 'charge.success',
      externalId: 'evt.waiting',
      payload: { sealed: true },
      businessId: null,
    });

    const body = await health({ 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) =>
      r.json(),
    );

    expect(body.paystack.unprocessed).toBe(1);
    expect(body.meta.unprocessed).toBe(0);
  });

  it('names no business and no person', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348030000002');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Chidi Electronics',
      businessType: null,
      ownerUserId: user.id,
    });
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, { businessId: business.id, kind: 'inbound.message' }),
    );

    const raw = await health({ 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) => r.body);

    expect(raw).not.toContain('Chidi');
    expect(raw).not.toContain(business.id);
    expect(raw).not.toContain('2348030000002');
  });
});

/**
 * The margin report over the same real application.
 *
 * `usage_events` had been collecting since metering shipped with nothing
 * reading it. These assert both halves of "reading it": the arithmetic, and
 * the fact that the gate in front of it is the same shut one.
 */
describe('the margin report', () => {
  /* The month the clock is in, not a month written down.
   *
   * The fixture's telemetry carries whatever period it is handed, but every
   * MONEY figure in this report comes from `platform_cost_events`, which
   * `recordUsage` stamps with `incurred_at: new Date()`, and the report
   * selects that subledger by the Lagos-month window of the period asked
   * for. A literal agreed with the clock only for as long as the clock was
   * in that month: on the first of the next one every cost, total and
   * `byCostType` row went to zero and five tests failed on the calendar
   * rather than on the code. `usagePeriod` is the same Lagos-month helper
   * the endpoint itself defaults to, so the month written and the month
   * asked for are one month by construction. */
  const PERIOD = usagePeriod(new Date());

  async function merchant(name: string, phone: string, plan: string): Promise<string> {
    const user = await identity.upsertUserByPhone(db, phone);
    const business = await identity.createBusinessWithOwner(db, {
      name,
      businessType: null,
      ownerUserId: user.id,
    });
    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan,
      expiresAt: null,
      actor: 'operator:test',
    });
    return business.id;
  }

  function spend(
    businessId: string,
    provider: quotaRepo.UsageRecord['provider'],
    nairaEquivalentK: number,
  ): Promise<void> {
    return withBusiness(db, businessId, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        provider,
        usageType: 'test',
        quantity: 1,
        providerCostMicros: 0,
        nairaEquivalentK,
        billingPeriod: PERIOD,
      }),
    );
  }

  it('is shut to a request with no secret', async () => {
    expect((await margin()).statusCode).toBe(401);
  });

  it('is shut to a wrong secret of the same length', async () => {
    const wrong = 'x'.repeat(OPERATOR_SECRET.length);
    expect((await margin('', { 'x-rekoda-operator-secret': wrong })).statusCode).toBe(401);
  });

  it('refuses a period that is not a month', async () => {
    const response = await margin('?period=august', {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a thirteenth month', async () => {
    const response = await margin('?period=2026-13', {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    });
    expect(response.statusCode).toBe(400);
  });

  it('prices each merchant against their plan', async () => {
    const chat = await merchant('Chat Shop', '+2348030000201', 'chat');
    const complete = await merchant('Complete Shop', '+2348030000202', 'complete');
    await spend(chat, 'meta', 120_000);
    await spend(chat, 'anthropic', 9_000);
    await spend(complete, 'meta', 300_000);

    const body = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.json());

    const rows = new Map(body.businesses.map((b: { businessId: string }) => [b.businessId, b]));
    expect(rows.get(chat)).toMatchObject({
      plan: 'chat',
      revenueK: 990_000,
      costK: 129_000,
      marginK: 861_000,
      costRatioBp: 1_303,
    });
    expect(rows.get(complete)).toMatchObject({ revenueK: 2_990_000, costK: 300_000 });
  });

  it('counts a trial as cost with no revenue rather than hiding it', async () => {
    const trial = await merchant('Trying It', '+2348030000203', 'trial');
    await spend(trial, 'meta', 45_000);

    const body = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.json());

    const row = body.businesses.find((b: { businessId: string }) => b.businessId === trial);
    expect(row).toMatchObject({ revenueK: 0, costK: 45_000, marginK: -45_000, costRatioBp: null });
    expect(body.total.businesses).toBe(1);
    expect(body.total.paying).toBe(0);
    expect(body.total.costK).toBe(45_000);
    expect(body.total.marginK).toBe(-45_000);
    expect(body.total.costRatioBp).toBeNull();
  });

  it('totals the estate rather than the rows it printed', async () => {
    const one = await merchant('One', '+2348030000204', 'chat');
    const two = await merchant('Two', '+2348030000205', 'integrate');
    await merchant('Three', '+2348030000209', 'trial');
    await spend(one, 'meta', 60_000);
    await spend(two, 'meta', 240_000);

    const body = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.json());

    expect(body.total.revenueK).toBe(990_000 + 1_990_000);
    expect(body.total.costK).toBe(300_000);
    expect(body.total.marginK).toBe(990_000 + 1_990_000 - 300_000);
    expect(body.total.businesses).toBe(3);
    expect(body.total.paying).toBe(2);
    expect(body.total.spending).toBe(2);
    expect(body.total.events).toBe(2);
  });

  it('splits the spend by who Rekoda is paying', async () => {
    const shop = await merchant('Split', '+2348030000206', 'chat');
    await spend(shop, 'meta', 80_000);
    await spend(shop, 'anthropic', 12_000);

    const body = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.json());

    expect(body.byProvider).toEqual([
      { provider: 'meta', costK: 80_000, quantity: 1, events: 1 },
      { provider: 'anthropic', costK: 12_000, quantity: 1, events: 1 },
    ]);

    /* And the same money by §29 class, off the subledger: the report's
     * figures come from platform_cost_events, and this is where an ACTUAL
     * invoice row will one day stand beside the rate-card estimates. */
    expect(body.byCostType).toEqual([
      {
        costType: 'MESSAGING',
        provider: 'meta',
        actualOrEstimated: 'ESTIMATED',
        costK: 80_000,
        events: 1,
      },
      {
        costType: 'AI_INFERENCE',
        provider: 'anthropic',
        actualOrEstimated: 'ESTIMATED',
        costK: 12_000,
        events: 1,
      },
    ]);
  });

  it('prices a grandfathered merchant at the version they were sold', async () => {
    const pinned = await merchant('Launch Cohort', '+2348030000210', 'trial');
    /* Sold Chat through the real cycle path, which pins version 1. */
    await withBusiness(db, pinned, (tx) =>
      subscriptionsRepo.applyCycle(tx, pinned, {
        plan: 'chat',
        cycleStartedAt: new Date(),
        renewsAt: new Date(Date.now() + 30 * 86_400_000),
        anchorDay: 15,
      }),
    );
    await spend(pinned, 'meta', 50_000);

    /* Chat is repriced upward; the pinned merchant must not move. */
    await planCatalogueRepo.publishPlanVersion(ownerDb, {
      planId: 'chat',
      name: 'Rekoda Chat',
      seats: 1,
      effectiveFrom: new Date(),
      entitlements: ['REKODA_CHAT'],
      allowances: { AI_ACTIONS: 400 },
      prices: [{ currency: 'NGN', billingInterval: 'monthly', amountMinor: 1_490_000 }],
    });
    try {
      const body = await margin(`?period=${PERIOD}`, {
        'x-rekoda-operator-secret': OPERATOR_SECRET,
      }).then((r) => r.json());

      const row = body.businesses.find((b: { businessId: string }) => b.businessId === pinned);
      expect(row).toMatchObject({ plan: 'chat', revenueK: 990_000, costK: 50_000 });
      expect(body.total.revenueK).toBe(990_000);
    } finally {
      await resetPlanCatalogue(urls);
    }
  });

  it('lists the months that have usage, so nobody guesses at an empty one', async () => {
    const shop = await merchant('Historic', '+2348030000207', 'chat');
    await spend(shop, 'meta', 1_000);

    const body = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.json());

    expect(body.availablePeriods).toEqual([PERIOD]);
  });

  it('defaults to the current billing month', async () => {
    const body = await margin('', { 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) =>
      r.json(),
    );
    expect(body.period).toBe(new Date(Date.now() + 3_600_000).toISOString().slice(0, 7));
  });

  it('carries ids and no names, no phone numbers and no customers', async () => {
    const shop = await merchant('Chidi Electronics', '+2348030000208', 'chat');
    await spend(shop, 'meta', 5_000);

    const raw = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.body);

    expect(raw).toContain(shop);
    expect(raw).not.toContain('Chidi');
    expect(raw).not.toContain('2348030000208');
  });
});

/**
 * The operator's commercial surface (ADR 0024).
 *
 * `/refunds` publishes a matrix promising money back in five situations, and
 * until now nothing in the system could record a refund at all. Upgrade
 * requests had the same shape: `recordUpgradeRequest` has stored them since
 * before self-service billing existed and nothing has ever shown one to
 * anybody.
 */
describe('the operator billing surface', () => {
  const auth = { 'x-rekoda-operator-secret': OPERATOR_SECRET };

  async function merchantWithCharge(phone: string): Promise<{
    businessId: string;
    reference: string;
  }> {
    const user = await identity.upsertUserByPhone(db, phone);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const reference = 'RKD-SUB-20260821-AAAAAA';
    await withBusiness(db, business.id, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId: business.id,
        kind: 'first_purchase',
        plan: 'chat',
        amountK: 990_000,
        reference,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86_400_000),
      }),
    );
    await withBusiness(db, business.id, (tx) =>
      subscriptionsRepo.settleCharge(tx, { reference, status: 'paid', when: new Date() }),
    );
    return { businessId: business.id, reference };
  }

  const view = (businessId: string, headers: Record<string, string> = auth) =>
    app.inject({ method: 'GET', url: `/v1/ops/business/${businessId}`, headers });

  const refund = (payload: unknown, headers: Record<string, string> = auth) =>
    app.inject({
      method: 'POST',
      url: '/v1/ops/refund',
      payload: payload as Record<string, unknown>,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('refuses both endpoints without the operator secret', async () => {
    const { businessId, reference } = await merchantWithCharge('+2348140001001');
    expect((await view(businessId, {})).statusCode).toBe(401);
    expect(
      (await refund({ businessId, reference, amountK: 1, reason: 'duplicate_charge' }, {}))
        .statusCode,
    ).toBe(401);
  });

  it('shows the plan, the charges and the upgrade requests together', async () => {
    const { businessId, reference } = await merchantWithCharge('+2348140001002');
    await withBusiness(db, businessId, (tx) =>
      billingRepo.recordUpgradeRequest(tx, businessId, 'trial'),
    );

    const body = (await view(businessId)).json() as {
      plan: string;
      charges: Array<{ reference: string; status: string }>;
      upgradeRequests: Array<{ fromPlan: string }>;
    };
    expect(body.charges[0]).toMatchObject({ reference, status: 'paid' });
    // Three rows nobody could see, before this.
    expect(body.upgradeRequests).toEqual([{ fromPlan: 'trial', at: expect.any(String) }]);
  });

  it('refuses a business id that is not a UUID, and one that does not exist', async () => {
    expect((await view('not-a-uuid')).statusCode).toBe(400);
    expect((await view('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('records a partial refund without calling the charge refunded', async () => {
    const { businessId, reference } = await merchantWithCharge('+2348140001003');

    const res = await refund({
      businessId,
      reference,
      amountK: 490_000,
      reason: 'service_failure',
    });
    expect(res.statusCode).toBe(200);
    // Half back is still a charge that happened.
    expect(res.json()).toMatchObject({ refunded: true, status: 'paid', refundedK: 490_000 });

    const charge = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargeByReference(tx, businessId, reference),
    );
    expect(charge?.status).toBe('paid');
  });

  it('calls it refunded only when the whole amount is back, and never more', async () => {
    const { businessId, reference } = await merchantWithCharge('+2348140001004');
    const body = (amountK: number) => ({
      businessId,
      reference,
      amountK,
      reason: 'duplicate_charge' as const,
    });

    expect((await refund(body(990_000))).json()).toMatchObject({ status: 'refunded' });
    // A second refund cannot take back more than we ever took.
    expect((await refund(body(1))).statusCode).toBe(400);
  });

  it('leaves the PLAN alone: a refund is money, not a cancellation', async () => {
    const { businessId, reference } = await merchantWithCharge('+2348140001005');
    await withBusiness(db, businessId, (tx) =>
      billingRepo.setPlan(db, {
        businessId,
        plan: 'chat',
        expiresAt: new Date(Date.now() + 20 * 86_400_000),
        actor: 'operator:test',
      }),
    );

    await refund({
      businessId,
      reference,
      amountK: 990_000,
      reason: 'service_failure',
    });

    /* ADR 0024 refunds money in several situations that all leave the
     * merchant with the period they paid for. Cancelling here would be a
     * second decision nobody made. */
    const body = (await view(businessId)).json() as { plan: string };
    expect(body.plan).toBe('chat');
  });

  it('refuses a reason that is not one of the published rows', async () => {
    const { businessId, reference } = await merchantWithCharge('+2348140001006');
    const res = await refund({
      businessId,
      reference,
      amountK: 1_000,
      reason: 'because I felt like it',
    });
    // The policy is a table; the audit trail has to reconcile with it.
    expect(res.statusCode).toBe(400);
  });
});

/**
 * The one surface here that returns rows.
 *
 * It earns the exception because an unattributed event belongs to no tenant:
 * no merchant can ever see it, so if an operator cannot then nobody can. What
 * it must never return is the payload, and that is the assertion below that
 * would matter most if it broke.
 */
describe('the exception queue', () => {
  const operator = { 'x-rekoda-operator-secret': OPERATOR_SECRET };

  async function record(externalId: string) {
    return storedEventId(
      await events.recordEvent(db, {
        provider: 'paystack',
        eventType: 'charge.success',
        externalId,
        payload: { sender: '+2348120000001', text: 'a merchant said something private' },
        businessId: null,
      }),
    );
  }

  it('is shut to anyone without the operator secret', async () => {
    expect((await exceptions()).statusCode).toBe(401);
    expect((await exceptions('', { 'x-rekoda-operator-secret': 'nope' })).statusCode).toBe(401);
    expect(
      (await resolveException('00000000-0000-0000-0000-000000000000', { resolution: 'x' }))
        .statusCode,
    ).toBe(401);
  });

  it('is two empty lists on a quiet platform', async () => {
    const res = await exceptions('', operator);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stuck: [], flagged: [] });
  });

  it('shows what is waiting and what was flagged, and NEVER the payload', async () => {
    const stuck = await record('evt.api.stuck');
    const flagged = await record('evt.api.flagged');
    await events.markProcessed(db, flagged, 'unknown_reference');

    const res = await exceptions('', operator);
    const body = res.json() as { stuck: Array<{ id: string }>; flagged: Array<{ id: string }> };

    expect(body.stuck.map((r) => r.id)).toEqual([stuck]);
    expect(body.flagged.map((r) => r.id)).toEqual([flagged]);

    /* The seal is the point: a triage list that leaked a provider body would
     * put a merchant's number and their message behind one plaintext header.
     *
     * Two independent guards hold this, which was worth finding out. The repo
     * query does not select the payload, and `opsExceptionsResponse.parse`
     * strips anything the shape does not name - so adding a payload column to
     * the row still cannot reach the wire. This assertion covers the second
     * guard; the first is asserted on the row itself in packages/db. */
    expect(res.body).not.toContain('+2348120000001');
    expect(res.body).not.toContain('a merchant said something private');
  });

  it('works one exception and takes it out of the list and the count', async () => {
    const flagged = await record('evt.api.worked');
    await events.markProcessed(db, flagged, 'foreign_reference');

    const done = await resolveException(flagged, { resolution: 'not our merchant' }, operator);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ resolved: true });

    expect((await exceptions('', operator)).json()).toEqual({ stuck: [], flagged: [] });

    const healthNow = (await health(operator)).json() as { paystack: { flagged: number } };
    expect(healthNow.paystack.flagged).toBe(0);
  });

  it('refuses a resolution with nothing said, and one already worked', async () => {
    const flagged = await record('evt.api.refusals');
    await events.markProcessed(db, flagged, 'unknown_reference');

    expect((await resolveException(flagged, { resolution: 'no' }, operator)).statusCode).toBe(400);
    expect(
      (await resolveException('not-a-uuid', { resolution: 'fine' }, operator)).statusCode,
    ).toBe(400);

    await resolveException(flagged, { resolution: 'handled by hand' }, operator);
    /* A second operator arriving late is TOLD, rather than quietly
     * overwriting the decision the first one recorded. */
    expect(
      (await resolveException(flagged, { resolution: 'handled again' }, operator)).statusCode,
    ).toBe(404);
  });
});

/**
 * Spec §31's invariants as live probes (S1, PR-104): zero forever on a
 * healthy estate, and the first nonzero carries the business id.
 */
describe('financial integrity probes', () => {
  const probe = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/v1/ops/financial-integrity', headers });

  async function merchant(phone: string): Promise<string> {
    const user = await identity.upsertUserByPhone(db, phone);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Probe Shop',
      businessType: null,
      ownerUserId: user.id,
    });
    return business.id;
  }

  async function saleFor(businessId: string, paidK: number, totalK = 50_000) {
    const customer = await customersRepo.createCustomerWithIdentities(db, businessId, 'CHI', []);
    return withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
        customerToken: 'CHI',
        items: [{ name: 'wig', quantity: 1, unitPriceK: totalK }],
        subtotalK: totalK,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK,
        paidK,
        balanceDueK: totalK - paidK,
        method: 'cash',
        sourceType: 'chat',
        sourceId: `probe-${paidK}-${totalK}`,
        actor: 'owner',
      }),
    );
  }

  it('is shut without the operator secret', async () => {
    expect((await probe()).statusCode).toBe(401);
  });

  it('answers all zero over a clean estate, every business scanned', async () => {
    const businessId = await merchant('+2348030000211');
    /* A properly paid sale: the invoice, the payment AND the allocation,
     * which is exactly what invariant 3 demands to see. */
    await saleFor(businessId, 50_000);

    const body = await probe({ 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) => r.json());
    expect(body.scanned).toBe(1);
    expect(body.estateComplete).toBe(true);
    expect(body.totals).toEqual({
      unbalancedJournals: 0,
      paidWithoutSettlement: 0,
      settlementDrift: 0,
      deadOutboxEvents: 0,
      undispatchedOutbox: 0,
    });
    expect(body.violations).toEqual([]);
  });

  it('surfaces a paid invoice with no money trail, by id and count only', async () => {
    const clean = await merchant('+2348030000212');
    await saleFor(clean, 50_000);
    const broken = await merchant('+2348030000213');
    await saleFor(broken, 0);
    /* The violation no constraint prevents: a status that says paid with
     * no allocation and no applied credit behind it. Written as the owner
     * because the application has no path that can do this - which is the
     * point of watching for it. */
    await ownerDb.execute(sql`
      UPDATE invoices SET status = 'paid'
      WHERE business_id = ${broken}::uuid
    `);

    const body = await probe({ 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) => r.json());
    expect(body.totals.paidWithoutSettlement).toBe(1);
    expect(body.violations).toEqual([{ businessId: broken, paidWithoutSettlement: 1 }]);
  });

  it('keeps a dead outbox announcement visible, with its age', async () => {
    const businessId = await merchant('+2348030000214');
    await ownerDb.execute(sql`
      INSERT INTO outbox_events (business_id, type, payload, occurred_at, attempts, max_attempts)
      VALUES (${businessId}::uuid, 'sale.recorded', '{}'::jsonb,
              now() - interval '90 minutes', 8, 8)
    `);

    const body = await probe({ 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) => r.json());
    expect(body.totals.deadOutboxEvents).toBe(1);
    expect(body.totals.undispatchedOutbox).toBe(1);
    expect(body.oldestUndispatchedMinutes).toBeGreaterThanOrEqual(89);
    expect(body.violations).toEqual([{ businessId, deadOutboxEvents: 1 }]);
  });
});
