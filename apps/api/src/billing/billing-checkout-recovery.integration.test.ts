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
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { MAX_CHECKOUT_ATTEMPTS, attemptReference } from '@rekoda/core';
import type { BillingCheckoutResponse } from '@rekoda/contracts';
import {
  createDb,
  events,
  identity,
  sql,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '@rekoda/db/testing';
import { buildRunner, type RunnerDeps } from '../jobs/jobs.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { StubTextExtraction } from '../ai/ocr.stub.js';
import { StubSpeechToText } from '../ai/stt.stub.js';
import { LocalStorage } from '../documents/r2.storage.js';
import { ReplySender } from '../replies/reply.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import { sealPayload } from '../privacy/payload-vault.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { pumpPaystackEvents } from '../payments/paystack-pump.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import { BillingService } from './billing.service.js';
import { BillingCheckoutService } from './billing-checkout.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-recover-'));
const testKey = (label: string): string =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;
let deps: RunnerDeps;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 6 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = { ...loadConfig(), paystackSecretKey: 'sk_test_x', paystackPlatformConfirmed: true };

  provider = new StubPaymentProvider();
  originalInitialize = provider.initializeTransaction.bind(provider);
  const stubSender = new StubSender();
  deps = {
    gateway: new PrivacyGateway(appDb, config),
    interpreter: new Interpreter(appDb, config, StubTransport.answering({ intent: 'Unclear' })),
    replySender: new ReplySender(config, stubSender),
    storage: new LocalStorage(storageRoot),
    sender: stubSender,
    config,
    paymentProvider: provider,
    paymentIntents: new PaymentIntentsService(config, appDb, provider),
    stt: new StubSpeechToText(),
    ocr: new StubTextExtraction(),
    audioProbe: new ContainerAudioProbe(),
    commandBus: new CommandBus(new RiskPolicyService()),
  };
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

/** The stub's own initialise, kept so a test that wraps it cannot leak into the next. */
let originalInitialize: StubPaymentProvider['initializeTransaction'];

beforeEach(async () => {
  await truncateAll(urls);
  provider.reset();
  provider.initializeTransaction = originalInitialize;
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

describe('older and limiting cases', () => {
  it('adopts a link stored before attempts existed as attempt 1', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    await withBusiness(appDb, businessId, async (tx) => {
      await tx.execute(sql`
        UPDATE subscription_charges
        SET checkout_url = 'https://checkout.stub/legacy', checkout_started_at = now()
        WHERE business_id = ${businessId}::uuid AND reference = ${reference}
      `);
    });

    const answer = ready(await checkouts().checkout(businessId, reference, undefined));

    expect(answer.checkoutUrl).toBe('https://checkout.stub/legacy');
    expect(provider.initialized).toHaveLength(0);
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, ref: reference, status: 'active', url: 'https://checkout.stub/legacy' },
    ]);
  });

  it('stops at the attempt limit instead of looping', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    await withBusiness(appDb, businessId, async (tx) => {
      const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
      for (let n = 1; n <= MAX_CHECKOUT_ATTEMPTS; n += 1) {
        await tx.execute(sql`
          INSERT INTO subscription_charge_attempts
            (business_id, charge_id, attempt_no, provider_reference, status, created_at)
          VALUES (${businessId}::uuid, ${charge!.id}::uuid, ${n},
                  ${attemptReference(reference, n)},
                  ${n === MAX_CHECKOUT_ATTEMPTS ? 'ambiguous' : 'superseded'},
                  now() - interval '1 hour')
        `);
      }
    });

    const answer = await checkouts().checkout(businessId, reference, EMAIL);

    expect(answer).toEqual({ state: 'unavailable', reason: 'too_many_attempts' });
    expect(provider.initialized).toHaveLength(0);
  });

  it('keeps attempts inside their own business', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    const { reference } = await pendingCharge(mine);
    ready(await checkouts().checkout(mine, reference, EMAIL));

    expect(await attemptsOf(theirs)).toEqual([]);
    expect(await checkouts().checkout(theirs, reference, EMAIL)).toEqual({
      state: 'unavailable',
      reason: 'unknown_charge',
    });
    expect(provider.initialized).toHaveLength(1);
  });
});

/* ── the webhook side: a payment on any attempt reaches its charge ─────────── */

let nextTransactionId = 8_100_000;

async function storeEvent(
  reference: string,
  amountK: number,
  type = 'charge.success',
): Promise<string> {
  const transactionId = ++nextTransactionId;
  const body = {
    event: type,
    data: {
      id: transactionId,
      reference,
      amount: amountK,
      currency: 'NGN',
      status: type === 'charge.success' ? 'success' : 'failed',
      customer: { email: 'owner@example.com' },
    },
  };
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: body.event,
    externalId: `${transactionId}:${body.event}`,
    payload: sealPayload(body, config.vaultKey, 'paystack', `${transactionId}:${body.event}`),
    businessId: null,
  });
  return storedEventId(recorded);
}

const pump = () => pumpPaystackEvents({ workerDb, appDb, vaultKey: config.vaultKey });
async function drainJobs(): Promise<void> {
  const runner = buildRunner(workerDb, appDb, deps);
  while (await runner.runOnce());
}

const eventError = (businessId: string, eventId: string): Promise<string | null> =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{ error: string | null }>(sql`
      SELECT error FROM external_events WHERE id = ${eventId}::uuid
    `);
    return [...rows][0]?.error ?? null;
  });

const chargeOf = (businessId: string, reference: string) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.chargeByReference(tx, businessId, reference),
  );
const expiryOf = (businessId: string) =>
  withBusiness(appDb, businessId, async (tx) => {
    const sub = await subscriptionsRepo.subscriptionFor(tx, businessId);
    return sub?.planExpiresAt?.getTime() ?? null;
  });

/** A charge whose first checkout was lost and replaced: attempts 1 (superseded) and 2 (active). */
async function recoveredCharge(): Promise<{
  businessId: string;
  reference: string;
  amountK: number;
  second: string;
}> {
  const businessId = await seedBusiness();
  const { reference, amountK } = await pendingCharge(businessId);
  provider.loseNextInitializeResponse();
  await expect(checkouts().checkout(businessId, reference, EMAIL)).rejects.toThrow();
  ready(await checkouts().checkout(businessId, reference, undefined));
  return { businessId, reference, amountK, second: attemptReference(reference, 2) };
}

describe('a payment on a replaced checkout', () => {
  it('settles the charge when it is made on the replacement attempt', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(second, { amountK });
    await storeEvent(second, amountK);

    expect(await pump()).toBe(1);
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'superseded' },
      { no: 2, status: 'paid' },
    ]);
  });

  it('settles the charge when it is made on the older attempt and the charge is still pending', async () => {
    const { businessId, reference, amountK } = await recoveredCharge();
    provider.willVerify(reference, { amountK });
    await storeEvent(reference, amountK);

    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'paid' },
      { no: 2, status: 'superseded' },
    ]);
  });

  it('treats a second payment on the other attempt as a duplicate to refund, never a second entitlement', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(reference, { amountK });
    await storeEvent(reference, amountK);
    await pump();
    await drainJobs();
    const expiryAfterFirst = await expiryOf(businessId);

    provider.willVerify(second, { amountK });
    const duplicate = await storeEvent(second, amountK);
    await pump();
    await drainJobs();

    expect(await eventError(businessId, duplicate)).toBe('duplicate_payment');
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'paid' },
      { no: 2, status: 'duplicate_paid' },
    ]);
    expect(await expiryOf(businessId)).toBe(expiryAfterFirst);
    expect(await chargeCount(businessId)).toBe(1);
    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
  });

  it('settles once and flags the other when both sessions are paid at the same moment', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(reference, { amountK });
    provider.willVerify(second, { amountK });
    const first = await storeEvent(reference, amountK);
    const other = await storeEvent(second, amountK);
    expect(await pump()).toBe(2);

    await Promise.all([drainJobs(), drainJobs()]);

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    const statuses = (await attemptsOf(businessId)).map((a) => a.status).sort();
    expect(statuses).toEqual(['duplicate_paid', 'paid']);
    const errors = [await eventError(businessId, first), await eventError(businessId, other)];
    expect(errors.filter((e) => e === 'duplicate_payment')).toHaveLength(1);
    expect(errors.filter((e) => e === null)).toHaveLength(1);
    expect(await chargeCount(businessId)).toBe(1);
  });

  it('does not mistake a repeat of the settling payment for a duplicate', async () => {
    const { businessId, reference, amountK } = await recoveredCharge();
    provider.willVerify(reference, { amountK });
    await storeEvent(reference, amountK);
    await pump();
    await drainJobs();

    const repeat = await storeEvent(reference, amountK);
    await pump();
    await drainJobs();

    expect(await eventError(businessId, repeat)).toBe('already_paid');
    expect((await attemptsOf(businessId))[0]).toMatchObject({ no: 1, status: 'paid' });
  });

  it('does not close the charge because a replaced attempt was reported failed', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(reference, { amountK, succeeded: false, providerStatus: 'failed' });
    await storeEvent(reference, amountK);

    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect((await attemptsOf(businessId))[1]).toMatchObject({ ref: second, status: 'active' });
  });

  it('still closes the charge when the live attempt is reported failed, as before', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    ready(await checkouts().checkout(businessId, reference, EMAIL));
    provider.willVerify(reference, { amountK, succeeded: false, providerStatus: 'failed' });
    await storeEvent(reference, amountK);

    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('failed');
    expect((await attemptsOf(businessId))[0]).toMatchObject({ no: 1, status: 'failed' });
  });
});

describe('a failed replacement does not strand a payment on the older session', () => {
  it('keeps the charge pending when the live attempt fails after an older one was replaced, so the older session can still be paid', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(second, { amountK, succeeded: false, providerStatus: 'failed' });
    await storeEvent(second, amountK);
    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'superseded' },
      { no: 2, status: 'failed' },
    ]);

    /* The merchant still had the first session open and pays on it. */
    provider.willVerify(reference, { amountK });
    await storeEvent(reference, amountK);
    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect((await attemptsOf(businessId))[0]).toMatchObject({ no: 1, status: 'paid' });
  });

  it('lets the merchant start a new session on a charge whose only live attempt failed', async () => {
    const { businessId, reference, second } = await recoveredCharge();
    provider.willVerify(second, { amountK: 0, succeeded: false, providerStatus: 'failed' });
    await storeEvent(second, 0);
    await pump();
    await drainJobs();

    const again = ready(await checkouts().checkout(businessId, reference, undefined));

    expect(again.checkoutUrl).toContain(attemptReference(reference, 3));
    expect(await liveCount(businessId)).toBe(1);
  });
});

describe('a failure report racing a replacement', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('does not close the charge when the live attempt is replaced while the failure is being processed', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    ready(await checkouts().checkout(businessId, reference, EMAIL));
    provider.willVerify(reference, { amountK, succeeded: false, providerStatus: 'failed' });
    await storeEvent(reference, amountK);
    await pump();

    /* A restart is mid-way through replacing the attempt: it holds the business and
     * has not committed, as `replace` does between retiring one attempt and opening
     * the next. */
    let release!: () => void;
    let replacing!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const replacingP = new Promise<void>((resolve) => (replacing = resolve));
    const replacement = withBusiness(appDb, businessId, async (tx) => {
      await subscriptionsRepo.lockBusiness(tx, businessId);
      const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
      const live = await subscriptionsRepo.liveAttempt(tx, businessId, charge!.id);
      await subscriptionsRepo.moveAttempt(tx, businessId, live!.id, ['active'], 'superseded');
      const next = await subscriptionsRepo.openAttempt(tx, {
        businessId,
        chargeId: charge!.id,
        attemptNo: 2,
        providerReference: attemptReference(reference, 2),
      });
      await subscriptionsRepo.recordAttemptCheckout(
        tx,
        businessId,
        next!.id,
        'https://checkout.stub/replacement',
        new Date(),
      );
      replacing();
      await held;
    });
    await replacingP;

    const processing = drainJobs();
    await sleep(500);
    release();
    await replacement;
    await processing;

    /* The failure was about the session that has just been replaced. */
    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'superseded' },
      { no: 2, status: 'active' },
    ]);
  });
});

describe('lock order matches settlement, which takes the business before the charge', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Hold the business row the way a settling payment does, until released. */
  function holdBusiness(businessId: string) {
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const lockedP = new Promise<void>((resolve) => (locked = resolve));
    const done = withBusiness(appDb, businessId, async (tx) => {
      await subscriptionsRepo.lockBusiness(tx, businessId);
      locked();
      await held;
    });
    return { release, locked: lockedP, done };
  }

  const probeCanLock = (
    businessId: string,
    table: 'subscription_charges' | 'subscription_charge_attempts',
  ) =>
    withBusiness(appDb, businessId, async (tx) => {
      await tx.execute(
        table === 'subscription_charges'
          ? sql`SELECT id FROM subscription_charges WHERE business_id = ${businessId}::uuid FOR UPDATE NOWAIT`
          : sql`SELECT id FROM subscription_charge_attempts WHERE business_id = ${businessId}::uuid FOR UPDATE NOWAIT`,
      );
    });

  it('does not hold the charge while it waits for the business, when a billing email is being set', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    const holder = holdBusiness(businessId);
    await holder.locked;

    const pending = checkouts().checkout(businessId, reference, EMAIL);
    await sleep(400);

    /* Were the charge locked first, a payment settling at this moment would
     * wait for it while this request waited for the business: a deadlock. */
    await expect(probeCanLock(businessId, 'subscription_charges')).resolves.toBeUndefined();

    holder.release();
    await holder.done;
    expect(ready(await pending).checkoutUrl).toContain(reference);
  });

  it('does not hold the attempt while it waits for the business to record the link', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    let holder!: ReturnType<typeof holdBusiness>;
    const real = provider.initializeTransaction.bind(provider);
    provider.initializeTransaction = async (input) => {
      const answer = await real(input);
      /* A payment starts settling while Paystack's answer is on its way back. */
      holder = holdBusiness(businessId);
      await holder.locked;
      return answer;
    };

    const pending = checkouts().checkout(businessId, reference, EMAIL);
    await sleep(600);

    await expect(probeCanLock(businessId, 'subscription_charge_attempts')).resolves.toBeUndefined();
    await expect(probeCanLock(businessId, 'subscription_charges')).resolves.toBeUndefined();

    holder.release();
    await holder.done;
    expect(ready(await pending).checkoutUrl).toContain(reference);
  });
});

describe('references the pump and the job must not trust blindly', () => {
  it('flags a replacement reference for an attempt that was never made', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    ready(await checkouts().checkout(businessId, reference, EMAIL));
    const invented = attemptReference(reference, 5);
    provider.willVerify(invented, { amountK });
    const eventId = await storeEvent(invented, amountK);

    await pump();
    await drainJobs();

    expect(await eventError(businessId, eventId)).toBe('unknown_attempt');
    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
  });

  it('marks a replacement reference for a charge nobody holds as unknown', async () => {
    const phantom = attemptReference('RKD-SUB-20261024-ZZZZZZ', 2);
    const eventId = await storeEvent(phantom, 990_000);

    await pump();

    const rows = await workerDb.execute<{ error: string | null }>(sql`
      SELECT error FROM external_events WHERE id = ${eventId}::uuid
    `);
    expect([...rows][0]?.error).toBe('unknown_reference');
  });
});
