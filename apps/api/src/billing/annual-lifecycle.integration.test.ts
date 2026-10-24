/**
 * A yearly subscription through grace, expiry, reactivation and refund, against
 * real PostgreSQL (OWN-40, G-110 slice 3).
 *
 * Slice 1 and 2 proved buying, renewing and switching. This file proves the
 * unhappy half of a year: a renewal nobody pays, the seven days after it, the
 * cut-off, coming back, and money returned. The rules under test:
 *   - the grace window is seven days on a yearly cycle, not a longer one because
 *     the cycle was long;
 *   - an expired yearly merchant keeps their records and reactivates by paying;
 *   - a refund returns money and leaves the year the merchant paid for;
 *   - a yearly payment, refunded or not, never enters the merchant's books.
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
  settleRepo,
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
import { sweepGracePeriods } from './grace-sweep.js';
import { StubSender } from '../channels/sender.stub.js';
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

const billing = () =>
  new BillingService({ ...config, paystackPlatformConfirmed: true, annualBillingSales: true }, db);

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

const FX = 1_450;
const sweepDeps = (sender: StubSender) => ({ workerDb, appDb: db, sender, fxNairaPerUsd: FX });

/** An annual merchant whose year ended a day ago and whose renewal the sweep has raised. */
async function unpaidYear() {
  const { businessId, auth } = await onboard();
  const start = justEndedYear();
  await putOnPlan(businessId, 'chat', 'annual', start);
  await sweepRenewals({ workerDb, appDb: db, config });
  const [charge] = await chargesOf(businessId);
  return { businessId, auth, charge: charge! };
}

describe('a yearly renewal nobody pays', () => {
  it('raises a yearly charge and starts the same seven-day grace a monthly one gets', async () => {
    const { businessId, auth, charge } = await unpaidYear();
    expect(charge).toMatchObject({ kind: 'renewal', status: 'pending', amountK: CHAT_ANNUAL });
    expect(charge.billingInterval).toBe('annual');

    const sub = await subOf(businessId);
    expect(sub?.plan).toBe('chat');
    const overview = await overviewOf(auth);
    expect(overview.status.state).toBe('grace');
    if (overview.status.state !== 'grace') throw new Error('not in grace');
    const days =
      (new Date(overview.status.endsAt).getTime() - sub!.paymentFailedAt!.getTime()) / DAY;
    expect(days).toBe(7);
  });

  it('keeps paid features through grace, and cuts them off on day seven without deleting anything', async () => {
    const { businessId } = await unpaidYear();
    const failedAt = (await subOf(businessId))!.paymentFailedAt!;
    const sender = new StubSender();

    expect(
      await sweepGracePeriods(sweepDeps(sender), new Date(failedAt.getTime() + 6 * DAY)),
    ).toMatchObject({
      expired: 0,
    });
    expect((await subOf(businessId))?.plan).toBe('chat');

    const end = await sweepGracePeriods(sweepDeps(sender), new Date(failedAt.getTime() + 7 * DAY));
    expect(end.expired).toBe(1);
    const sub = await subOf(businessId);
    expect(sub?.plan).toBe('expired');

    // The unpaid year is still payable and nothing the merchant recorded went anywhere.
    expect((await chargesOf(businessId))[0]).toMatchObject({
      status: 'pending',
      amountK: CHAT_ANNUAL,
    });
    expect(
      await withBusiness(db, businessId, (tx) => issueRepo.ledgerEntriesFor(tx, businessId)),
    ).toHaveLength(0);
  });

  it('paying in grace restores the plan for a full year, once', async () => {
    const { businessId, auth, charge } = await unpaidYear();
    const paidAt = new Date();
    expect(await pay(businessId, charge.reference, paidAt)).toBe('applied');
    expect(await pay(businessId, charge.reference, new Date(paidAt.getTime() + 1000))).toBe(
      'already_settled',
    );

    const sub = await subOf(businessId);
    expect(sub).toMatchObject({ plan: 'chat', billingInterval: 'annual', paymentFailedAt: null });
    const days = (sub!.planExpiresAt!.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(300);
    expect((await overviewOf(auth)).status.state).toBe('active');
  });

  it('reactivates an expired yearly merchant with a new yearly purchase, and a late payment on the old renewal never applies', async () => {
    const { businessId, charge } = await unpaidYear();
    const failedAt = (await subOf(businessId))!.paymentFailedAt!;
    await sweepGracePeriods(sweepDeps(new StubSender()), new Date(failedAt.getTime() + 8 * DAY));
    expect((await subOf(businessId))?.plan).toBe('expired');

    // The cut-off is a newer decision: money for the old renewal is kept as truth, the plan is not rewritten (OWN-29).
    expect(await pay(businessId, charge.reference, new Date())).toBe('superseded');
    expect((await subOf(businessId))?.plan).toBe('expired');

    const now = new Date();
    const answer = await billing().changePlan(businessId, 'chat', now, 'annual');
    if (answer.state !== 'payment_required') throw new Error(`got ${answer.state}`);
    expect(answer.amountK).toBe(CHAT_ANNUAL);
    expect(await pay(businessId, answer.reference, now)).toBe('applied');
    expect(await pay(businessId, answer.reference, now)).toBe('already_settled');

    const sub = await subOf(businessId);
    expect(sub).toMatchObject({ plan: 'chat', billingInterval: 'annual', paymentFailedAt: null });
    expect((sub!.planExpiresAt!.getTime() - now.getTime()) / DAY).toBeGreaterThan(363);
  });
});

describe('money returned on a yearly charge', () => {
  async function paidYear() {
    const { businessId } = await onboard();
    const now = new Date('2026-11-02T09:00:00Z');
    const answer = await billing().changePlan(businessId, 'chat', now, 'annual');
    if (answer.state !== 'payment_required') throw new Error(`got ${answer.state}`);
    await pay(businessId, answer.reference, now);
    return { businessId, reference: answer.reference, now };
  }

  const refund = (businessId: string, reference: string, amountK: number) =>
    withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.refundCharge(tx, reference, amountK, new Date(), {
        actor: 'operator:test',
        reason: 'goodwill',
      }),
    );

  it('a partial refund leaves the charge paid and the year untouched', async () => {
    const { businessId, reference } = await paidYear();
    const before = await subOf(businessId);

    const charge = await refund(businessId, reference, 1_000_00);
    expect(charge?.status).toBe('paid');
    expect(charge?.refundedAmountK).toBe(1_000_00);
    expect(await subOf(businessId)).toMatchObject({
      plan: 'chat',
      billingInterval: 'annual',
      planExpiresAt: before!.planExpiresAt,
    });
  });

  it('a full refund marks the charge refunded; the plan is a separate decision and stays', async () => {
    const { businessId, reference } = await paidYear();
    const before = await subOf(businessId);

    const charge = await refund(businessId, reference, CHAT_ANNUAL);
    expect(charge?.status).toBe('refunded');
    expect(await subOf(businessId)).toMatchObject({
      plan: 'chat',
      planExpiresAt: before!.planExpiresAt,
    });
  });

  it('refuses to return more than the year cost, and repeats add up rather than double', async () => {
    const { businessId, reference } = await paidYear();
    expect(await refund(businessId, reference, CHAT_ANNUAL - 100)).not.toBeNull();
    expect(await refund(businessId, reference, 101)).toBeNull();
    const [charge] = await chargesOf(businessId);
    expect(charge?.refundedAmountK).toBe(CHAT_ANNUAL - 100);
  });

  it('a yearly payment and its refund never enter the merchant books', async () => {
    const { businessId, reference } = await paidYear();
    await refund(businessId, reference, CHAT_ANNUAL);
    expect(await withBusiness(db, businessId, (tx) => settleRepo.paymentCount(tx))).toBe(0);
    expect(await withBusiness(db, businessId, (tx) => settleRepo.receiptCount(tx))).toBe(0);
    expect(
      await withBusiness(db, businessId, (tx) => issueRepo.ledgerEntriesFor(tx, businessId)),
    ).toHaveLength(0);
  });
});
