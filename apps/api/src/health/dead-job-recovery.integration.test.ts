/**
 * OWN-73 (PR B item 2): a dead `payment.process` job, end to end through the real runner and
 * handler: the merchant exception and operator item it leaves, and an operator's verified,
 * bounded recovery that books the payment exactly once.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentReference } from '@rekoda/core';
import { encryptFacet, matchKeyFor } from '@rekoda/core/vault';
import {
  conversationsRepo,
  createDb,
  customersRepo,
  events,
  identity,
  issueRepo,
  jobsRepo,
  paymentsHub,
  settleRepo,
  sql,
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
import { deadJobsRepo } from '@rekoda/db';
import { DeadJobRecoveryService } from './dead-job-recovery.service.js';
import { DeadJobsController } from './dead-jobs.controller.js';
import { OpsController } from './ops.controller.js';
import type { SecurityMetrics } from '../channels/security-metrics.service.js';
import type { OperatorRequest } from '../auth/operator.guard.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-deadjob-'));

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;
let stubSender: StubSender;
let stubStt: StubSpeechToText;
let stubOcr: StubTextExtraction;
let deps: RunnerDeps;

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
  stubSender = new StubSender();
  stubStt = new StubSpeechToText();
  stubOcr = new StubTextExtraction();
  deps = {
    gateway: new PrivacyGateway(appDb, config),
    interpreter: new Interpreter(appDb, config, StubTransport.answering({ intent: 'Unclear' })),
    replySender: new ReplySender(config, stubSender),
    storage: new LocalStorage(storageRoot),
    sender: stubSender,
    config,
    paymentProvider: provider,
    paymentIntents: new PaymentIntentsService(config, appDb, provider),
    stt: stubStt,
    ocr: stubOcr,
    audioProbe: new ContainerAudioProbe(),
    commandBus: new CommandBus(new RiskPolicyService()),
  };
});

function testKey(label: string): string {
  return createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
}

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  provider.reset();
  stubSender.reset();
});

/* ── seeding ─────────────────────────────────────────────────────────────── */

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481300001${String(++phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/**
 * The owner wrote to the business number `hoursAgo` hours ago. The receipt PDF
 * is a free-form WhatsApp message, deliverable only inside the 24 hours after
 * that (G-67); outside it the owner gets a template notice instead.
 */
let wroteSeq = 0;
async function ownerWroteHoursAgo(businessId: string, hoursAgo: number): Promise<void> {
  wroteSeq += 1;
  await withBusiness(appDb, businessId, async (tx) => {
    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: 'hello',
      providerMessageId: `wamid.pipeline-${wroteSeq}`,
    });
    await tx.execute(
      sql`UPDATE conversation_messages SET created_at = now() - make_interval(hours => ${hoursAgo}) WHERE id = ${message.id}`,
    );
  });
}

/** An unpaid ₦150,000 invoice with a live intent, the normal way in. */
async function seedObligation(businessId: string, opts: { expiresAt?: Date } = {}) {
  return withBusiness(appDb, businessId, async (tx) => {
    const sale = await issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: 'CUSTOMER_7K2',
      items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
      subtotalK: 15_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 15_000_000,
      paidK: 0,
      balanceDueK: 15_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: 'draft-1',
      actor: 'system',
    });
    const intent = await paymentsHub.createIntent(tx, {
      businessId,
      reference: paymentReference(new Date(), (n) => randomBytes(n)),
      expectedAmountK: 15_000_000,
      providerType: 'paystack',
      invoiceId: sale.invoiceId,
      expiresAt: opts.expiresAt ?? null,
    });
    return { sale, intent };
  });
}

let nextTransactionId = 9_000_000;

/** Store an event byte-for-byte the way the ingress controller does. */
async function storeChargeSuccess(
  reference: string,
  opts: { amountK?: number; transactionId?: number } = {},
): Promise<string> {
  const transactionId = opts.transactionId ?? ++nextTransactionId;
  const body = {
    event: 'charge.success',
    data: {
      id: transactionId,
      reference,
      amount: opts.amountK ?? 15_000_000,
      currency: 'NGN',
      status: 'success',
      customer: { email: 'adaeze.okonkwo@example.com' },
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

/* ── read-backs, all through the pinned repo layer ───────────────────────── */

const invoiceState = (businessId: string, invoiceId: string) =>
  withBusiness(appDb, businessId, (tx) => issueRepo.invoiceForPayment(tx, businessId, invoiceId));

const paymentCount = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => settleRepo.paymentCount(tx));

const receiptCount = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => settleRepo.receiptCount(tx));

const reconciliationsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => settleRepo.reconciliationsFor(tx));

const intentAfter = (businessId: string, reference: string) =>
  withBusiness(appDb, businessId, (tx) => paymentsHub.intentByReference(tx, businessId, reference));

async function ledgerTotals(businessId: string): Promise<{ d: number; c: number; lines: number }> {
  const entries = await withBusiness(appDb, businessId, (tx) =>
    issueRepo.ledgerEntriesFor(tx, businessId),
  );
  return {
    d: entries.reduce((sum, e) => sum + Number(e.debitK), 0),
    c: entries.reduce((sum, e) => sum + Number(e.creditK), 0),
    lines: entries.length,
  };
}

/* ── killing a payment job, and recovering it ───────────────────────────── */

/** The payment job for an event, made to die: Paystack is down on its only attempt. */
async function deadPaymentJob(businessId: string, reference: string) {
  provider.willVerify(reference, { amountK: 15_000_000 });
  const eventId = await storeChargeSuccess(reference);
  expect(await pump()).toBe(1);
  await withBusiness(appDb, businessId, (tx) =>
    tx.execute(sql`UPDATE jobs SET max_attempts = 1 WHERE business_id = ${businessId}::uuid`),
  );
  provider.failNextVerifyWith(new Error('Paystack is down'));
  const runner = buildRunner(workerDb, appDb, deps);
  expect(await runner.runOnce()).toBe(true);
  const [job] = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
  expect(job?.state).toBe('dead');
  return { eventId, jobId: job!.id };
}

const service = () => new DeadJobRecoveryService(config, appDb, workerDb, provider);
const controller = () => new DeadJobsController(service());
const asOperator = { operator: { subject: 'alice@rekoda.app' } } as unknown as OperatorRequest;

const recordOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => deadJobsRepo.openForBusiness(tx, businessId));

const statusOf = async (businessId: string, jobId: string) =>
  [
    ...(await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ status: string; death_count: number }>(
        sql`SELECT status, death_count FROM dead_job_exceptions WHERE job_id = ${jobId}::uuid`,
      ),
    )),
  ][0];

const auditActions = async (businessId: string, jobId: string) => [
  ...(await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ action: string; actor: string; new_value: Record<string, unknown> }>(sql`
        SELECT action, actor, new_value FROM audit_events
        WHERE entity = 'job' AND entity_id = ${jobId} ORDER BY created_at`),
  )),
];

describe('OWN-73: a payment job that dies', () => {
  it('leaves a merchant exception and an operator item, and books nothing', async () => {
    const businessId = await seedBusiness();
    const { intent, sale } = await seedObligation(businessId);
    // Issuing the invoice posted its own lines; the death must add none.
    const before = await ledgerTotals(businessId);
    const invoiceBefore = (await invoiceState(businessId, sale.invoiceId))?.status;
    const { eventId, jobId } = await deadPaymentJob(businessId, intent.reference);

    expect(await paymentCount(businessId)).toBe(0);
    expect(await ledgerTotals(businessId)).toEqual(before);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe(invoiceBefore);
    expect((await intentAfter(businessId, intent.reference))?.status).toBe(intent.status);

    const merchant = await reconciliationsOf(businessId);
    expect(merchant.filter((r) => r.reason === 'payment_processing_stopped')).toHaveLength(1);
    const queue = await events.exceptionQueue(workerDb);
    expect(queue.flagged.find((row) => row.id === eventId)?.jobId).toBe(jobId);
    expect((await events.eventStatus(workerDb, eventId))?.processed).toBe(false);
  });
});

describe('OWN-73: an operator recovers a dead payment job', () => {
  it('verifies with Paystack, runs ONE attempt, books once, and closes both records', async () => {
    const businessId = await seedBusiness();
    const { intent, sale } = await seedObligation(businessId);
    const { eventId, jobId } = await deadPaymentJob(businessId, intent.reference);

    expect(
      await controller().recover(asOperator, jobId, { reason: 'Paystack is back up' }),
    ).toEqual({ recovering: true, jobId });
    expect((await statusOf(businessId, jobId))?.status).toBe('recovering');

    await drainJobs();

    expect(await paymentCount(businessId)).toBe(1);
    expect(await receiptCount(businessId)).toBe(1);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
    expect((await statusOf(businessId, jobId))?.status).toBe('recovered');
    const merchant = await reconciliationsOf(businessId);
    const stopped = merchant.filter((r) => r.reason === 'payment_processing_stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.resolvedAt).not.toBeNull();
    expect((await events.eventStatus(workerDb, eventId))?.processed).toBe(true);

    const audit = await auditActions(businessId, jobId);
    expect(audit.map((a) => a.action)).toEqual([
      'dead_job_exception_opened',
      'dead_job_recovery_started',
      'dead_job_recovered',
    ]);
    expect(audit[1]).toMatchObject({
      actor: 'operator:alice@rekoda.app',
      new_value: {
        reason: 'Paystack is back up',
        reference: intent.reference,
        verification: 'found:success',
      },
    });
  });

  it('a job queued before the upgrade (no reference in its payload) recovers from its signed event', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { jobId } = await deadPaymentJob(businessId, intent.reference);
    const owner = createDb(urls.owner, { max: 1 });
    await owner.db.execute(
      sql`UPDATE dead_job_exceptions SET reference = NULL WHERE job_id = ${jobId}::uuid`,
    );
    await owner.close();
    expect(await controller().recover(asOperator, jobId, { reason: 'old payload' })).toEqual({
      recovering: true,
      jobId,
    });
    await drainJobs();
    expect(await paymentCount(businessId)).toBe(1);
    expect((await statusOf(businessId, jobId))?.status).toBe('recovered');
  });

  it('a second recovery of the same job is refused, and a replayed event books nothing more', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { jobId } = await deadPaymentJob(businessId, intent.reference);
    await controller().recover(asOperator, jobId, { reason: 'Paystack is back up' });
    await expect(
      controller().recover(asOperator, jobId, { reason: 'again, please' }),
    ).rejects.toMatchObject({ status: 409 });
    await drainJobs();
    await expect(
      controller().recover(asOperator, jobId, { reason: 'once more' }),
    ).rejects.toMatchObject({ status: 409 });

    // The same payment announced again: the handler's own idempotency holds.
    await storeChargeSuccess(intent.reference);
    await pump();
    await drainJobs();
    expect(await paymentCount(businessId)).toBe(1);
  });

  it('a recovery attempt that dies again reopens the SAME record and does not run again', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { jobId } = await deadPaymentJob(businessId, intent.reference);
    await controller().recover(asOperator, jobId, { reason: 'Paystack is back up' });
    provider.failNextVerifyWith(new Error('Paystack is down again'));
    await drainJobs();

    expect(await statusOf(businessId, jobId)).toEqual({ status: 'open', death_count: 2 });
    expect(await recordOf(businessId)).toHaveLength(1);
    expect(await paymentCount(businessId)).toBe(0);
    expect(await drainJobs()).toBe(0);
  });

  it('Paystack unreachable during recovery: 503, nothing changes, the attempt is audited', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { jobId } = await deadPaymentJob(businessId, intent.reference);
    provider.failNextVerifyWith(new Error('still down'));

    await expect(
      controller().recover(asOperator, jobId, { reason: 'try now' }),
    ).rejects.toMatchObject({ status: 503 });
    expect((await statusOf(businessId, jobId))?.status).toBe('open');
    expect(await drainJobs()).toBe(0);
    const audit = await auditActions(businessId, jobId);
    expect(audit.at(-1)).toMatchObject({
      action: 'dead_job_recovery_refused',
      new_value: { outcome: 'verify_unavailable' },
    });
  });

  it('a reference Paystack does not know is refused; nothing is requeued', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { jobId } = await deadPaymentJob(businessId, intent.reference);
    provider.reset();

    await expect(
      controller().recover(asOperator, jobId, { reason: 'try now' }),
    ).rejects.toMatchObject({ status: 422 });
    expect((await statusOf(businessId, jobId))?.status).toBe('open');
    expect(await drainJobs()).toBe(0);
    expect(await paymentCount(businessId)).toBe(0);
  });

  it('a job whose queued reference differs from its signed event is refused: invalid_reference', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { jobId } = await deadPaymentJob(businessId, intent.reference);
    // The record names another of Rekoda's references; the signed event is the authority.
    const owner = createDb(urls.owner, { max: 1 });
    await owner.db.execute(
      sql`UPDATE dead_job_exceptions SET reference = 'RKD-PAY-20261108-ZZZZZZ' WHERE job_id = ${jobId}::uuid`,
    );
    await owner.close();

    await expect(
      controller().recover(asOperator, jobId, { reason: 'try now' }),
    ).rejects.toMatchObject({ status: 422 });
    expect((await statusOf(businessId, jobId))?.status).toBe('open');
    expect(await drainJobs()).toBe(0);
    const audit = await auditActions(businessId, jobId);
    expect(audit.at(-1)).toMatchObject({ new_value: { outcome: 'invalid_reference' } });
  });

  it('a payment job whose signed event names a subscription reference is refused', async () => {
    const businessId = await seedBusiness();
    const eventId = await storeChargeSuccess('RKD-SUB-20261108-ABCDEF');
    expect(await events.attributeEvent(workerDb, eventId, businessId)).toBe(true);
    await withBusiness(appDb, businessId, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId,
        kind: 'payment.process',
        payload: { eventId },
        maxAttempts: 1,
      }),
    );
    const job = await jobsRepo.claimNext(workerDb, 'test');
    expect((await jobsRepo.markFailed(workerDb, job!, 'boom', 0)).state).toBe('dead');

    await expect(
      controller().recover(asOperator, job!.id, { reason: 'try now' }),
    ).rejects.toMatchObject({ status: 422 });
    expect((await statusOf(businessId, job!.id))?.status).toBe('open');
    const audit = await auditActions(businessId, job!.id);
    expect(audit.at(-1)).toMatchObject({ new_value: { outcome: 'invalid_reference' } });
  });

  it('a job with no event has no reference to verify: refused, and closable by resolve', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      jobsRepo.enqueue(tx, { businessId, kind: 'payment.process', payload: {}, maxAttempts: 1 }),
    );
    await drainJobs();
    const [job] = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(job?.state).toBe('dead');

    await expect(
      controller().recover(asOperator, job!.id, { reason: 'try now' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await controller().resolve(asOperator, job!.id, { resolution: 'nothing owed' })).toEqual(
      { resolved: true },
    );
    await expect(
      controller().resolve(asOperator, job!.id, { resolution: 'again' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('the generic event resolve refuses an event whose dead job is open, changing nothing', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { eventId, jobId } = await deadPaymentJob(businessId, intent.reference);
    const ops = new OpsController(config, appDb, workerDb, {} as SecurityMetrics);
    await expect(
      ops.resolveException(asOperator, eventId, { resolution: 'not ours' }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await statusOf(businessId, jobId))?.status).toBe('open');
    const queue = await events.exceptionQueue(workerDb);
    expect(queue.flagged.find((row) => row.id === eventId)?.jobId).toBe(jobId);
  });

  it('the operator queue details the job each flagged row names, not an unrelated page', async () => {
    const first = await seedBusiness();
    const a = await deadPaymentJob(first, (await seedObligation(first)).intent.reference);
    const second = await seedBusiness();
    const b = await deadPaymentJob(second, (await seedObligation(second)).intent.reference);
    // A's event is older, but its job died later: an oldest-first page of one finds only B.
    const owner = createDb(urls.owner, { max: 1 });
    await owner.db.execute(
      sql`UPDATE dead_job_exceptions SET opened_at = now() + interval '1 hour' WHERE job_id = ${a.jobId}::uuid`,
    );
    await owner.close();
    const ops = new OpsController(config, appDb, workerDb, {} as SecurityMetrics);
    const answer = await ops.exceptions('1');
    expect(answer.flagged.map((f) => f.jobId)).toEqual([a.jobId]);
    expect(answer.deadJobDetails.map((d) => d.jobId)).toContain(a.jobId);
    expect(answer.deadJobDetails.map((d) => d.jobId)).toContain(b.jobId);
  });

  it('the generic resolve guard holds for an event beyond the first page of the queue', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { eventId, jobId } = await deadPaymentJob(businessId, intent.reference);
    // 200 older flagged events put this one past any first page of the queue.
    const owner = createDb(urls.owner, { max: 1 });
    await owner.db.execute(sql`
      INSERT INTO external_events (provider, event_type, external_id, payload, signature_valid,
                                   error, created_at)
      SELECT 'paystack', 'charge.success', 'older-' || g, '{}'::jsonb, 1, 'flagged',
             now() - interval '1 day'
      FROM generate_series(1, 200) g`);
    await owner.close();
    const ops = new OpsController(config, appDb, workerDb, {} as SecurityMetrics);
    await expect(
      ops.resolveException(asOperator, eventId, { resolution: 'not ours' }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await statusOf(businessId, jobId))?.status).toBe('open');
  });

  it('resolving the job closes its flagged event in the same transaction', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { eventId, jobId } = await deadPaymentJob(businessId, intent.reference);
    expect(
      await controller().resolve(asOperator, jobId, { resolution: 'settled by hand' }),
    ).toEqual({
      resolved: true,
    });
    const queue = await events.exceptionQueue(workerDb);
    expect(queue.flagged.find((row) => row.id === eventId)).toBeUndefined();
  });

  it('refuses a missing reason, a malformed id and an unknown job without changing anything', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { jobId } = await deadPaymentJob(businessId, intent.reference);

    await expect(controller().recover(asOperator, jobId, {})).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      controller().recover(asOperator, 'not-a-uuid', { reason: 'abcd' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller().recover(asOperator, '00000000-0000-4000-8000-000000000000', { reason: 'abcd' }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await statusOf(businessId, jobId))?.status).toBe('open');
  });
});
