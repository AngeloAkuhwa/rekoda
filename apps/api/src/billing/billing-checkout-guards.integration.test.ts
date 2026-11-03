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
// recovery.integration.test.ts, billing-checkout-replacement.integration.test.ts.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { mkdtempSync, readFileSync } from 'node:fs';
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
  originalVerify = provider.verifyTransaction.bind(provider);
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

  it('backfills the links slice 1 stored as attempt 1, once, mapping each charge status', async () => {
    const businessId = await seedBusiness();
    const owner = createDb(urls.owner, { max: 1 });
    try {
      await owner.db.execute(sql`
        INSERT INTO subscription_charges
          (business_id, kind, quantity, amount_k, status, reference, checkout_url, checkout_started_at)
        VALUES
          (${businessId}::uuid, 'add_on', 1, 1000, 'pending',  'RKD-PACK-20261024-AAAAAA', 'https://checkout.stub/a', now()),
          (${businessId}::uuid, 'add_on', 1, 1000, 'failed',   'RKD-PACK-20261024-BBBBBB', 'https://checkout.stub/b', now()),
          (${businessId}::uuid, 'add_on', 1, 1000, 'paid',     'RKD-PACK-20261024-CCCCCC', 'https://checkout.stub/c', now()),
          (${businessId}::uuid, 'add_on', 1, 1000, 'refunded', 'RKD-PACK-20261024-DDDDDD', 'https://checkout.stub/d', now()),
          (${businessId}::uuid, 'add_on', 1, 1000, 'pending',  'RKD-PACK-20261024-EEEEEE', NULL, NULL)
      `);
      /* The backfill statement itself, as the migration runs it. */
      const migration = readFileSync(
        new URL('../../../../packages/db/migrations/0173_checkout_attempts.sql', import.meta.url),
        'utf8',
      );
      const backfill = migration.slice(
        migration.lastIndexOf('INSERT INTO subscription_charge_attempts'),
      );
      await owner.db.execute(sql.raw(backfill));
      await owner.db.execute(sql.raw(backfill));
    } finally {
      await owner.close();
    }

    const rows = (await attemptsOf(businessId)).sort((a, b) => a.ref.localeCompare(b.ref));
    expect(rows.map((r) => [r.ref, r.no, r.status, r.url])).toEqual([
      ['RKD-PACK-20261024-AAAAAA', 1, 'active', 'https://checkout.stub/a'],
      ['RKD-PACK-20261024-BBBBBB', 1, 'failed', 'https://checkout.stub/b'],
      ['RKD-PACK-20261024-CCCCCC', 1, 'paid', 'https://checkout.stub/c'],
      ['RKD-PACK-20261024-DDDDDD', 1, 'paid', 'https://checkout.stub/d'],
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
