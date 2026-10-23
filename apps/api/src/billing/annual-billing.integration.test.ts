/**
 * Annual billing, end to end against real PostgreSQL (OWN-40, G-110).
 *
 * The owner ruled that Rekoda launches with monthly AND annual billing, annual
 * being ten months' price for twelve months of service, with these limits:
 *   - the merchant keeps whatever they have paid for (a switch waits for renewal);
 *   - no credit, refund or proration is invented (an upgrade inside an annual
 *     cycle goes to support review, exactly as a non-standard cycle already does);
 *   - monthly allowances still reset monthly, and are not handed out a year up front;
 *   - a subscription payment is Rekoda's revenue, never an entry in the merchant's books.
 *
 * Each test reads the stored subscription and the charge rows, not only an HTTP status.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addInterval, annualPriceK, PLAN_PRICES_K } from '@rekoda/core';
import { billingOverviewResponse } from '@rekoda/contracts';
import {
  billingRepo,
  createDb,
  issueRepo,
  planCatalogueRepo,
  sql,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import {
  migrate,
  requireUrls,
  resetPlanCatalogue,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
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
let closeDb: () => Promise<void>;
let closeWorker: () => Promise<void>;
let closeOwner: () => Promise<void>;

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
  await resetPlanCatalogue(urls);
});

const DAY = 86_400_000;
const CHAT_MONTHLY = PLAN_PRICES_K.chat;
const CHAT_ANNUAL = annualPriceK(CHAT_MONTHLY);

function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

let phoneSeq = 0;
async function onboard() {
  phoneSeq += 1;
  const phone = `+23481771${String(phoneSeq).padStart(5, '0')}`;
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

/** The Lagos day of the month a cycle started on: the anchor a renewal keeps. */
const anchorOf = (start: Date) => new Date(start.getTime() + 3_600_000).getUTCDate();
/** An annual cycle whose year ended about a day ago, so the sweep (which prices at the real clock) finds it due. */
const justEndedYear = () => new Date(Date.now() - 366 * DAY);
/** A monthly cycle whose month ended a few days ago. */
const justEndedMonth = () => new Date(Date.now() - 35 * DAY);

const billing = () => new BillingService({ ...config, paystackPlatformConfirmed: true }, db);

const overviewOf = async (auth: Record<string, string>) =>
  billingOverviewResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/billing', headers: auth })).json(),
  );

const subOf = (businessId: string) =>
  withBusiness(db, businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId));

const chargesOf = async (businessId: string) =>
  (await withBusiness(db, businessId, (tx) => subscriptionsRepo.chargesFor(tx, businessId))).rows;

/** Settle a charge the way the webhook job does. */
const pay = (businessId: string, reference: string, when: Date) =>
  withBusiness(db, businessId, (tx) =>
    applySettledCharge(tx, {
      businessId,
      reference,
      providerReference: `ps_${reference}`,
      when,
      config,
    }),
  );

/** A paid cycle on `plan` for `interval`, starting at `start`. */
async function putOnPlan(
  businessId: string,
  plan: string,
  interval: 'monthly' | 'annual',
  start: Date,
) {
  const anchor = new Date(start.getTime() + 3_600_000).getUTCDate();
  await withBusiness(db, businessId, async (tx) => {
    await subscriptionsRepo.applyCycle(tx, businessId, {
      plan,
      cycleStartedAt: start,
      renewsAt: addInterval(start, interval, anchor),
      anchorDay: anchor,
      billingInterval: interval,
    });
    /* A provider-bought cycle, so a proration question is decided by its length alone. */
    await tx.execute(
      sql`UPDATE businesses SET subscription_origin = 'provider' WHERE id = ${businessId}::uuid`,
    );
  });
}

describe('buying a year', () => {
  it('quotes a first annual purchase at ten months and a year of service', async () => {
    const { businessId } = await onboard();
    const now = new Date('2026-11-02T09:00:00Z');

    const monthly = await billing().quote(businessId, 'chat', now, 'monthly');
    const annual = await billing().quote(businessId, 'chat', now, 'annual');

    expect(monthly).toMatchObject({ kind: 'first_purchase', amountK: CHAT_MONTHLY });
    expect(monthly.interval).toBe('monthly');
    expect(annual).toMatchObject({ kind: 'first_purchase', amountK: CHAT_ANNUAL });
    expect(annual.interval).toBe('annual');
    expect(annual.amountK).toBe(CHAT_MONTHLY * 10);
    expect(annual.renewsAt).toBe(addInterval(now, 'annual').toISOString());
  });

  it('opens an annual charge, and paying it gives twelve months, once', async () => {
    const { businessId, auth } = await onboard();
    const now = new Date('2026-11-02T09:00:00Z');

    const answer = await billing().changePlan(businessId, 'chat', now, 'annual');
    if (answer.state !== 'payment_required') throw new Error(`got ${answer.state}`);
    expect(answer.amountK).toBe(CHAT_ANNUAL);

    const [charge] = await chargesOf(businessId);
    expect(charge).toMatchObject({
      kind: 'first_purchase',
      status: 'pending',
      amountK: CHAT_ANNUAL,
    });
    expect(charge?.billingInterval).toBe('annual');

    expect(await pay(businessId, answer.reference, now)).toBe('applied');
    const sub = await subOf(businessId);
    expect(sub?.plan).toBe('chat');
    expect(sub?.billingInterval).toBe('annual');
    const anchor = sub!.renewalAnchorDay!;
    expect(sub?.planExpiresAt?.toISOString()).toBe(
      addInterval(now, 'annual', anchor).toISOString(),
    );
    const days = (sub!.planExpiresAt!.getTime() - now.getTime()) / DAY;
    expect(days).toBeGreaterThanOrEqual(364);
    expect(days).toBeLessThanOrEqual(366);

    // The webhook delivered twice does not buy a second year.
    expect(await pay(businessId, answer.reference, new Date(now.getTime() + 60_000))).toBe(
      'already_settled',
    );
    expect((await subOf(businessId))?.planExpiresAt?.toISOString()).toBe(
      sub?.planExpiresAt?.toISOString(),
    );

    const overview = await overviewOf(auth);
    expect(overview.interval).toBe('annual');
    expect(overview.annualPriceK).toBe(CHAT_ANNUAL);
    expect(overview.charges[0]?.interval).toBe('annual');
  });

  it('a merchant who changes their mind the same day gets the charge for the interval they chose', async () => {
    const { businessId } = await onboard();
    const now = new Date('2026-11-02T09:00:00Z');

    const annual = await billing().changePlan(businessId, 'chat', now, 'annual');
    const monthly = await billing().changePlan(businessId, 'chat', now, 'monthly');
    if (annual.state !== 'payment_required' || monthly.state !== 'payment_required') {
      throw new Error('expected two payment links');
    }
    expect(monthly.reference).not.toBe(annual.reference);
    expect(monthly.amountK).toBe(CHAT_MONTHLY);

    // Paying the abandoned annual link must not silently sell a year for the monthly decision.
    const rows = await chargesOf(businessId);
    expect(rows.find((c) => c.reference === annual.reference)?.supersededAt).not.toBeNull();
    expect(rows.find((c) => c.reference === monthly.reference)?.supersededAt).toBeNull();

    // Asking for the annual one again hands back a payable annual charge.
    const again = await billing().changePlan(businessId, 'chat', now, 'annual');
    if (again.state !== 'payment_required') throw new Error('expected a payment link');
    expect(again.amountK).toBe(CHAT_ANNUAL);
  });

  it('writes nothing into the merchant books: a year of Rekoda is Rekoda revenue', async () => {
    const { businessId } = await onboard();
    const now = new Date('2026-11-02T09:00:00Z');
    const answer = await billing().changePlan(businessId, 'chat', now, 'annual');
    if (answer.state !== 'payment_required') throw new Error('expected a payment link');
    await pay(businessId, answer.reference, now);

    const ledger = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(ledger).toHaveLength(0);
  });

  it('does not hand out twelve months of allowance up front', async () => {
    const monthly = await onboard();
    const annual = await onboard();
    const start = new Date();
    await putOnPlan(monthly.businessId, 'chat', 'monthly', start);
    await putOnPlan(annual.businessId, 'chat', 'annual', start);

    const m = await overviewOf(monthly.auth);
    const a = await overviewOf(annual.auth);
    expect(a.units.map((u) => [u.unit, u.allowance])).toEqual(
      m.units.map((u) => [u.unit, u.allowance]),
    );
  });
});

describe('renewing a year', () => {
  it('raises the annual price and buys another full year when it is paid', async () => {
    const { businessId } = await onboard();
    const start = justEndedYear();
    const anchor = anchorOf(start);
    await putOnPlan(businessId, 'chat', 'annual', start);
    const renewsAt = addInterval(start, 'annual', anchor);

    const raised = await sweepRenewals({ workerDb, appDb: db, config });
    expect(raised).toEqual({ raised: 1, skipped: 0 });

    const [charge] = await chargesOf(businessId);
    expect(charge).toMatchObject({ kind: 'renewal', amountK: CHAT_ANNUAL, status: 'pending' });
    expect(charge?.billingInterval).toBe('annual');
    expect(charge?.periodStart?.toISOString()).toBe(renewsAt.toISOString());
    expect(charge?.periodEnd?.toISOString()).toBe(
      addInterval(renewsAt, 'annual', anchor).toISOString(),
    );

    expect(await pay(businessId, charge!.reference, new Date())).toBe('applied');
    const sub = await subOf(businessId);
    expect(sub?.billingInterval).toBe('annual');
    expect(sub?.cycleStartedAt?.toISOString()).toBe(renewsAt.toISOString());
    expect(sub?.planExpiresAt?.toISOString()).toBe(
      addInterval(renewsAt, 'annual', anchor).toISOString(),
    );
    expect(sub?.paymentFailedAt).toBeNull();
  });

  it('keeps the 29 February anchor across leap and common years', async () => {
    const { businessId } = await onboard();
    const start = new Date('2028-02-29T09:00:00Z');
    await putOnPlan(businessId, 'chat', 'annual', start);
    const sub = await subOf(businessId);
    expect(sub?.renewalAnchorDay).toBe(29);
    expect(sub?.planExpiresAt?.toISOString()).toBe('2029-02-28T09:00:00.000Z');
  });
});

describe('switching between monthly and annual', () => {
  it('annual to monthly waits for the renewal: the year already paid is kept whole', async () => {
    const { businessId } = await onboard();
    const start = justEndedYear();
    const anchor = anchorOf(start);
    await putOnPlan(businessId, 'chat', 'annual', start);
    const renewsAt = addInterval(start, 'annual', anchor);

    const answer = await billing().switchInterval(
      businessId,
      'monthly',
      new Date(renewsAt.getTime() - 100 * DAY),
    );
    expect(answer).toEqual({
      state: 'scheduled',
      interval: 'monthly',
      effectiveAt: renewsAt.toISOString(),
    });
    const parked = await subOf(businessId);
    expect(parked?.billingInterval).toBe('annual');
    expect(parked?.pendingBillingInterval).toBe('monthly');
    expect(parked?.planExpiresAt?.toISOString()).toBe(renewsAt.toISOString());

    await sweepRenewals({ workerDb, appDb: db, config });
    const [charge] = await chargesOf(businessId);
    expect(charge).toMatchObject({ kind: 'renewal', amountK: CHAT_MONTHLY });
    expect(charge?.billingInterval).toBe('monthly');
    expect(charge?.periodEnd?.toISOString()).toBe(
      addInterval(renewsAt, 'monthly', anchor).toISOString(),
    );

    await pay(businessId, charge!.reference, new Date());
    const after = await subOf(businessId);
    expect(after?.billingInterval).toBe('monthly');
    expect(after?.pendingBillingInterval).toBeNull();
    expect(after?.planExpiresAt?.toISOString()).toBe(
      addInterval(renewsAt, 'monthly', anchor).toISOString(),
    );
  });

  it('monthly to annual waits for the renewal, then bills ten months for twelve', async () => {
    const { businessId } = await onboard();
    const start = justEndedMonth();
    const anchor = anchorOf(start);
    await putOnPlan(businessId, 'chat', 'monthly', start);
    const renewsAt = addInterval(start, 'monthly', anchor);

    const answer = await billing().switchInterval(
      businessId,
      'annual',
      new Date(renewsAt.getTime() - 10 * DAY),
    );
    expect(answer.state).toBe('scheduled');
    expect((await subOf(businessId))?.billingInterval).toBe('monthly');

    await sweepRenewals({ workerDb, appDb: db, config });
    const [charge] = await chargesOf(businessId);
    expect(charge).toMatchObject({ kind: 'renewal', amountK: CHAT_ANNUAL });
    expect(charge?.billingInterval).toBe('annual');

    await pay(businessId, charge!.reference, new Date());
    const after = await subOf(businessId);
    expect(after?.billingInterval).toBe('annual');
    expect(after?.planExpiresAt?.toISOString()).toBe(
      addInterval(renewsAt, 'annual', anchor).toISOString(),
    );
  });

  it('choosing the interval already in force undoes a switch that was waiting', async () => {
    const { businessId } = await onboard();
    await putOnPlan(businessId, 'chat', 'monthly', new Date());
    await billing().switchInterval(businessId, 'annual');
    expect((await subOf(businessId))?.pendingBillingInterval).toBe('annual');

    expect(await billing().switchInterval(businessId, 'monthly')).toEqual({
      state: 'undone',
      interval: 'monthly',
    });
    expect((await subOf(businessId))?.pendingBillingInterval).toBeNull();
    expect(await billing().switchInterval(businessId, 'monthly')).toEqual({
      state: 'unchanged',
      interval: 'monthly',
    });
  });

  it('a renewal already raised before the switch is retired and re-raised at the new price', async () => {
    const { businessId } = await onboard();
    const start = justEndedMonth();
    await putOnPlan(businessId, 'chat', 'monthly', start);

    await sweepRenewals({ workerDb, appDb: db, config });
    const [first] = await chargesOf(businessId);
    expect(first?.amountK).toBe(CHAT_MONTHLY);

    await billing().switchInterval(businessId, 'annual');
    await sweepRenewals({ workerDb, appDb: db, config });

    const rows = await chargesOf(businessId);
    const live = rows.filter((c) => c.status === 'pending' && c.supersededAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ amountK: CHAT_ANNUAL, kind: 'renewal' });
    expect(live[0]?.billingInterval).toBe('annual');
    expect(rows.find((c) => c.reference === first!.reference)?.supersededAt).not.toBeNull();
  });

  it('a trial or lapsed merchant has no cycle to switch', async () => {
    const { businessId } = await onboard();
    expect(await billing().switchInterval(businessId, 'annual')).toEqual({
      state: 'unavailable',
      reason: 'no_cycle',
    });
  });
});

describe('changing plan inside an annual cycle', () => {
  it('sends an upgrade to support review: no proration is invented and nothing is opened', async () => {
    const { businessId } = await onboard();
    const start = new Date(Date.now() - 100 * DAY);
    await putOnPlan(businessId, 'chat', 'annual', start);
    const now = new Date();

    const quote = await billing().quote(businessId, 'complete', now);
    expect(quote).toMatchObject({ kind: 'upgrade', supportReview: true, amountK: 0 });

    const answer = await billing().changePlan(businessId, 'complete', now);
    expect(answer).toEqual({ state: 'unavailable', reason: 'support_review' });
    expect(await chargesOf(businessId)).toHaveLength(0);
    expect((await subOf(businessId))?.plan).toBe('chat');
  });

  it('a downgrade waits for the renewal and renews on the same interval at the cheaper annual price', async () => {
    const { businessId } = await onboard();
    const start = justEndedYear();
    const anchor = anchorOf(start);
    await putOnPlan(businessId, 'complete', 'annual', start);
    const renewsAt = addInterval(start, 'annual', anchor);

    const answer = await billing().changePlan(businessId, 'chat', new Date());
    expect(answer).toEqual({
      state: 'scheduled',
      plan: 'chat',
      effectiveAt: renewsAt.toISOString(),
    });
    expect((await subOf(businessId))?.plan).toBe('complete');

    await sweepRenewals({ workerDb, appDb: db, config });
    const [charge] = await chargesOf(businessId);
    expect(charge).toMatchObject({ kind: 'renewal', plan: 'chat', amountK: CHAT_ANNUAL });
    expect(charge?.billingInterval).toBe('annual');
    await pay(businessId, charge!.reference, new Date());
    const after = await subOf(businessId);
    expect(after).toMatchObject({ plan: 'chat', billingInterval: 'annual', pendingPlan: null });
  });

  it('an operator re-posting the identical annual cycle keeps it annual and provider-bought', async () => {
    const { businessId } = await onboard();
    const start = new Date(Date.now() - 100 * DAY);
    await putOnPlan(businessId, 'chat', 'annual', start);
    const before = await subOf(businessId);

    await billingRepo.setPlan(db, {
      businessId,
      plan: 'chat',
      expiresAt: before!.planExpiresAt!,
      actor: 'operator:test',
    });
    const after = await subOf(businessId);
    expect(after?.planExpiresAt?.toISOString()).toBe(before?.planExpiresAt?.toISOString());
    expect(after?.origin).toBe('provider');
    // The cycle is still a year long, so the next renewal must still bill a year.
    expect(after?.billingInterval).toBe('annual');
  });

  it('an operator move resets the interval to monthly: an arrangement is not a provider year', async () => {
    const { businessId } = await onboard();
    await putOnPlan(businessId, 'chat', 'annual', new Date());
    await billing().switchInterval(businessId, 'monthly');

    await billingRepo.setPlan(db, {
      businessId,
      plan: 'integrate',
      expiresAt: new Date(Date.now() + 30 * DAY),
      actor: 'operator:test',
    });
    const sub = await subOf(businessId);
    expect(sub?.plan).toBe('integrate');
    expect(sub?.billingInterval).toBe('monthly');
    expect(sub?.pendingBillingInterval).toBeNull();
  });
});

describe('review of #340: three ways a year could be mispriced or misapplied', () => {
  it('a catalogue version with only a monthly price still sells a year at ten months, never at zero', async () => {
    const { businessId } = await onboard();
    /* A version published without an annual row is legal; the approved rule is monthly x 10. */
    await planCatalogueRepo.publishPlanVersion(ownerDb, {
      planId: 'chat',
      name: 'Rekoda Chat',
      seats: 1,
      effectiveFrom: new Date(Date.now() - 40 * DAY),
      entitlements: ['REKODA_CHAT'],
      allowances: { AI_ACTIONS: 300, DOCUMENT_GENERATION: 100 },
      prices: [{ currency: 'NGN', billingInterval: 'monthly', amountMinor: 1_490_000 }],
    });

    const quote = await billing().quote(businessId, 'chat', new Date(), 'annual');
    expect(quote).toMatchObject({ kind: 'first_purchase', amountK: 14_900_000 });

    /* A merchant pinned to that version who switches to yearly is renewed at a payable price. */
    const other = await onboard();
    await putOnPlan(other.businessId, 'chat', 'monthly', new Date(Date.now() - 35 * DAY));
    await billing().switchInterval(other.businessId, 'annual');
    await sweepRenewals({ workerDb, appDb: db, config });
    const [renewal] = await chargesOf(other.businessId);
    expect(renewal).toMatchObject({ kind: 'renewal', amountK: 14_900_000 });
    expect(renewal?.billingInterval).toBe('annual');
  });

  it('undoing a cancellation does not roll back an interval switch chosen meanwhile', async () => {
    const { businessId } = await onboard();
    await putOnPlan(businessId, 'chat', 'monthly', new Date(Date.now() - 35 * DAY));

    /* A monthly renewal is raised for the cycle that just ended... */
    await sweepRenewals({ workerDb, appDb: db, config });
    const [monthly] = await chargesOf(businessId);
    expect(monthly).toMatchObject({ kind: 'renewal', amountK: CHAT_MONTHLY });

    /* ...the owner cancels, then switches to yearly, then undoes the cancellation. */
    await billing().cancelPlan(businessId);
    await billing().switchInterval(businessId, 'annual');
    await billing().changePlan(businessId, 'chat');

    /* The yearly choice stands, so the monthly renewal is no longer the one to pay. */
    expect((await subOf(businessId))?.pendingBillingInterval).toBe('annual');
    const stale = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.decidedSince(tx, businessId, monthly!.reference),
    );
    expect(stale).toBe(true);

    /* Paying the old monthly link is recorded but does not start another month or erase the switch. */
    expect(await pay(businessId, monthly!.reference, new Date())).toBe('superseded');
    expect((await subOf(businessId))?.pendingBillingInterval).toBe('annual');

    /* The sweep raises the yearly renewal in its place. */
    await sweepRenewals({ workerDb, appDb: db, config });
    const live = (await chargesOf(businessId)).filter(
      (c) => c.status === 'pending' && c.supersededAt === null && c.kind === 'renewal',
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.billingInterval).toBe('annual');
    expect(live[0]?.amountK).toBe(CHAT_ANNUAL);
  });
});
