/**
 * The runner, against a real PostgreSQL (MASTER-PLAN 4.4 #3).
 *
 * `packages/db/src/jobs.integration.test.ts` proves the queue's SQL. This file
 * proves the thing built on top of it: that a handler runs pinned to its job's
 * tenant, that its writes and its completion are one transaction, and that a
 * handler which throws leaves nothing behind.
 *
 * The runner is built with `buildRunner` — the same function `main.ts` calls —
 * so a handler that exists in the deploy and not in the test registry is not a
 * thing that can happen.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, jobsRepo, schema, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { JobRunner } from './runner.js';
import { buildRunner } from './jobs.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { ReplySender } from '../replies/reply.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import type { InboundMessageDeps } from './inbound-message.handler.js';

const RUN_SALT = randomBytes(16).toString('hex');

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
/** The real gateway and the real config — `buildRunner` gets what production gets. */
let deps: InboundMessageDeps;
let stubTransport: StubTransport;
let stubSender: StubSender;

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
  deps = {
    gateway: new PrivacyGateway(appDb, config),
    interpreter: new Interpreter(appDb, config, stubTransport),
    replySender: new ReplySender(config, stubSender),
    config,
  };
});

/**
 * Derived per run, never a literal. A high-entropy constant assigned to
 * something named `*_KEY` is indistinguishable from a leaked credential to
 * every scanner pointed at this repository — and generating it is stronger
 * anyway, since no two runs share one.
 */
function testKey(label: string): string {
  return createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
}

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(name: string, phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

function enqueue(businessId: string, kind: string, payload: Record<string, unknown> = {}) {
  return withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, { businessId, kind, payload }),
  );
}

function jobsOf(businessId: string) {
  return withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the runner');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function productsOf(businessId: string) {
  // No WHERE clause, deliberately: row-level security is what scopes this, so
  // the assertion below is about the pin rather than about a predicate the
  // test itself supplied.
  return withBusiness(appDb, businessId, (tx) => tx.select().from(schema.products));
}

describe('a handler runs pinned to its job`s tenant', () => {
  it('writes into the right business without being told which', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    const bola = await seedBusiness('Bola Electronics', '+2348050000002');
    await enqueue(ada, 'test.write');

    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.write', async ({ tx, businessId }) => {
      // The handler receives `tx`, already pinned, and has no other handle.
      await tx.insert(schema.products).values({ businessId, name: 'wig', unitPriceK: 1 });
    });

    expect(await runner.runOnce()).toBe(true);
    expect(await productsOf(ada)).toHaveLength(1);
    expect(await productsOf(bola)).toHaveLength(0);
    expect((await jobsOf(ada))[0]).toMatchObject({ state: 'done' });
  });

  it('is refused by the database when it writes into another tenant', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    const bola = await seedBusiness('Bola Electronics', '+2348050000002');
    await enqueue(ada, 'test.smuggle', { target: bola });

    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.smuggle', async ({ tx, payload }) => {
      // A handler doing exactly what a compromised or careless one would.
      await tx
        .insert(schema.products)
        .values({ businessId: payload['target'] as string, name: 'smuggled', unitPriceK: 1 });
    });

    await runner.runOnce();

    expect(await productsOf(bola)).toHaveLength(0);
    // Not silently swallowed either — it is a failed job with a reason.
    const [job] = await jobsOf(ada);
    expect(job).toMatchObject({ state: 'pending', attempts: 1 });
    expect(job!.lastError).toMatch(/row-level security|permission/i);
  });

  it('records WHY a job failed, never the statement or its parameters', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.constraint');

    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.constraint', async ({ tx, businessId }) => {
      await tx
        .insert(schema.products)
        .values({ businessId, name: 'first', unitPriceK: 1, externalCatalogueId: 'CAT-1' });
      // Same catalogue id, so the unique index rejects it — and the bound
      // parameters of the rejected statement include the name below.
      await tx.insert(schema.products).values({
        businessId,
        name: 'Adaeze Okonkwo — 08031234567',
        unitPriceK: 1,
        externalCatalogueId: 'CAT-1',
      });
    });

    await runner.runOnce();
    const error = (await jobsOf(ada))[0]!.lastError ?? '';

    /**
     * `last_error` is a plaintext column outside the vault, and drizzle's
     * wrapper message is `Failed query: <sql>\nparams: <every bound value>`.
     * Stored verbatim, a handler carrying a merchant's message would write its
     * customer's name and number here — past the privacy gateway, in a column
     * nothing redacts. The reason is kept; the row is not.
     */
    expect(error).toMatch(/duplicate key|unique constraint/i);
    expect(error).not.toMatch(/insert into/i);
    expect(error).not.toContain('Adaeze');
    expect(error).not.toContain('08031234567');
  });
});

describe('a job and its effects are one transaction', () => {
  it('leaves NOTHING behind when the handler throws half way', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.explode');

    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.explode', async ({ tx, businessId }) => {
      await tx.insert(schema.products).values({ businessId, name: 'half-written', unitPriceK: 1 });
      throw new Error('provider refused the message');
    });

    await runner.runOnce();

    // The row the handler wrote before throwing is gone. Without this, a
    // retried job would double every write it managed before failing.
    expect(await productsOf(ada)).toHaveLength(0);
    expect((await jobsOf(ada))[0]).toMatchObject({
      state: 'pending',
      attempts: 1,
      lastError: 'provider refused the message',
    });
  });

  it('does not re-run a job whose handler already succeeded', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.count');

    let runs = 0;
    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.count', async () => {
      runs++;
    });

    expect(await runner.runOnce()).toBe(true);
    expect(await runner.runOnce()).toBe(false);
    expect(runs).toBe(1);
  });
});

describe('a job kind nobody handles', () => {
  it('dies on the first attempt instead of retrying five times', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.removed-in-a-deploy');

    const runner = new JobRunner(workerDb, appDb);
    await runner.runOnce();

    // Backing off five times cannot make a missing handler appear; it only
    // delays the moment someone reads the error.
    const [job] = await jobsOf(ada);
    expect(job).toMatchObject({ state: 'dead', attempts: 1 });
    expect(job!.lastError).toMatch(/no handler registered/);
  });
});

describe('the polling loop', () => {
  it('picks work up on its own and stops when asked', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.polled');

    const done: string[] = [];
    const runner = new JobRunner(workerDb, appDb, { idleMs: 20 });
    runner.register('test.polled', async ({ businessId }) => {
      done.push(businessId);
    });

    // `start()` is what the deploy calls; `runOnce()` is what every other test
    // here calls. Without this one, the loop that actually runs in production
    // is the only part of the runner nothing exercises.
    runner.start();
    await waitFor(() => done.length === 1);
    await runner.stop();

    expect(done).toEqual([ada]);
    expect((await jobsOf(ada))[0]).toMatchObject({ state: 'done' });

    // Stopped means stopped: work queued afterwards stays queued.
    await enqueue(ada, 'test.polled');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toHaveLength(1);
  });
});

describe('the registry the application actually ships', () => {
  it('handles the inbound-message kind', async () => {
    const runner = buildRunner(workerDb, appDb, deps);
    // Registering it twice throws, which is how we know it is already there —
    // a registry assertion that cannot pass by reading a stale export.
    expect(() => runner.register('inbound.message', async () => {})).toThrow(/already registered/);
  });

  it('returns false rather than spinning when the queue is empty', async () => {
    const runner = buildRunner(workerDb, appDb, deps);
    expect(await runner.runOnce()).toBe(false);
  });
});
