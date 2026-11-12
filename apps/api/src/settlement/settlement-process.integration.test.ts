/**
 * OD-51.2 and OD-51.3 (migration 0217): settlement is a separate process on a separate credential.
 *
 * The general worker reads provider data, renders documents and talks to Meta and the model
 * providers. Until 0217 it also held the settlement credential, and that credential carried every
 * right of the application. These tests hold the boundary from both sides, with the real database
 * roles:
 *
 *   - the settlement process, given ONLY its own credential, the vault key and a payment provider,
 *     settles a verified payment end to end;
 *   - the general worker, with no settlement credential, cannot run a settlement job, and the
 *     database refuses its role every step of doing so by hand;
 *   - the settlement role can do what settling needs and nothing else.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addOnReference, usagePeriod } from '@rekoda/core';
import {
  createDb,
  events,
  identity,
  jobsRepo,
  sql,
  subscriptionsRepo,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import {
  applicationDb,
  migrate,
  requireUrls,
  setPricingSource,
  settlementDb,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTextExtraction } from '../ai/ocr.stub.js';
import { StubSpeechToText } from '../ai/stt.stub.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import { LocalStorage } from '../documents/r2.storage.js';
import { buildRunner, type RunnerDeps } from '../jobs/jobs.module.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { pumpPaystackEvents } from '../payments/paystack-pump.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { sealPayload } from '../privacy/payload-vault.js';
import { ReplySender } from '../replies/reply.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import { startSettlementProcess } from '../settlement-main.js';

const RUN_SALT = randomBytes(16).toString('hex');
const testKey = (label: string) =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
const PACK_K = 250_000;
const PACK_UNITS = 100;

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;
/** The general worker's dependencies: everything it has in production, and no settlement credential. */
let workerDeps: RunnerDeps;
let running: { close: () => Promise<void> } | null = null;

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
  const sender = new StubSender();
  workerDeps = {
    settlementDb: null,
    gateway: new PrivacyGateway(appDb, config),
    interpreter: new Interpreter(appDb, config, StubTransport.answering({ intent: 'Unclear' })),
    replySender: new ReplySender(config, sender),
    storage: new LocalStorage(mkdtempSync(join(tmpdir(), 'rekoda-settlement-'))),
    sender,
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

afterEach(async () => {
  await running?.close();
  running = null;
});

/** Exactly what the settlement service is given in production (docker-compose.prod.yml). */
const settlementEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  PORT: '0',
  SETTLEMENT_DATABASE_URL: urls.settlement,
  VAULT_KEY: config.vaultKey,
  REKODA_SETTLEMENT_CONCURRENCY: '1',
  ...over,
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

async function openPack(businessId: string): Promise<string> {
  const reference = addOnReference(new Date(), (n) => randomBytes(n));
  await withBusiness(applicationDb(), businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind: 'add_on',
      packId: 'messages_100',
      amountK: PACK_K,
      reference,
    }),
  );
  return reference;
}

let nextTransactionId = 8_300_000;
/** A signed Paystack event stored and pumped the way production does: a `billing.process` job. */
async function paymentArrives(reference: string): Promise<void> {
  const transactionId = ++nextTransactionId;
  const body = {
    event: 'charge.success',
    data: {
      id: transactionId,
      reference,
      amount: PACK_K,
      currency: 'NGN',
      status: 'success',
      customer: { email: 'owner@example.com' },
    },
  };
  await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: body.event,
    externalId: `${transactionId}:${body.event}`,
    payload: sealPayload(body, config.vaultKey, 'paystack', `${transactionId}:${body.event}`),
    businessId: null,
  });
  expect(await pumpPaystackEvents({ workerDb, appDb, vaultKey: config.vaultKey })).toBe(1);
}

const chargeOf = async (businessId: string, reference: string) => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ status: string; credited: boolean }>(sql`
      SELECT status, units_credited_at IS NOT NULL AS credited FROM subscription_charges
      WHERE business_id = ${businessId}::uuid AND reference = ${reference}`),
  );
  return [...rows][0]!;
};
const bonusOf = async (businessId: string) => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return rows.find((row) => row.unit === 'AI_ACTIONS')?.bonus ?? 0;
};
const jobsOf = async (businessId: string) => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ id: string; kind: string; state: string; attempts: number }>(sql`
      SELECT id, kind, state, attempts FROM jobs WHERE business_id = ${businessId}::uuid`),
  );
  return [...rows];
};
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const refusal = (run: () => Promise<unknown>): Promise<string> =>
  run().then(
    () => 'allowed',
    (error: { message?: string; cause?: { message?: string } }) =>
      String(error.cause?.message ?? error.message),
  );

describe('the settlement process (OD-51.2)', () => {
  it('settles a verified payment holding only the settlement credential, the vault key and the provider', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, { amountK: PACK_K });
    await paymentArrives(reference);
    expect((await jobsOf(businessId)).map((j) => [j.kind, j.state])).toEqual([
      ['billing.process', 'pending'],
    ]);

    running = await startSettlementProcess(settlementEnv(), provider);

    await until(
      async () => (await chargeOf(businessId, reference)).status === 'paid',
      'the settlement process to settle the charge',
    );
    expect(await chargeOf(businessId, reference)).toEqual({ status: 'paid', credited: true });
    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
    await until(
      async () => (await jobsOf(businessId))[0]?.state === 'done',
      'the settlement job to be marked done',
    );
  });

  it('still asks Paystack: a payment the provider does not confirm is never settled', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    /* No willVerify: the provider knows nothing of this reference. */
    await paymentArrives(reference);

    running = await startSettlementProcess(settlementEnv(), provider);

    await until(
      async () => ((await jobsOf(businessId))[0]?.attempts ?? 0) >= 1,
      'the settlement process to attempt the job',
    );
    expect((await chargeOf(businessId, reference)).status).toBe('pending');
    expect(await bonusOf(businessId)).toBe(0);
  });

  it('answers health on loopback and nothing else', async () => {
    const started = await startSettlementProcess(settlementEnv(), provider);
    running = started;
    const health = await fetch(`http://127.0.0.1:${started.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', process: 'settlement' });
    expect((await fetch(`http://127.0.0.1:${started.port}/v1/businesses/plan`)).status).toBe(404);
  });

  it('refuses to start on any role but rekoda_settlement, or against a different pricing source', async () => {
    for (const url of [urls.app, urls.worker, urls.operator, urls.owner]) {
      await expect(
        startSettlementProcess(settlementEnv({ SETTLEMENT_DATABASE_URL: url }), provider),
      ).rejects.toThrow(/rekoda_settlement|SUPERUSER|BYPASSRLS/);
    }
    /* The database says `catalogue`; a process told to price from the constants must not start. */
    await expect(
      startSettlementProcess(settlementEnv({ REKODA_PLAN_CATALOGUE_READS: '0' }), provider),
    ).rejects.toThrow(/pricing source/i);
    await setPricingSource(urls, 'constants');
    await expect(startSettlementProcess(settlementEnv(), provider)).rejects.toThrow(
      /pricing source/i,
    );
  });
});

describe('the general worker cannot settle (OD-51.2)', () => {
  it('a worker with no settlement credential leaves a settlement job untouched', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, { amountK: PACK_K });
    await paymentArrives(reference);

    const runner = buildRunner(workerDb, appDb, workerDeps);
    expect(await runner.runOnce()).toBe(false);
    expect(await runner.reclaim()).toBe(0);

    expect((await jobsOf(businessId)).map((j) => [j.kind, j.state, j.attempts])).toEqual([
      ['billing.process', 'pending', 0],
    ]);
    expect(await chargeOf(businessId, reference)).toEqual({ status: 'pending', credited: false });
    expect(await bonusOf(businessId)).toBe(0);
  });

  it('the database refuses the worker role every step of settling by hand', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    await paymentArrives(reference);
    const [job] = await jobsOf(businessId);

    /* Claim: even asked for exactly this kind, the worker is given nothing. */
    expect(
      await jobsRepo.claimNext(workerDb, 'worker:by-hand', { only: ['billing.process'] }),
    ).toBeNull();
    /* Complete, fail or steal the job with plain SQL. */
    for (const statement of [
      sql`UPDATE jobs SET state = 'done' WHERE id = ${job!.id}::uuid`,
      sql`UPDATE jobs SET state = 'running', locked_by = 'worker:by-hand', locked_at = now()
          WHERE id = ${job!.id}::uuid`,
      sql`UPDATE jobs SET state = 'failed' WHERE id = ${job!.id}::uuid`,
    ]) {
      const outcome = await refusal(async () => {
        const rows = await withBusiness(workerDb, businessId, (tx) =>
          tx.execute(sql`${statement} RETURNING id`),
        );
        if ([...rows].length > 0) return;
        throw new Error('no row was changed');
      });
      expect(outcome).toMatch(/no row was changed|row-level security|permission denied/);
    }
    expect((await jobsOf(businessId))[0]).toMatchObject({ state: 'pending', attempts: 0 });

    /* Record the payment, credit the pack, or move the plan, as the worker or as the application. */
    for (const db of [workerDb, appDb]) {
      expect(
        await refusal(() =>
          withBusiness(db, businessId, (tx) =>
            tx.execute(sql`UPDATE subscription_charges SET status = 'paid', paid_at = now()
                           WHERE reference = ${reference}`),
          ),
        ),
      ).toMatch(/permission denied|may not|only/i);
      expect(
        await refusal(() =>
          withBusiness(db, businessId, (tx) =>
            tx.execute(sql`SELECT public.usage_credit_pack(${businessId}::uuid, ${reference},
                             ${usagePeriod(new Date())}, 'AI_ACTIONS', 100)`),
          ),
        ),
      ).toMatch(/permission denied/);
      expect(
        await refusal(() =>
          withBusiness(db, businessId, (tx) =>
            tx.execute(sql`UPDATE businesses SET plan = 'complete',
                             plan_expires_at = now() + interval '30 days'
                           WHERE id = ${businessId}::uuid`),
          ),
        ),
      ).toMatch(/permission denied|may not|only/i);
    }
    expect(await chargeOf(businessId, reference)).toEqual({ status: 'pending', credited: false });
    expect(await bonusOf(businessId)).toBe(0);
  });

  it('neither general role can become the settlement role', async () => {
    for (const db of [workerDb, appDb]) {
      expect(await refusal(() => db.execute(sql`SET ROLE rekoda_settlement`))).toMatch(
        /permission denied/,
      );
    }
  });
});

describe('the settlement role holds what settling needs and nothing else (OD-51.3)', () => {
  it('is not the application: no tenant record, no outbox, no session, no customer', async () => {
    const businessId = await seedBusiness();
    for (const table of [
      'customers',
      'invoices',
      'ledger_entries',
      'ledger_transactions',
      'documents',
      'outbox_events',
      'conversation_messages',
      'sessions',
      'users',
      'memberships',
      'payment_intents',
      'usage_counters',
      'usage_reservations',
    ]) {
      expect(
        await refusal(() =>
          withBusiness(settlementDb(), businessId, (tx) =>
            tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} LIMIT 1`),
          ),
        ),
        table,
      ).toMatch(/permission denied/);
    }
    expect(await refusal(() => settlementDb().execute(sql`SET ROLE rekoda_app`))).toMatch(
      /permission denied/,
    );
  });

  it('cannot open a charge, consume a meter, or touch a job that is not its own', async () => {
    const businessId = await seedBusiness();
    expect(
      await refusal(() =>
        withBusiness(settlementDb(), businessId, (tx) =>
          subscriptionsRepo.openCharge(tx, {
            businessId,
            kind: 'add_on',
            packId: 'messages_100',
            amountK: PACK_K,
            reference: addOnReference(new Date(), (n) => randomBytes(n)),
          }),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await refusal(() =>
        withBusiness(settlementDb(), businessId, (tx) =>
          usageRepo.consumeUnit(tx, businessId, usagePeriod(new Date()), 'AI_ACTIONS', 10, 10),
        ),
      ),
    ).toMatch(/permission denied/);

    /* A general job (here an inbound message) is invisible to it, whichever tenant it pins. */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`INSERT INTO jobs (business_id, kind, payload)
                     VALUES (${businessId}::uuid, 'message.inbound', '{}'::jsonb)`),
    );
    expect(await jobsRepo.claimNext(settlementDb(), 'settlement:by-hand')).toBeNull();
    const seen = await withBusiness(settlementDb(), businessId, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM jobs`),
    );
    expect([...seen][0]!.n).toBe(0);
    expect(
      await refusal(() =>
        withBusiness(settlementDb(), businessId, (tx) =>
          tx.execute(sql`INSERT INTO jobs (business_id, kind, payload)
                         VALUES (${businessId}::uuid, 'billing.process', '{}'::jsonb)`),
        ),
      ),
    ).toMatch(/permission denied/);
  });
});
