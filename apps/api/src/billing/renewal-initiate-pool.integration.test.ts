/**
 * The application pool under the blocked-renewal initiation's nested transactions, at runtime
 * (Codex review of PR #432, discussion_r4611348834; owner instruction, 18 Nov 2026, §4.3).
 *
 * `JobRunner.runOnce` holds one application transaction per lane for the whole job, and the
 * `billing.renewal_initiate` handler asks `BillingCheckoutService.checkout` for a payment, which
 * opens its own transactions on the SAME pool while the lane's transaction stays open. With the
 * pool as large as the lanes (the fixed 10 at 10 lanes), every connection can be held by a lane
 * waiting for one more: a circular wait only PostgreSQL's idle-in-transaction timeout ends, by
 * killing the lanes. `appPoolSize` now gives a worker process `max(10, lanes + 2)`.
 *
 * Both runs below use the real runner, the real handler, the real checkout path and real
 * PostgreSQL connections; only Paystack is the stub provider. The order is forced, not slept:
 *   1. every lane is held at a barrier INSIDE its runner transaction until all ten hold one;
 *   2. each nested checkout transaction that obtains a connection is held until all ten lanes
 *      have asked for one, so the nested requests genuinely contend for what is left of the pool.
 * The fixed pool of 10 is observed wedged in exactly that circular wait (ten lane transactions idle
 * in transaction in `pg_stat_activity`, ten nested requests, none served) and no job completes on
 * the attempt; the current size completes every job, one Paystack session each, after observing
 * the contention (two nested transactions served, eight queued). Each pool carries its own
 * `application_name`, and its idle-in-transaction timeout bounds the wedged run.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptFacet } from '@rekoda/core/vault';
import { createDb, identity, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  setPricingSource,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { appPoolSize } from '../db/db.module.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { initiateBlockedRenewalHandler } from '../jobs/initiate-blocked-renewal.handler.js';
import { JobRunner, type JobHandler } from '../jobs/runner.js';
import { sweepRenewals } from './renewal-sweep.js';

const DAY = 86_400_000;
const LANES = 10;
/** Kills a wedged lane's transaction; far longer than any healthy step here takes. */
const IDLE_IN_TX_MS = 4_000;
const LIVE = ['sk', 'live', 'q'.repeat(24)].join('_');
const TEST = ['sk', 'test', 'q'.repeat(24)].join('_');
const RUN_SALT = randomBytes(16).toString('hex');
const testKey = (label: string): string =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');

let urls: Urls;
let db: Db;
let workerDb: Db;
const closers: Array<() => Promise<void>> = [];
let config: ApiConfig;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, max, set] of [
    [urls.app, 4, (d: Db) => (db = d)],
    [urls.worker, 4, (d: Db) => (workerDb = d)],
  ] as const) {
    const handle = createDb(url, { max });
    set(handle.db);
    closers.push(handle.close);
  }
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = {
    ...loadConfig(),
    paystackSecretKey: TEST,
    paystackPlatformConfirmed: false,
    webUrl: 'https://app.example.ng',
    planCatalogueReads: false,
  };
});

afterAll(async () => {
  for (const close of closers) await close();
});

beforeEach(async () => {
  await truncateAll(urls);
  await setPricingSource(urls, 'constants');
});

const gated = (paystackSecretKey: string) => ({
  planCatalogueReads: false,
  paystackSecretKey,
  paystackPlatformConfirmed: false,
});

let phoneSeq = 0;
/** A business whose paid Chat month ended a day ago, its renewal blocked and then unblocked, with
 * a billing email: one `billing.renewal_initiate` job queued for it. */
async function blockedRenewal(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    db,
    `+23481950000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const renewsAt = new Date(Date.now() - DAY);
  await withBusiness(db, business.id, async (tx) => {
    await applyFixtureCycle(tx, business.id, {
      plan: 'chat',
      cycleStartedAt: new Date(renewsAt.getTime() - 30 * DAY),
      renewsAt,
      anchorDay: renewsAt.getUTCDate(),
    });
    await subscriptionsRepo.setBillingEmailSealed(
      tx,
      business.id,
      encryptFacet('ada@shop.example.ng', config.vaultKey, `billing-email:${business.id}`),
      new Date(),
    );
  });
  return business.id;
}

/** Resolves once `count()` reaches `n`; checked on every `bump()`. */
function threshold(n: number) {
  let count = 0;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (open = resolve));
  return {
    reached,
    bump: () => {
      count += 1;
      if (count >= n) open();
    },
    count: () => count,
  };
}

/** The handler's own pool, seen from the outside: how many nested transactions were asked for and
 * how many obtained a connection. Every transaction that obtains one is held there until the test
 * calls `release()` (barrier 2), so the snapshot of the contention is taken while it lasts. */
function watchedPool(pool: Db, lanes: number) {
  const asked = threshold(lanes);
  let served = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const watched = new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return (body: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => {
        asked.bump();
        return (target.transaction as (...a: unknown[]) => Promise<unknown>)(
          async (tx: unknown) => {
            served += 1;
            await released;
            return body(tx);
          },
          ...rest,
        );
      };
    },
  });
  return { watched, asked, served: () => served, release };
}

/** Wait (bounded) until `ready()`. */
async function until(ready: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never: ${what}`);
}

async function idleInTransaction(applicationName: string): Promise<number> {
  const rows = await withBusiness(db, '00000000-0000-0000-0000-000000000000', (tx) =>
    tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = ${applicationName} AND state = 'idle in transaction'`),
  );
  return [...rows][0]!.n;
}
const jobStates = async (businessIds: string[]) => {
  const states: string[] = [];
  for (const businessId of businessIds) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM jobs
        WHERE business_id = ${businessId}::uuid AND kind = 'billing.renewal_initiate'`),
    );
    states.push(...[...rows].map((r) => r.state));
  }
  return states.sort();
};
const liveAttempts = async (businessIds: string[]) => {
  let n = 0;
  for (const businessId of businessIds) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM subscription_charge_attempts
        WHERE business_id = ${businessId}::uuid AND status = 'active'`),
    );
    n += [...rows][0]!.n;
  }
  return n;
};

/** Ten lanes of the real runner over `poolSize` application connections. */
async function runTenLanes(poolSize: number, applicationName: string) {
  const businessIds: string[] = [];
  for (let i = 0; i < LANES; i += 1) businessIds.push(await blockedRenewal());
  await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) }); // raised while blocked
  await sweepRenewals({ workerDb, appDb: db, config: gated(TEST) }); // unblocked: jobs queued
  expect(await jobStates(businessIds)).toEqual(Array(LANES).fill('pending'));

  const url = new URL(urls.app);
  url.searchParams.set('application_name', applicationName);
  const app = createDb(url.toString(), { max: poolSize, idleInTxTimeoutMs: IDLE_IN_TX_MS });
  closers.push(app.close);
  const pool = watchedPool(app.db, LANES);
  const provider = new StubPaymentProvider();
  const real = initiateBlockedRenewalHandler({ config, appDb: pool.watched, provider });
  const lanesIn = threshold(LANES);
  /* Barrier 1: inside the runner's own transaction, until all ten lanes hold one. */
  const handler: JobHandler = async (context) => {
    lanesIn.bump();
    await lanesIn.reached;
    await real(context);
  };
  const runner = new JobRunner(workerDb, app.db, {
    claim: { only: ['billing.renewal_initiate'] },
  }).register('billing.renewal_initiate', handler);

  const runs = Promise.all(Array.from({ length: LANES }, () => runner.runOnce()));
  await lanesIn.reached;
  await pool.asked.reached; // all ten lanes have asked for their nested transaction
  /* Ten lane transactions hold ten connections; whatever the pool has beyond them serves nested
   * transactions, which are held. Wait until it does (the spare connections open lazily); a pool
   * of ten has nothing beyond them, and ten idle lane transactions mean none can open. */
  const spare = poolSize - LANES;
  await until(
    async () =>
      pool.served() >= spare && (await idleInTransaction(applicationName)) === LANES + spare,
    `${LANES} lane and ${spare} nested transactions open`,
  );
  const atContention = { served: pool.served(), idle: await idleInTransaction(applicationName) };
  pool.release();
  await runs;
  return {
    atContention,
    states: await jobStates(businessIds),
    sessions: provider.initialized.length,
    live: await liveAttempts(businessIds),
  };
}

describe('the blocked-renewal initiation under application-pool pressure (ten lanes)', () => {
  it('a pool as large as the lanes (the fixed 10) wedges in a circular wait and completes nothing', async () => {
    const result = await runTenLanes(10, 'pool-starvation-fixed-10');
    /* Ten lane transactions hold all ten connections, idle, each waiting for an eleventh. */
    expect(result.atContention).toEqual({ served: 0, idle: LANES });
    /* Worse than a stall: once the timeout freed connections, the queued nested checkouts ran for
     * lanes already dead and opened Paystack sessions whose jobs then failed. The database still
     * kept at most one live session per charge (the retry hands it back), but the run did no
     * normal work. */
    expect(result.live).toBeLessThanOrEqual(LANES);
    /* Only the idle-in-transaction timeout ended it: every lane was killed, none committed, so
     * each job is back in the queue for a retry (or recorded as failed), never done. */
    expect(result.states.filter((s) => s === 'done')).toEqual([]);
  }, 60_000);

  it('the worker sizing, max(10, lanes + 2), completes every job with one Paystack session each', async () => {
    const size = appPoolSize({ workerEnabled: true, workerConcurrency: LANES });
    expect(size).toBe(12);
    const result = await runTenLanes(size, 'pool-starvation-sized-12');
    /* The same contention: ten lanes hold ten connections, the two left serve two nested
     * transactions (held, so twelve are idle in transaction), the other eight wait for them. */
    expect(result.atContention).toEqual({ served: 2, idle: LANES + 2 });
    expect(result.states).toEqual(Array(LANES).fill('done'));
    expect(result.sessions).toBe(LANES);
    expect(result.live).toBe(LANES);
  }, 60_000);
});
