/**
 * Shared setup for the job queue suites, split from jobs.integration.test.ts: the app and
 * worker pools over a real PostgreSQL, the stub transport, sender, speech and text extraction,
 * and the enqueue and seeding helpers. Each suite calls useJobsHarness() once at its top
 * level; Vitest gives every test file its own copy of this module.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import {
  conversationsRepo,
  createDb,
  events as eventsRepo,
  identity,
  jobsRepo,
  ordersRepo,
  schema,
  sql,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '@rekoda/db/testing';
import { settlementDb } from '@rekoda/db/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunner, type RunnerDeps } from './jobs.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { StubTextExtraction } from '../ai/ocr.stub.js';
import { StubSpeechToText } from '../ai/stt.stub.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { LocalStorage } from '../documents/r2.storage.js';
import { ReplySender } from '../replies/reply.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';

const RUN_SALT = randomBytes(16).toString('hex');

/** A fresh directory per run, so one suite cannot read another's documents. */
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-docs-'));

export let urls: Urls;
export let appDb: Db;
export let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
export let config: ApiConfig;
/** The real gateway and the real config — `buildRunner` gets what production gets. */
export let deps: RunnerDeps;
export let stubTransport: StubTransport;
export let stubSender: StubSender;
let stubStt: StubSpeechToText;
let stubOcr: StubTextExtraction;

/**
 * Derived per run, never a literal. A high-entropy constant assigned to
 * something named `*_KEY` is indistinguishable from a leaked credential to
 * every scanner pointed at this repository — and generating it is stronger
 * anyway, since no two runs share one.
 */
function testKey(label: string): string {
  return createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
}

export async function seedBusiness(name: string, phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

export function enqueue(businessId: string, kind: string, payload: Record<string, unknown> = {}) {
  return withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, { businessId, kind, payload }),
  );
}

/**
 * Record an attributed event the way the Meta ingress does: inside
 * `withBusiness`, pinned to the tenant it resolved to.
 *
 * Migration 0130 gave `external_events` a tenant policy, so an unpinned
 * insert carrying a `business_id` is refused — correctly. Production never
 * writes one: `meta.service.ts` opens `withBusiness` the moment it has
 * resolved the sender, and only a genuinely unattributed event (a stranger,
 * a Paystack webhook awaiting the pump) goes in without a pin.
 */
export function recordPinned(event: Parameters<typeof eventsRepo.recordEvent>[1]) {
  const { businessId } = event;
  if (!businessId) throw new Error('recordPinned is for attributed events only');
  return withBusiness(appDb, businessId, (tx) => eventsRepo.recordEvent(tx, event));
}

/**
 * Stamp a stored message as reaching Rekoda a minute from now (G-23).
 *
 * A "yes" can confirm only a preview that existed when it arrived: a reply
 * to a preview always reaches Rekoda after the preview was written, because
 * the preview is sent only after its draft is. Tests that enqueue a request
 * and its "yes" together, to prove the lanes keep them in order, model that
 * real arrival here rather than a "yes" sent before anything was shown.
 */
export function arrivesAfterPreview(
  businessId: string,
  stored: Parameters<typeof storedEventId>[0],
) {
  return withBusiness(appDb, businessId, (tx) =>
    tx.execute(sql`
      UPDATE external_events SET created_at = now() + interval '1 minute'
       WHERE id = ${storedEventId(stored)}::uuid`),
  );
}

export function jobsOf(businessId: string) {
  return withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
}

export async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the runner');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function productsOf(businessId: string) {
  // No WHERE clause, deliberately: row-level security is what scopes this, so
  // the assertion below is about the pin rather than about a predicate the
  // test itself supplied.
  return withBusiness(appDb, businessId, (tx) => tx.select().from(schema.products));
}

/**
 * The owner last wrote to the business number `hoursAgo` hours ago (G-67): a
 * recorded inbound message with its timestamp moved back, because the 24-hour
 * service window is measured from it.
 */
let windowSeq = 0;
export async function ownerWroteHoursAgo(businessId: string, hoursAgo: number): Promise<void> {
  windowSeq += 1;
  await withBusiness(appDb, businessId, async (tx) => {
    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: 'hello',
      providerMessageId: `wamid.window-${windowSeq}`,
    });
    await tx.execute(
      sql`UPDATE conversation_messages SET created_at = now() - make_interval(hours => ${hoursAgo}) WHERE id = ${message.id}`,
    );
  });
}

/** A rendered quote, ready for its `document.deliver` job. */
export async function renderedQuote(businessId: string) {
  const quote = await withBusiness(appDb, businessId, (tx) =>
    ordersRepo.createQuote(tx, {
      businessId,
      customerId: null,
      lines: [
        {
          productId: null,
          name: 'Ankara bale',
          quantity: 2,
          unitPriceK: 850_000,
          lineTotalK: 1_700_000,
        },
      ],
      totalK: 1_700_000,
      validUntil: '2026-09-30',
      clientRef: null,
      sourceId: 'test',
    }),
  );
  await enqueue(businessId, 'document.render', {
    quoteId: quote.id,
    customerToken: 'CUSTOMER_7K2',
  });
  const runner = buildRunner(workerDb, appDb, deps);
  expect(await runner.runOnce()).toBe(true); // render
  return { quote, runner };
}

export async function deliveryJob(businessId: string) {
  return withBusiness(appDb, businessId, async (tx) => {
    const [job] = await tx.execute<{ state: string; attempts: number }>(sql`
      SELECT state, attempts FROM jobs
       WHERE business_id = ${businessId}::uuid AND kind = 'document.deliver'
       ORDER BY created_at DESC LIMIT 1`);
    return job;
  });
}

/** Registers the suite hooks; call once at the top level of each suite. */
export function useJobsHarness(): void {
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
    stubTransport = StubTransport.answering({
      intent: 'Unclear',
      clarification: 'How many wigs?',
    });
    stubSender = new StubSender();
    stubStt = new StubSpeechToText();
    stubOcr = new StubTextExtraction();
    deps = {
      settlementDb: settlementDb(),
      gateway: new PrivacyGateway(appDb, config),
      interpreter: new Interpreter(appDb, config, stubTransport),
      replySender: new ReplySender(config, stubSender),
      // A real filesystem storage, not a mock: the render job's assertions are
      // about bytes actually landing somewhere and being readable back.
      storage: new LocalStorage(storageRoot),
      sender: stubSender,
      config,
      paymentProvider: new StubPaymentProvider(),
      paymentIntents: new PaymentIntentsService(config, appDb, new StubPaymentProvider()),
      stt: stubStt,
      ocr: stubOcr,
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
  });
}
