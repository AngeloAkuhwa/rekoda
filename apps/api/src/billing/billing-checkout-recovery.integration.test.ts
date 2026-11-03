/**
 * A lost Paystack checkout link is recoverable (G-102, OWN-50).
 *
 * Paystack rejects a reference it has already seen, so a checkout whose link
 * was lost (the response never reached Rekoda, or the merchant closed the tab)
 * cannot be started again under the same reference. Each provider checkout is
 * an attempt with its own provider reference, and the claims pinned here are
 * the ones the owner named: no duplicate charge, no duplicate entitlement, no
 * two live sessions, no assumption that re-initialising a reference is
 * idempotent, and no waiting for the next day. Failure, timeout, concurrent
 * and recovery cases each have a test.
 *
 * `modelPaystackReferences()` makes the stub behave like Paystack about
 * references: one is accepted once, and a created session can be verified.
 */
// The checkout recovery suite. Split by concern; the rest of this suite is in billing-checkout-
// replacement.integration.test.ts, billing-checkout-guards.integration.test.ts.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { attemptReference } from '@rekoda/core';
import type { BillingCheckoutResponse } from '@rekoda/contracts';
import { createDb, identity, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { BillingService } from './billing.service.js';
import { BillingCheckoutService } from './billing-checkout.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const testKey = (label: string): string =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 6 }));
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = { ...loadConfig(), paystackSecretKey: 'sk_test_x', paystackPlatformConfirmed: true };

  provider = new StubPaymentProvider();
  originalInitialize = provider.initializeTransaction.bind(provider);
  originalVerify = provider.verifyTransaction.bind(provider);
});

afterAll(async () => {
  await closeApp?.();
});

/** The stub's own initialise, kept so a test that wraps it cannot leak into the next. */
let originalInitialize: StubPaymentProvider['initializeTransaction'];
let originalVerify: StubPaymentProvider['verifyTransaction'];

beforeEach(async () => {
  await truncateAll(urls);
  provider.reset();
  provider.initializeTransaction = originalInitialize;
  provider.verifyTransaction = originalVerify;
  provider.modelPaystackReferences();
});

const plans = () => new BillingService(config, appDb);
const checkouts = () => new BillingCheckoutService(config, appDb, provider);

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481730${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Recovery Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const EMAIL = 'ada@shop.example.ng';

/** A first purchase of Chat: one pending charge, owed. */
async function pendingCharge(businessId: string): Promise<{ reference: string; amountK: number }> {
  const answer = await plans().changePlan(businessId, 'chat');
  if (answer.state !== 'payment_required') throw new Error('a first purchase should be payable');
  return { reference: answer.reference, amountK: answer.amountK };
}

const ready = (answer: BillingCheckoutResponse) => {
  if (answer.state !== 'ready') throw new Error(`expected a ready checkout, got ${answer.state}`);
  return answer;
};

interface AttemptSummary {
  no: number;
  ref: string;
  status: string;
  url: string | null;
}
const attemptsOf = (businessId: string): Promise<AttemptSummary[]> =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{
      no: number;
      ref: string;
      status: string;
      url: string | null;
    }>(sql`
      SELECT attempt_no AS no, provider_reference AS ref, status, checkout_url AS url
      FROM subscription_charge_attempts WHERE business_id = ${businessId}::uuid
      ORDER BY attempt_no
    `);
    return [...rows].map((r) => ({ no: Number(r.no), ref: r.ref, status: r.status, url: r.url }));
  });

const liveCount = async (businessId: string): Promise<number> =>
  (await attemptsOf(businessId)).filter((a) =>
    ['initializing', 'active', 'ambiguous'].includes(a.status),
  ).length;

const chargeCount = (businessId: string): Promise<number> =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM subscription_charges WHERE business_id = ${businessId}::uuid
    `);
    return Number([...rows][0]!.n);
  });

const ageAttempts = (businessId: string, seconds: number): Promise<void> =>
  withBusiness(appDb, businessId, async (tx) => {
    await tx.execute(sql`
      UPDATE subscription_charge_attempts
      SET created_at = created_at - make_interval(secs => ${seconds}),
          updated_at = updated_at - make_interval(secs => ${seconds})
      WHERE business_id = ${businessId}::uuid
    `);
  });

describe('a checkout whose link was lost', () => {
  it('is recovered when Paystack created the session but the response was lost', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    provider.loseNextInitializeResponse();

    await expect(checkouts().checkout(businessId, reference, EMAIL)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, ref: reference, status: 'ambiguous', url: null },
    ]);

    const second = ready(await checkouts().checkout(businessId, reference, undefined));

    /* A new provider reference, never the consumed one; the same charge and amount. */
    const replacement = attemptReference(reference, 2);
    expect(second.checkoutUrl).toBe(`https://checkout.stub/${replacement}`);
    expect(second.reference).toBe(reference);
    expect(second.amountK).toBe(amountK);
    expect(provider.initialized.map((i) => i.reference)).toEqual([reference, replacement]);
    expect(provider.initialized.every((i) => i.amountK === amountK)).toBe(true);
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'superseded' },
      { no: 2, ref: replacement, status: 'active' },
    ]);
    expect(await chargeCount(businessId)).toBe(1);
    expect(await liveCount(businessId)).toBe(1);
  });

  it('is recovered when the request never reached Paystack at all', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    provider.failNextInitializeWith(new Error('connect ETIMEDOUT'));

    await expect(checkouts().checkout(businessId, reference, EMAIL)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(await attemptsOf(businessId)).toMatchObject([{ no: 1, status: 'ambiguous' }]);

    const second = ready(await checkouts().checkout(businessId, reference, undefined));

    /* Paystack was asked about the old reference first, found nothing, and the
     * replacement still gets its own reference: a reference is never assumed reusable. */
    expect(second.checkoutUrl).toContain(attemptReference(reference, 2));
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'superseded' },
      { no: 2, status: 'active' },
    ]);
  });

  it('creates no second session while Paystack cannot be asked about the first', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    provider.loseNextInitializeResponse();
    await expect(checkouts().checkout(businessId, reference, EMAIL)).rejects.toThrow();
    const sessionsBefore = provider.initialized.length;

    provider.failNextVerifyWith(new Error('503 from Paystack'));
    await expect(checkouts().checkout(businessId, reference, undefined)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(provider.initialized).toHaveLength(sessionsBefore);
    expect(await attemptsOf(businessId)).toMatchObject([{ no: 1, status: 'ambiguous' }]);

    /* And the very next try, with Paystack back, recovers. */
    ready(await checkouts().checkout(businessId, reference, undefined));
    expect(await liveCount(businessId)).toBe(1);
  });

  it('says so, and starts nothing, when the lost session was in fact paid', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    provider.loseNextInitializeResponse();
    await expect(checkouts().checkout(businessId, reference, EMAIL)).rejects.toThrow();

    provider.willVerify(reference, { amountK });
    const answer = await checkouts().checkout(businessId, reference, undefined);

    expect(answer).toEqual({ state: 'unavailable', reason: 'payment_received' });
    expect(provider.initialized).toHaveLength(1);
    expect(await attemptsOf(businessId)).toMatchObject([{ no: 1, status: 'ambiguous' }]);
  });

  it('waits while a payment on the session is under way, and starts nothing', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    provider.loseNextInitializeResponse();
    await expect(checkouts().checkout(businessId, reference, EMAIL)).rejects.toThrow();

    provider.willVerify(reference, { amountK, succeeded: false, providerStatus: 'ongoing' });
    const answer = await checkouts().checkout(businessId, reference, undefined);

    expect(answer).toEqual({ state: 'unavailable', reason: 'payment_in_progress' });
    expect(provider.initialized).toHaveLength(1);
  });

  it('refuses to recover a charge that has been retired, and starts nothing', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    provider.loseNextInitializeResponse();
    await expect(checkouts().checkout(businessId, reference, EMAIL)).rejects.toThrow();

    /* The merchant picks another plan: this charge is retired. */
    await plans().changePlan(businessId, 'integrate');
    const answer = await checkouts().checkout(businessId, reference, undefined);

    expect(answer).toEqual({ state: 'unavailable', reason: 'superseded' });
    expect(provider.initialized).toHaveLength(1);
  });
});

describe('asking for a fresh link', () => {
  it('hands back the stored link when there is nothing wrong with it', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    const first = ready(await checkouts().checkout(businessId, reference, EMAIL));

    const again = ready(await checkouts().checkout(businessId, reference, undefined));

    expect(again.checkoutUrl).toBe(first.checkoutUrl);
    expect(provider.initialized).toHaveLength(1);
    expect(await attemptsOf(businessId)).toHaveLength(1);
  });

  it('replaces an unpaid session on request, and keeps one live attempt', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    ready(await checkouts().checkout(businessId, reference, EMAIL));
    await ageAttempts(businessId, 3600);

    const fresh = ready(
      await checkouts().checkout(businessId, reference, undefined, { restart: true }),
    );

    expect(fresh.checkoutUrl).toBe(`https://checkout.stub/${attemptReference(reference, 2)}`);
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'superseded' },
      { no: 2, status: 'active' },
    ]);
    expect(await liveCount(businessId)).toBe(1);
  });

  it('will not replace a session that has been paid', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    ready(await checkouts().checkout(businessId, reference, EMAIL));
    await ageAttempts(businessId, 3600);

    provider.willVerify(reference, { amountK });
    const answer = await checkouts().checkout(businessId, reference, undefined, { restart: true });

    expect(answer).toEqual({ state: 'unavailable', reason: 'payment_received' });
    expect(provider.initialized).toHaveLength(1);
    expect(await liveCount(businessId)).toBe(1);
  });

  it('ignores a restart that follows a link made moments ago, so a double click replaces nothing', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    const first = ready(await checkouts().checkout(businessId, reference, EMAIL));

    const second = ready(
      await checkouts().checkout(businessId, reference, undefined, { restart: true }),
    );

    expect(second.checkoutUrl).toBe(first.checkoutUrl);
    expect(provider.initialized).toHaveLength(1);
  });
});

describe('requests that race', () => {
  it('starts one session for two tabs that click at once', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);

    const [a, b] = await Promise.all([
      checkouts().checkout(businessId, reference, EMAIL),
      checkouts().checkout(businessId, reference, EMAIL),
    ]);

    /* One session, and both tabs are handed its link. */
    expect(provider.initialized).toHaveLength(1);
    expect(a).toMatchObject({ state: 'ready' });
    expect(b).toEqual(a);
    expect(await liveCount(businessId)).toBe(1);
  });

  it('replaces once, not twice, when two restarts arrive together', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    ready(await checkouts().checkout(businessId, reference, EMAIL));
    await ageAttempts(businessId, 3600);

    await Promise.all([
      checkouts().checkout(businessId, reference, undefined, { restart: true }),
      checkouts().checkout(businessId, reference, undefined, { restart: true }),
    ]);

    expect(provider.initialized.map((i) => i.reference)).toEqual([
      reference,
      attemptReference(reference, 2),
    ]);
    expect(await liveCount(businessId)).toBe(1);
  });

  it('tells a request that arrives mid-start to ask again, without calling Paystack', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    /* A request that has opened its attempt and not yet heard from Paystack. */
    await withBusiness(appDb, businessId, async (tx) => {
      const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
      await subscriptionsRepo.openAttempt(tx, {
        businessId,
        chargeId: charge!.id,
        attemptNo: 1,
        providerReference: reference,
      });
    });

    const answer = await checkouts().checkout(businessId, reference, undefined, {
      siblingWaitMs: 0,
    });

    expect(answer).toEqual({ state: 'unavailable', reason: 'checkout_in_progress' });
    expect(provider.initialized).toHaveLength(0);
  });

  it('measures how long a request has been starting with the database clock, not the server clock', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    await withBusiness(appDb, businessId, async (tx) => {
      const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
      await subscriptionsRepo.openAttempt(tx, {
        businessId,
        chargeId: charge!.id,
        attemptNo: 1,
        providerReference: reference,
      });
    });

    /* This server's clock runs an hour ahead of the database's. The attempt was
     * opened a moment ago by the database's reckoning, so it is not abandoned. */
    const real = Date.now();
    const skewed = vi.spyOn(Date, 'now').mockReturnValue(real + 3_600_000);
    let answer;
    try {
      answer = await checkouts().checkout(businessId, reference, EMAIL, { siblingWaitMs: 0 });
    } finally {
      skewed.mockRestore();
    }

    expect(answer).toEqual({ state: 'unavailable', reason: 'checkout_in_progress' });
    expect(provider.initialized).toHaveLength(0);
    expect(await liveCount(businessId)).toBe(1);
  });

  it('recovers an attempt whose request died long ago', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    await withBusiness(appDb, businessId, async (tx) => {
      const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
      await subscriptionsRepo.openAttempt(tx, {
        businessId,
        chargeId: charge!.id,
        attemptNo: 1,
        providerReference: reference,
      });
    });
    await ageAttempts(businessId, 600);

    const answer = ready(await checkouts().checkout(businessId, reference, EMAIL));

    expect(answer.checkoutUrl).toContain(attemptReference(reference, 2));
    expect(await liveCount(businessId)).toBe(1);
  });

  it('never hands out the link of an attempt that was replaced while Paystack was answering', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    const realInitialize = provider.initializeTransaction.bind(provider);
    provider.initializeTransaction = async (input) => {
      const result = await realInitialize(input);
      /* While the call was in flight a sibling request replaced this attempt. */
      await withBusiness(appDb, businessId, async (tx) => {
        await tx.execute(sql`
          UPDATE subscription_charge_attempts SET status = 'superseded'
          WHERE business_id = ${businessId}::uuid AND provider_reference = ${input.reference}
        `);
      });
      return result;
    };

    const answer = await checkouts().checkout(businessId, reference, EMAIL);

    expect(answer).toEqual({ state: 'unavailable', reason: 'checkout_in_progress' });
    expect((await attemptsOf(businessId))[0]).toMatchObject({ status: 'superseded', url: null });
  });
});
