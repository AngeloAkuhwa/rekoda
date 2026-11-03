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
// The annual billing suite (OWN-40, G-110). Split by concern; the rest of this suite is in annual-
// billing-switching.integration.test.ts.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addInterval, annualPriceK, PLAN_PRICES_K } from '@rekoda/core';
import { billingOverviewResponse } from '@rekoda/contracts';
import { createDb, issueRepo, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
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
let config: ApiConfig;
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
  config = app.get<ApiConfig>(CONFIG);
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await closeWorker?.();
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
const billing = () =>
  new BillingService(
    {
      ...config,
      paystackSecretKey: 'sk_test_x',
      paystackPlatformConfirmed: true,
      annualBillingSales: true,
    },
    db,
  );

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

describe('annual billing is off until it is switched on', () => {
  const off = () =>
    new BillingService(
      {
        ...config,
        paystackSecretKey: 'sk_test_x',
        paystackPlatformConfirmed: true,
        annualBillingSales: false,
      },
      db,
    );

  it('refuses a yearly quote, purchase and switch, opens nothing, and still allows monthly', async () => {
    const { businessId } = await onboard();
    await expect(off().quote(businessId, 'chat', new Date(), 'annual')).rejects.toThrow(/annual/);
    await expect(off().changePlan(businessId, 'chat', new Date(), 'annual')).rejects.toThrow(
      /annual/,
    );
    expect(await chargesOf(businessId)).toHaveLength(0);

    const monthly = await off().changePlan(businessId, 'chat', new Date(), 'monthly');
    expect(monthly.state).toBe('payment_required');

    await putOnPlan(businessId, 'chat', 'monthly', new Date(Date.now() - 10 * DAY));
    await expect(off().switchInterval(businessId, 'annual')).rejects.toThrow(/annual/);
    expect((await off().switchInterval(businessId, 'monthly')).state).toBe('unchanged');
  });
});

describe('the annual switch and the catalogue', () => {
  it('lets a subscriber already on a year change plan with the flag off, and refuses a year without catalogue prices', async () => {
    const { businessId } = await onboard();
    await putOnPlan(businessId, 'complete', 'annual', new Date(Date.now() - 10 * DAY));
    const off = new BillingService(
      {
        ...config,
        paystackSecretKey: 'sk_test_x',
        paystackPlatformConfirmed: true,
        annualBillingSales: false,
      },
      db,
    );
    // The subscriber keeps their own interval; asking for annual again is not a new sale.
    expect((await off.quote(businessId, 'chat', new Date(), 'annual')).supportReview).not.toBe(
      undefined,
    );
    expect((await off.changePlan(businessId, 'chat', new Date(), 'annual')).state).toBe(
      'scheduled',
    );

    // Switching away from the year and changing their mind needs no new annual sale.
    expect((await off.switchInterval(businessId, 'monthly')).state).toBe('scheduled');
    expect((await off.switchInterval(businessId, 'annual')).state).toBe('undone');

    const trial = (await onboard()).businessId;
    const noCatalogue = new BillingService(
      {
        ...config,
        paystackSecretKey: 'sk_test_x',
        paystackPlatformConfirmed: true,
        annualBillingSales: true,
        planCatalogueReads: false,
      },
      db,
    );
    await expect(noCatalogue.changePlan(trial, 'chat', new Date(), 'annual')).rejects.toThrow(
      /annual/,
    );
  });
});

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

  it('the overview marks a plan charge a newer subscription decision has made stale, before any sweep stamps it', async () => {
    const { businessId, auth } = await onboard();
    const now = new Date('2026-11-02T09:00:00Z');
    const waiting = await billing().changePlan(businessId, 'chat', now, 'monthly');
    if (waiting.state !== 'payment_required') throw new Error('expected a payment link');

    // Not retired: nothing has stamped superseded_at on it.
    expect(
      (await chargesOf(businessId)).find((c) => c.reference === waiting.reference)?.supersededAt,
    ).toBeNull();
    expect(
      (await overviewOf(auth)).charges.find((c) => c.reference === waiting.reference)?.superseded,
    ).toBe(false);

    // The subscription is decided after the charge was opened (a settled purchase or an operator move
    // stamps plan_decided_at). Checkout then refuses this charge as superseded, so the page must not offer it.
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE businesses SET plan_decided_at = clock_timestamp() + interval '1 second' WHERE id = ${businessId}::uuid`,
      ),
    );
    expect(
      (await overviewOf(auth)).charges.find((c) => c.reference === waiting.reference)?.superseded,
    ).toBe(true);
  });

  it('a merchant who changes their mind the same day gets the charge for the interval they chose', async () => {
    const { businessId, auth } = await onboard();
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
    // The overview tells the page which one is replaced, so it never offers the dead link for payment.
    const shown = await overviewOf(auth);
    expect(shown.charges.find((c) => c.reference === annual.reference)?.superseded).toBe(true);
    expect(shown.charges.find((c) => c.reference === monthly.reference)?.superseded).toBe(false);

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
