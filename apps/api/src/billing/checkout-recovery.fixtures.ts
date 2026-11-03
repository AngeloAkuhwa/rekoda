/**
 * Shared setup for the checkout recovery suites (G-102, OWN-50):
 * billing-checkout-recovery, billing-checkout-replacement and billing-checkout-guards.
 *
 * Each suite calls `useCheckoutRecoveryHarness()` once at its top level. Vitest gives every test
 * file its own copy of this module, so each suite still opens and closes its own database pools.
 * The provider stub's wrapped methods are restored before every test here, in one place, so a
 * test that wraps `initializeTransaction` or `verifyTransaction` cannot leak into the next.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach } from 'vitest';
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

export let urls: Urls;
export let appDb: Db;
export let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
export let config: ApiConfig;
export let provider: StubPaymentProvider;
export let deps: RunnerDeps;

/** The stub's own initialise, kept so a test that wraps it cannot leak into the next. */
let originalInitialize: StubPaymentProvider['initializeTransaction'];
let originalVerify: StubPaymentProvider['verifyTransaction'];

/** Registers the suite hooks: pools and stubs before all, a clean database and stub before each. */
export function useCheckoutRecoveryHarness(): void {
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

  beforeEach(async () => {
    await truncateAll(urls);
    provider.reset();
    provider.initializeTransaction = originalInitialize;
    provider.verifyTransaction = originalVerify;
    provider.modelPaystackReferences();
  });
}

export const plans = () => new BillingService(config, appDb);
export const checkouts = () => new BillingCheckoutService(config, appDb, provider);

let seq = 0;
export async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481730${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Recovery Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

export const EMAIL = 'ada@shop.example.ng';

/** A first purchase of Chat: one pending charge, owed. */
export async function pendingCharge(
  businessId: string,
): Promise<{ reference: string; amountK: number }> {
  const answer = await plans().changePlan(businessId, 'chat');
  if (answer.state !== 'payment_required') throw new Error('a first purchase should be payable');
  return { reference: answer.reference, amountK: answer.amountK };
}

export const ready = (answer: BillingCheckoutResponse) => {
  if (answer.state !== 'ready') throw new Error(`expected a ready checkout, got ${answer.state}`);
  return answer;
};

export interface AttemptSummary {
  no: number;
  ref: string;
  status: string;
  url: string | null;
}
export const attemptsOf = (businessId: string): Promise<AttemptSummary[]> =>
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

export const liveCount = async (businessId: string): Promise<number> =>
  (await attemptsOf(businessId)).filter((a) =>
    ['initializing', 'active', 'ambiguous'].includes(a.status),
  ).length;

export const chargeCount = (businessId: string): Promise<number> =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM subscription_charges WHERE business_id = ${businessId}::uuid
    `);
    return Number([...rows][0]!.n);
  });

/* ── the webhook side: a payment on any attempt reaches its charge ─────────── */

let nextTransactionId = 8_100_000;

export async function storeEvent(
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

export const pump = () => pumpPaystackEvents({ workerDb, appDb, vaultKey: config.vaultKey });
export async function drainJobs(): Promise<void> {
  const runner = buildRunner(workerDb, appDb, deps);
  while (await runner.runOnce());
}

export const eventError = (businessId: string, eventId: string): Promise<string | null> =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{ error: string | null }>(sql`
      SELECT error FROM external_events WHERE id = ${eventId}::uuid
    `);
    return [...rows][0]?.error ?? null;
  });

export const chargeOf = (businessId: string, reference: string) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.chargeByReference(tx, businessId, reference),
  );
