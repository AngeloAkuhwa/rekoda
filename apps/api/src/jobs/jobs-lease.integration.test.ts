/**
 * The runner, against a real PostgreSQL (MASTER-PLAN 4.4 #3).
 *
 * `packages/db/src/ops/jobs.integration.test.ts` proves the queue's SQL. These suites
 * prove the thing built on top of it: that a handler runs pinned to its job's
 * tenant, that its writes and its completion are one transaction, and that a
 * handler which throws leaves nothing behind.
 *
 * The runner is built with `buildRunner` — the same function `main.ts` calls —
 * so a handler that exists in the deploy and not in the test registry is not a
 * thing that can happen.
 */
// The job queue and its handlers, end to end. Split by concern across jobs*.integration.test.ts; the shared setup is in
// jobs.fixtures.ts.
import { describe, expect, it, vi } from 'vitest';
import { ownerDb } from '@rekoda/db/testing';
import { jobsRepo, schema, sql, withBusiness } from '@rekoda/db';
import { Logger } from '@nestjs/common';
import { JobDeferred, JobRunner } from './runner.js';
import {
  appDb,
  enqueue,
  jobsOf,
  productsOf,
  seedBusiness,
  waitFor,
  workerDb,
  useJobsHarness,
} from './jobs.fixtures.js';

useJobsHarness();

describe('a busy queue still recovers abandoned jobs (G-10)', () => {
  /**
   * The reclaim clock used to advance only on empty polls, so a queue that
   * never went idle never gave back the job a crashed worker had abandoned.
   * Here the queue stays busy for over a second; the abandoned job must be
   * recovered while that work is still running.
   */
  it('reclaims a stranded job while other jobs keep the runner busy', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.stranded');
    const stranded = await jobsRepo.claimNext(workerDb, 'dead-worker');
    expect(stranded?.kind).toBe('test.stranded');

    const BUSY_JOBS = 40;
    for (let i = 0; i < BUSY_JOBS; i += 1) await enqueue(ada, 'test.busy');

    let busyDone = 0;
    let busyDoneWhenRecovered: number | null = null;
    const runner = new JobRunner(workerDb, appDb, { idleMs: 10, stalledAfterMs: 150 });
    runner.register('test.busy', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      busyDone += 1;
    });
    runner.register('test.stranded', async () => {
      busyDoneWhenRecovered = busyDone;
    });

    runner.start();
    try {
      await waitFor(() => busyDoneWhenRecovered !== null);
    } finally {
      await runner.stop();
    }
    expect(busyDoneWhenRecovered).not.toBeNull();
    expect(busyDoneWhenRecovered!).toBeLessThan(BUSY_JOBS);
  });
});

describe('a long-running handler keeps its lease (G-10)', () => {
  /**
   * `reclaimStalled` hands a job to another worker once it has been untouched
   * for the stall window. A handler that legitimately outlives that window
   * (a slow upload) must not look like a crashed worker, or two workers run
   * the same job. The runner renews the lease while the handler runs.
   */
  it('is not reclaimed while its handler is still running', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.slow');

    let reclaimedMidRun: number | null = null;
    let finished = false;
    const runner = new JobRunner(workerDb, appDb, { idleMs: 10, stalledAfterMs: 150 });
    runner.register('test.slow', async () => {
      // Outlives the 150 ms stall window more than twice over.
      await new Promise((resolve) => setTimeout(resolve, 350));
      reclaimedMidRun = await jobsRepo.reclaimStalled(workerDb, 150);
      await new Promise((resolve) => setTimeout(resolve, 100));
      finished = true;
    });

    expect(await runner.runOnce()).toBe(true);
    expect(finished).toBe(true);
    expect(reclaimedMidRun).toBe(0);
    expect((await jobsOf(ada))[0]).toMatchObject({ state: 'done', attempts: 1 });
  });
});

describe('an attempt that lost its job cannot commit (G-10)', () => {
  /**
   * A job reclaimed and claimed again while its first attempt is still
   * running has two live attempts. Only the one holding the claim may finish:
   * the other's completion fails, its transaction rolls back with every write
   * the handler made, and the live attempt's state is left alone.
   */
  it('rolls back a stale attempt and leaves the new claim intact', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.stale');

    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.stale', async ({ tx, businessId }) => {
      await tx.insert(schema.products).values({ businessId, name: 'duplicate', unitPriceK: 1 });
      // While this attempt runs, the job is reclaimed and taken by someone else.
      await jobsRepo.reclaimStalled(workerDb, 0);
      const taken = await jobsRepo.claimNext(workerDb, 'the-new-owner');
      expect(taken?.kind).toBe('test.stale');
    });

    expect(await runner.runOnce()).toBe(true);

    // The stale attempt's write did not commit...
    expect(await productsOf(ada)).toHaveLength(0);
    // ...and it did not clobber the new owner's claim.
    const [job] = await jobsOf(ada);
    expect(job).toMatchObject({ state: 'running', attempts: 2 });
  });
});

describe('a stale attempt cannot fail or defer the live claim either (G-10)', () => {
  async function staleThen(failWith: () => unknown) {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.stale');
    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.stale', async () => {
      await jobsRepo.reclaimStalled(workerDb, 0);
      const taken = await jobsRepo.claimNext(workerDb, 'the-new-owner');
      expect(taken?.kind).toBe('test.stale');
      throw failWith();
    });
    expect(await runner.runOnce()).toBe(true);
    return (await jobsOf(ada))[0];
  }

  it('a stale attempt that throws does not mark the live claim failed', async () => {
    const job = await staleThen(() => new Error('the stale attempt blew up'));
    expect(job).toMatchObject({ state: 'running', attempts: 2 });
  });

  it('a stale attempt that defers does not requeue the live claim', async () => {
    const job = await staleThen(() => new JobDeferred(1_000));
    expect(job).toMatchObject({ state: 'running', attempts: 2 });
  });
});

describe('reclaim does not depend on a free lane (G-10)', () => {
  /**
   * A worker restarted more often than the stall window would otherwise never
   * reclaim what its predecessor abandoned. The stall window here is a minute,
   * the abandoned claim an hour old: only the pass at start can recover it
   * within the test's timeout.
   */
  it('reclaims a long-abandoned job at start, not a stall window later', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.long-abandoned');
    const claimed = await jobsRepo.claimNext(workerDb, 'dead-worker');
    expect(claimed?.kind).toBe('test.long-abandoned');
    /* As the owner: the application may not age a running job's lease (0220). */
    await withBusiness(ownerDb(), ada, (tx) =>
      tx.execute(
        sql`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = ${claimed!.id}::uuid`,
      ),
    );

    let ran = false;
    const runner = new JobRunner(workerDb, appDb, { idleMs: 10, stalledAfterMs: 60_000 });
    runner.register('test.long-abandoned', async () => {
      ran = true;
    });

    runner.start();
    try {
      await waitFor(() => ran);
    } finally {
      await runner.stop();
    }
    expect(ran).toBe(true);
  });

  it('stop() waits for a reclaim pass that is still running', async () => {
    const runner = new JobRunner(workerDb, appDb, { idleMs: 10, stalledAfterMs: 60_000 });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    vi.spyOn(runner, 'reclaim').mockImplementation(async () => {
      await gate;
      finished = true;
      return 0;
    });
    runner.start();
    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
  });

  it('an unknown-kind claim that was lost is discarded, not marked dead', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.no-handler');
    const claimed = await jobsRepo.claimNext(workerDb, 'the-live-owner');
    expect(claimed?.kind).toBe('test.no-handler');
    const runner = new JobRunner(workerDb, appDb);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      // A stale attempt names a token that no longer owns the claim.
      await (
        runner as unknown as {
          retireUnknownKind(job: unknown, claimedBy: string): Promise<void>;
        }
      ).retireUnknownKind(claimed, 'the-stale-attempt');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lost its lease'));
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    expect((await jobsOf(ada))[0]).toMatchObject({ state: 'running' });
  });

  it('requeues an abandoned job while the only lane sits in a slow handler', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.abandoned');
    const abandoned = await jobsRepo.claimNext(workerDb, 'dead-worker');
    expect(abandoned?.kind).toBe('test.abandoned');
    await enqueue(ada, 'test.hang');

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new JobRunner(workerDb, appDb, { idleMs: 10, stalledAfterMs: 150 });
    runner.register('test.hang', async () => {
      await gate;
    });
    runner.register('test.abandoned', async () => {});

    runner.start();
    try {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const rows = await jobsOf(ada);
        const row = rows.find((j) => j.kind === 'test.abandoned');
        if (row && row.state !== 'running') break;
        if (Date.now() > deadline) throw new Error('abandoned job was never requeued');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
      await runner.stop();
    }
  });
});
