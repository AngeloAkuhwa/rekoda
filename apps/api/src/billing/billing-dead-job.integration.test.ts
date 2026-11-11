/**
 * OWN-76 (PR B item 3): a dead `billing.process` job, through the real runner and billing handler.
 *
 * A billing job that dies leaves a billing notice for the merchant (never a reconciliation
 * exception: Rekoda's revenue is not the merchant's books) and an operator item carrying the
 * reference and the current payment and plan state. Nothing is extended or credited by the death,
 * and nothing replays by itself. An operator's recovery verifies the reference with Paystack and
 * runs one attempt: a confirmed payment then applies exactly once; a payment Paystack reports
 * failed extends nothing; a reference Paystack does not know, or an unreadable event, is refused.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { subscriptionReference, usagePeriod } from '@rekoda/core';
import {
  createDb,
  deadJobsRepo,
  jobsRepo,
  sql,
  events,
  identity,
  settleRepo,
  subscriptionsRepo,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import {
  migrate,
  requireUrls,
  storedEventId,
  truncateAll,
  type Urls,
  settlementDb,
} from '@rekoda/db/testing';
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
import { DeadJobRecoveryService } from '../health/dead-job-recovery.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-billdead-'));

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;
let deps: RunnerDeps;

function testKey(label: string): string {
  return createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
}

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = loadConfig();

  provider = new StubPaymentProvider();
  const stubSender = new StubSender();
  deps = {
    settlementDb: settlementDb(),
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
});

let phoneSeq = 0;

async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481920000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const CHAT_K = 990_000;

/** A pending first-purchase charge, as the billing endpoint would open one. */
async function openSubscriptionCharge(
  businessId: string,
  opts: { amountK?: number; kind?: 'first_purchase' | 'add_on'; packId?: string } = {},
): Promise<string> {
  const reference = subscriptionReference(new Date(), (n) => randomBytes(n));
  const now = new Date();
  await withBusiness(settlementDb(), businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind: opts.kind ?? 'first_purchase',
      plan: opts.kind === 'add_on' ? null : 'chat',
      packId: opts.packId ?? null,
      amountK: opts.amountK ?? CHAT_K,
      reference,
      periodStart: opts.kind === 'add_on' ? null : now,
      periodEnd: opts.kind === 'add_on' ? null : new Date(now.getTime() + 30 * 86_400_000),
    }),
  );
  return reference;
}

let nextTransactionId = 7_000_000;

/** Store an event byte-for-byte the way the ingress controller does. */
async function storeChargeSuccess(reference: string, amountK = CHAT_K): Promise<string> {
  const transactionId = ++nextTransactionId;
  const body = {
    event: 'charge.success',
    data: {
      id: transactionId,
      reference,
      amount: amountK,
      currency: 'NGN',
      status: 'success',
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

async function drainJobs(): Promise<number> {
  const runner = buildRunner(workerDb, appDb, deps);
  let ran = 0;
  while (await runner.runOnce()) ran += 1;
  return ran;
}

const chargeOf = (businessId: string, reference: string) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.chargeByReference(tx, businessId, reference),
  );

const subscriptionOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId));

const PACK_K = 250_000;
const PACK_UNITS = 100; // messages_100 -> AI_ACTIONS

const bonusOf = async (businessId: string): Promise<number> => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return rows.find((row) => row.unit === 'AI_ACTIONS')?.bonus ?? 0;
};

async function openPack(businessId: string): Promise<string> {
  return openSubscriptionCharge(businessId, {
    kind: 'add_on',
    packId: 'messages_100',
    amountK: PACK_K,
  });
}

async function payPack(businessId: string, reference: string, amountK = PACK_K): Promise<string> {
  provider.willVerify(reference, { amountK });
  const eventId = await storeChargeSuccess(reference, amountK);
  // The event must reach the billing handler, or a refusal below proves nothing.
  expect(await pump()).toBe(1);
  await drainJobs();
  return eventId;
}

const recovery = () => new DeadJobRecoveryService(config, appDb, workerDb, provider);
const billing = () => new BillingService(config, appDb, settlementDb());
const OPERATOR = 'operator:alice@rekoda.app';

/** Pay a charge's webhook into a billing job that dies: Paystack is down on its only attempt. */
async function deadBillingJob(businessId: string, reference: string, amountK: number) {
  provider.willVerify(reference, { amountK });
  await storeChargeSuccess(reference, amountK);
  expect(await pump()).toBe(1);
  await withBusiness(appDb, businessId, (tx) =>
    tx.execute(sql`UPDATE jobs SET max_attempts = 1 WHERE business_id = ${businessId}::uuid`),
  );
  provider.failNextVerifyWith(new Error('Paystack is down'));
  expect(await drainJobs()).toBe(1);
  const [job] = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
  expect(job?.state).toBe('dead');
  return job!.id;
}

const statusOf = async (businessId: string, jobId: string) =>
  [
    ...(await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ status: string }>(
        sql`SELECT status FROM dead_job_exceptions WHERE job_id = ${jobId}::uuid`,
      ),
    )),
  ][0]?.status;

const merchantExceptions = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    settleRepo.reconciliationsFor(tx, { status: 'EXCEPTION', limit: 50 }),
  );

describe('OWN-76: a billing job that dies', () => {
  it('extends and credits nothing, shows a billing notice, and never a reconciliation exception', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    await deadBillingJob(businessId, reference, CHAT_K);

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect((await subscriptionOf(businessId))?.plan).toBe('trial');
    expect(await merchantExceptions(businessId)).toHaveLength(0);

    const overview = await billing().overview(businessId);
    expect(overview.processingIssue).toMatchObject({ recovering: false });
    // Another business sees no notice.
    const other = await seedBusiness();
    expect((await billing().overview(other)).processingIssue).toBeNull();
  });

  it('gives the operator the reference, the charge state and the plan state', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    const jobId = await deadBillingJob(businessId, reference, CHAT_K);

    const [item] = await deadJobsRepo.opsQueue(workerDb);
    expect(item).toMatchObject({
      jobId,
      businessId,
      kind: 'billing.process',
      reference,
      paymentState: 'pending',
      currentPlan: 'trial',
    });
  });
});

describe('OWN-76: an operator recovers a dead billing job', () => {
  it('a payment Paystack confirms applies the plan exactly once, and the notice clears', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    const jobId = await deadBillingJob(businessId, reference, CHAT_K);

    expect(await recovery().recover(jobId, OPERATOR, 'Paystack is back')).toEqual({
      outcome: 'recovering',
      jobId,
    });
    expect((await billing().overview(businessId)).processingIssue).toMatchObject({
      recovering: true,
    });
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    const sub = await subscriptionOf(businessId);
    expect(sub?.plan).toBe('chat');
    const renewsAt = sub?.planExpiresAt?.toISOString();
    expect(await statusOf(businessId, jobId)).toBe('recovered');
    expect((await billing().overview(businessId)).processingIssue).toBeNull();

    // The same payment announced again: no second extension.
    await storeChargeSuccess(reference, CHAT_K);
    await pump();
    await drainJobs();
    expect((await subscriptionOf(businessId))?.planExpiresAt?.toISOString()).toBe(renewsAt);
    expect(await recovery().recover(jobId, OPERATOR, 'again')).toEqual({ outcome: 'not_open' });
  });

  it('a pack payment Paystack confirms credits its units exactly once', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    const jobId = await deadBillingJob(businessId, reference, PACK_K);
    expect(await bonusOf(businessId)).toBe(0);

    await recovery().recover(jobId, OPERATOR, 'Paystack is back');
    await drainJobs();
    await storeChargeSuccess(reference, PACK_K);
    await pump();
    await drainJobs();

    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('a payment Paystack reports failed extends nothing, even through a recovery', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    const jobId = await deadBillingJob(businessId, reference, CHAT_K);
    provider.willVerify(reference, { succeeded: false, providerStatus: 'failed', amountK: CHAT_K });

    expect((await recovery().recover(jobId, OPERATOR, 'check it'))?.outcome).toBe('recovering');
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('failed');
    expect((await subscriptionOf(businessId))?.plan).toBe('trial');
  });

  it('a reference Paystack does not know is refused, and nothing runs', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    const jobId = await deadBillingJob(businessId, reference, CHAT_K);
    provider.reset();

    expect(await recovery().recover(jobId, OPERATOR, 'check it')).toEqual({
      outcome: 'verify_not_found',
    });
    expect(await drainJobs()).toBe(0);
    expect(await statusOf(businessId, jobId)).toBe('open');
    expect((await subscriptionOf(businessId))?.plan).toBe('trial');
  });

  it('a poisoned event (a seal that will not open) dies, and recovery refuses it: no reference', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    await storeChargeSuccess(reference, CHAT_K);
    expect(await pump()).toBe(1);
    // The stored payload is resealed under a key this deployment does not hold: every attempt
    // throws on the seal (the handler treats it as a key problem and retries, then dies).
    const foreign = sealPayload(
      { event: 'charge.success', data: { reference } },
      testKey('another-vault'),
      'paystack',
      'x',
    );
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE external_events SET payload = ${JSON.stringify(foreign)}::jsonb`),
    );
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET max_attempts = 1 WHERE business_id = ${businessId}::uuid`),
    );
    await drainJobs();
    const [job] = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(job?.state).toBe('dead');

    expect(await recovery().recover(job!.id, OPERATOR, 'check it')).toEqual({
      outcome: 'no_reference',
    });
    expect(await drainJobs()).toBe(0);
    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
  });
});
