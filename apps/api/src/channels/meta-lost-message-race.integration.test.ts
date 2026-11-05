/**
 * Webhook ingress, end to end: a lost inbound message that dies WHILE a later "yes" is being
 * read (OWN-74, PR #428 independent review).
 *
 * The answer handler both reconciles dead inbound messages and waits for earlier live ones. Those
 * are two statements under READ COMMITTED, and the earlier job can die between them: the runner
 * rolls the failing handler back (releasing the business lock) before it commits `dead`, and
 * `reclaimStalled` can mark a stalled job dead at any moment. If the reconcile reads first, it sees
 * the "cancel" still live and retires nothing; the wait then sees it dead and lets the "yes" go
 * ahead, confirming the draft the merchant tried to cancel.
 *
 * The overlap is made deterministic by killing the lost job, through the real repository path,
 * right after whichever of the two reads the "yes" makes first. Whatever the order, a "yes" must
 * never book the request a lost "cancel" was about.
 */
import { describe, expect, it, vi } from 'vitest';
import { jobsRepo, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import {
  messagePayload,
  post,
  stubSender,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import { AN_EXPENSE, drain, footprint, say, seedMerchant } from './meta-preview-expiry.fixtures.js';

/** Runs once, right after the first of the two reads that the next inbound run makes. */
const between = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));

vi.mock('@rekoda/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rekoda/db')>();
  const thenFire =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const result = await fn(...args);
      const run = between.run;
      between.run = null;
      if (run) await run();
      return result;
    };
  return {
    ...actual,
    conversationsRepo: {
      ...actual.conversationsRepo,
      reconcileDeadInboundMessages: thenFire(actual.conversationsRepo.reconcileDeadInboundMessages),
    },
    jobsRepo: {
      ...actual.jobsRepo,
      hasEarlierLiveJobByArrival: thenFire(actual.jobsRepo.hasEarlierLiveJobByArrival),
    },
  };
});

useMetaWebhookHarness();

describe('a lost "cancel" that dies while a later "yes" is being read', () => {
  it('never lets the "yes" confirm the draft the cancel was about', async () => {
    const business = await seedMerchant();
    await say('wamid.race-1', AN_EXPENSE, 'bought fuel 20k cash');
    expect(stubSender.lastText).toContain('Expense: fuel for generator');

    /* The "cancel" fails once and backs off; it is still live when the "yes" arrives. */
    await post(messagePayload('2348031234567', 'wamid.race-cancel', 'cancel'));
    await workerDb.execute(sql`
      UPDATE jobs SET max_attempts = 2
       WHERE business_id = ${business.id}::uuid AND kind = 'inbound.message' AND state = 'pending'`);
    const cancel = await jobsRepo.claimNext(workerDb, 'failing-worker');
    expect(cancel?.kind).toBe('inbound.message');
    expect((await jobsRepo.markFailed(workerDb, cancel!, 'handler failed', 60_000)).state).toBe(
      'pending',
    );

    /* Its last attempt fails, committed on the worker's own connection, in the middle of the
     * "yes" run: after the first of its two reads, before the second. */
    between.run = async () => {
      await workerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE id = ${cancel!.id}::uuid`);
      const last = await jobsRepo.claimNext(workerDb, 'failing-worker-2');
      expect(last?.id).toBe(cancel!.id);
      expect((await jobsRepo.markFailed(workerDb, last!, 'handler failed', 0)).state).toBe('dead');
    };
    await post(messagePayload('2348031234567', 'wamid.race-yes', 'yes'));
    await drain();
    expect(between.run).toBeNull();

    /* A "yes" that stepped aside runs again once its short wait is over. */
    await workerDb.execute(sql`
      UPDATE jobs SET run_at = now()
       WHERE business_id = ${business.id}::uuid AND state = 'pending'`);
    await drain();

    expect((await footprint(business.id)).expenses).toBe(0);
    expect(stubSender.lastText).toBe(replies.earlierMessageLostYes().text);
  });
});
