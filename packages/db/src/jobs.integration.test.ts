/**
 * The queue, against a real PostgreSQL (MASTER-PLAN §5.3.1, 4.4 #3).
 *
 * Everything here is a claim about concurrency or about a policy, and neither
 * has a meaningful in-memory imitation: `FOR UPDATE SKIP LOCKED` behaves like
 * an ordinary SELECT until two transactions actually collide, and a row-level
 * security policy is not code we could mock without mocking the thing under
 * test.
 *
 * Two roles, two pools. `rekoda_worker` is the only credential
 * allowed to claim; `rekoda_app` is what the API holds. Running the whole file
 * as one role would make the last describe block below pass for the wrong
 * reason.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createLockClient, withBusiness, type Db, type LockClient } from './client.js';
import { identity, jobsRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let lock: LockClient;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let closeLock: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 8 }));
  // Eight connections, because the point of the claim test is eight workers
  // colliding. On a pool of one they would queue politely and prove nothing.
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 8 }));
  ({ client: lock, close: closeLock } = createLockClient(urls.worker, 8));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
  await closeLock?.();
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

function enqueue(businessId: string, input: Partial<jobsRepo.EnqueueInput> = {}) {
  return withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, { businessId, kind: 'inbound.message', ...input }),
  );
}

describe('claiming', () => {
  it('hands one job to exactly one of eight simultaneous workers', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await enqueue(businessId);

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => jobsRepo.claimNext(workerDb, `worker-${i}`)),
    );

    const won = claims.filter((c) => c !== null);
    expect(won).toHaveLength(1);
    expect(won[0]!.businessId).toBe(businessId);
    expect(won[0]!.attempts).toBe(1);
  });

  it('gives four workers four different jobs rather than making them queue', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await Promise.all([
      enqueue(businessId),
      enqueue(businessId),
      enqueue(businessId),
      enqueue(businessId),
    ]);

    const claims = await Promise.all(
      Array.from({ length: 4 }, (_, i) => jobsRepo.claimNext(workerDb, `worker-${i}`)),
    );

    const ids = claims.filter((c) => c !== null).map((c) => c!.id);
    // SKIP LOCKED is what makes this four rather than one-then-three-nulls.
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('does not hand out a job whose time has not come', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await enqueue(businessId, { delayMs: 60_000 });
    expect(await jobsRepo.claimNext(workerDb, 'worker')).toBeNull();
  });

  it('carries the payload through unchanged', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await enqueue(businessId, { payload: { eventId: 'abc', nested: { n: 1 } } });
    const claimed = await jobsRepo.claimNext(workerDb, 'worker');
    expect(claimed?.payload).toEqual({ eventId: 'abc', nested: { n: 1 } });
  });
});

describe('the singleton key', () => {
  it('collapses a second enqueue of work that is already queued', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');

    const first = await enqueue(businessId, { singletonKey: 'event-1' });
    const second = await enqueue(businessId, { singletonKey: 'event-1' });

    expect(first).not.toBeNull();
    // Not an error: the caller asked for work that is already going to happen.
    expect(second).toBeNull();
  });

  it('still collapses while the job is RUNNING, not only while pending', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await enqueue(businessId, { singletonKey: 'event-1' });
    await jobsRepo.claimNext(workerDb, 'worker');

    // The window this closes: a retry arriving mid-run would otherwise queue a
    // second job that does the work all over again.
    expect(await enqueue(businessId, { singletonKey: 'event-1' })).toBeNull();
  });

  it('allows the same key again once the job is finished', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await enqueue(businessId, { singletonKey: 'event-1' });
    const claimed = await jobsRepo.claimNext(workerDb, 'worker');
    await withBusiness(appDb, businessId, (tx) => jobsRepo.markDone(tx, claimed!.id));

    expect(await enqueue(businessId, { singletonKey: 'event-1' })).not.toBeNull();
  });

  it('does not confuse two businesses asking for the same key', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348040000001');
    const bola = await seedBusiness('Bola Electronics', '+2348040000002');

    expect(await enqueue(ada, { singletonKey: 'event-1' })).not.toBeNull();
    expect(await enqueue(bola, { singletonKey: 'event-1' })).not.toBeNull();
  });
});

describe('failure and retry', () => {
  it('returns a failed job to the queue, but later', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await enqueue(businessId);
    const job = await jobsRepo.claimNext(workerDb, 'worker');

    const outcome = await jobsRepo.markFailed(workerDb, job!, 'provider timed out');
    expect(outcome.state).toBe('pending');

    // Immediately claimable would be a hot loop against whatever just failed.
    expect(await jobsRepo.claimNext(workerDb, 'worker')).toBeNull();
  });

  it('gives up after maxAttempts and keeps the reason', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await enqueue(businessId, { maxAttempts: 2 });

    for (let i = 0; i < 2; i++) {
      const job = await jobsRepo.claimNext(workerDb, 'worker');
      expect(job).not.toBeNull();
      const outcome = await jobsRepo.markFailed(workerDb, job!, `attempt ${i + 1} failed`, 0);
      expect(outcome.state).toBe(i === 1 ? 'dead' : 'pending');
    }

    const rows = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'dead', attempts: 2, lastError: 'attempt 2 failed' });

    // A dead job stays dead. Nothing sweeps it back in.
    expect(await jobsRepo.claimNext(workerDb, 'worker')).toBeNull();
  });

  it('backs off exponentially and stops at the cap', () => {
    expect(jobsRepo.backoffMs(1)).toBe(2_000);
    expect(jobsRepo.backoffMs(2)).toBe(4_000);
    expect(jobsRepo.backoffMs(5)).toBe(32_000);
    expect(jobsRepo.backoffMs(50)).toBe(300_000);
  });
});

describe('a worker that dies mid-job', () => {
  it('leaves the job stuck until it is reclaimed, then runs it again', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await enqueue(businessId);
    const job = await jobsRepo.claimNext(workerDb, 'worker-that-died');
    expect(job).not.toBeNull();

    // Nothing else will ever look at it: the claim query only reads `pending`.
    expect(await jobsRepo.claimNext(workerDb, 'worker-2')).toBeNull();

    // Age the lock rather than waiting five minutes for it.
    await workerDb.execute(
      sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${job!.id}::uuid`,
    );

    expect(await jobsRepo.reclaimStalled(workerDb, 300_000)).toBe(1);
    const reclaimed = await jobsRepo.claimNext(workerDb, 'worker-2');
    expect(reclaimed?.id).toBe(job!.id);
    // The attempt already spent still counts, so a job that kills its worker
    // every time reaches `dead` instead of looping forever.
    expect(reclaimed?.attempts).toBe(2);
  });

  it('does not reclaim a job whose worker is still alive', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await enqueue(businessId);
    await jobsRepo.claimNext(workerDb, 'busy-worker');
    expect(await jobsRepo.reclaimStalled(workerDb, 300_000)).toBe(0);
  });
});

describe('the queue is inside the tenancy perimeter, not beside it', () => {
  it('REFUSES to let the application role claim anything at all', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348040000001');
    await enqueue(businessId);

    /**
     * The load-bearing assertion of this whole design.
     *
     * `claimNext` is not a privileged code path, it is a privileged
     * CREDENTIAL. Run with the API's role there is no policy that matches an
     * unpinned transaction, so the queue looks empty — the API cannot reach
     * another tenant's work even if some future handler asks it to.
     *
     * If this ever returns a job, `worker_claim` has been granted too widely
     * and every other test in this file is describing a system we no longer
     * have.
     */
    expect(await jobsRepo.claimNext(appDb, 'the-api')).toBeNull();

    // …and the worker, holding the right credential, gets it immediately.
    expect(await jobsRepo.claimNext(workerDb, 'the-worker')).not.toBeNull();
  });

  it('shows a business its own jobs and nobody else`s', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348040000001');
    const bola = await seedBusiness('Bola Electronics', '+2348040000002');
    await enqueue(ada, { payload: { whose: 'ada' } });
    await enqueue(bola, { payload: { whose: 'bola' } });

    const adaRows = await withBusiness(appDb, ada, (tx) => jobsRepo.jobsForBusiness(tx));
    const bolaRows = await withBusiness(appDb, bola, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(adaRows).toHaveLength(1);
    expect(bolaRows).toHaveLength(1);
    expect(adaRows[0]!.id).not.toBe(bolaRows[0]!.id);
  });

  it('refuses an enqueue for a tenant other than the pinned one', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348040000001');
    const bola = await seedBusiness('Bola Electronics', '+2348040000002');

    // WITH CHECK, not USING: without it a tenant could insert work into
    // another tenant's queue and never see the row it created.
    await expect(
      withBusiness(appDb, ada, (tx) =>
        jobsRepo.enqueue(tx, { businessId: bola, kind: 'inbound.message' }),
      ),
    ).rejects.toThrow();
  });
});

describe('runExclusively — a leader per name, and no pool deadlock (H7a)', () => {
  it('serialises same-name work: one leader runs, the others skip', async () => {
    let running = 0;
    let maxConcurrent = 0;
    let ran = 0;

    const attempt = () =>
      jobsRepo.runExclusively(lock, 'contended', async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        ran += 1;
        // A real query on the SAME pool, mid-lock: proves the lock is not
        // holding the only connection the body needs.
        await workerDb.execute(sql`SELECT pg_sleep(0.05)`);
        running -= 1;
      });

    await Promise.all(Array.from({ length: 6 }, attempt));

    // The losers returned quietly rather than erroring or blocking.
    expect(maxConcurrent).toBe(1);
    expect(ran).toBeGreaterThanOrEqual(1);
  });

  it('runs many DISTINCT-name sweeps at once on a tiny pool without deadlocking', async () => {
    // A pool of two is the shape that made the old transaction-wrapped lock
    // deadlock: each holder pinned a connection while its body needed
    // another. Four concurrent leaders, each doing a query inside the lock,
    // must all finish.
    // A working pool of two AND a lock pool of two: the old shape wrapped the
    // body in a transaction on the working pool and deadlocked here. The
    // separate lock pool means the four leaders' locks never touch the two
    // connections their bodies run on.
    const { db: tinyWork, close: closeWork } = createDb(urls.worker, { max: 2 });
    const { client: tinyLock, close: closeTinyLock } = createLockClient(urls.worker, 2);
    try {
      const done: string[] = [];
      const sweep = (name: string) =>
        jobsRepo.runExclusively(tinyLock, name, async () => {
          await tinyWork.execute(sql`SELECT pg_sleep(0.05)`);
          done.push(name);
        });

      // Would hang (and fail the test timeout) under the old shape.
      await Promise.all([sweep('a'), sweep('b'), sweep('c'), sweep('d')]);
      expect(done.sort()).toEqual(['a', 'b', 'c', 'd']);
    } finally {
      await closeWork();
      await closeTinyLock();
    }
  });
});
