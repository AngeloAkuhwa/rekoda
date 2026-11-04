/**
 * Webhook ingress, end to end: an inbound message whose job died (owner ruling, 4 Nov 2026,
 * PR #428).
 *
 * A merchant's "cancel" that is never processed must not let a later "yes" confirm the draft it
 * was about. The job dies by either path the queue has: its handler fails on every attempt
 * (`markFailed`), or its worker stops answering on every attempt (`reclaimStalled`). Either way
 * the draft pending then is withdrawn before the "yes" is read, the merchant is told to send it
 * again, and nothing is booked. The shared app, stubs and payload helpers are in
 * meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { jobsRepo, withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import {
  db,
  messagePayload,
  post,
  stubSender,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import {
  AN_EXPENSE,
  drain,
  draftStates,
  footprint,
  plain,
  say,
  seedMerchant,
} from './meta-preview-expiry.fixtures.js';

useMetaWebhookHarness();

type Death = 'markFailed' | 'reclaimStalled';

/** Deliver a message to the queue without running it, so its job can be killed. */
async function queueOnly(wamid: string, text: string) {
  await post(messagePayload('2348031234567', wamid, text));
}

/**
 * Kill the one waiting inbound job by the real repository path. One attempt is allowed, so
 * `markFailed` ends it at once; `reclaimStalled` gives it the one extra run past the last
 * attempt, and the job dies when that run's lease expires too.
 */
async function killInboundJob(businessId: string, death: Death) {
  await workerDb.execute(sql`
    UPDATE jobs SET max_attempts = 1
     WHERE business_id = ${businessId}::uuid AND kind = 'inbound.message' AND state = 'pending'`);
  const runs = death === 'markFailed' ? 1 : 2;
  for (let run = 1; run <= runs; run++) {
    const job = await jobsRepo.claimNext(workerDb, `dying-worker-${run}`);
    expect(job?.kind).toBe('inbound.message');
    if (death === 'markFailed') {
      expect((await jobsRepo.markFailed(workerDb, job!, 'handler failed', 0)).state).toBe('dead');
    } else {
      await workerDb.execute(
        sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${job!.id}::uuid`,
      );
      expect(await jobsRepo.reclaimStalled(workerDb, 300_000)).toBe(1);
    }
  }
  const [row] = await withBusiness(db, businessId, (tx) =>
    jobsRepo.jobsForBusiness(tx, 'inbound.message'),
  ).then((rows) => rows.filter((r) => r.state === 'dead'));
  expect(row?.state).toBe('dead');
}

const inboundEventsProcessed = async (businessId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{ processed: boolean }>(sql`
        SELECT processed_at IS NOT NULL AS processed FROM external_events
         WHERE business_id = ${businessId}::uuid AND event_type LIKE 'message.%'
         ORDER BY created_at`),
    )),
  ].map((r) => r.processed);

describe.each<Death>(['markFailed', 'reclaimStalled'])(
  'an inbound message whose job died by %s',
  (death) => {
    it('withdraws the draft pending then, so a later "yes" confirms nothing and asks for a resend', async () => {
      const business = await seedMerchant();
      await say(`wamid.lost-${death}-1`, AN_EXPENSE, 'bought fuel 20k cash');
      expect(stubSender.lastText).toContain('Expense: fuel for generator');

      await queueOnly(`wamid.lost-${death}-cancel`, 'cancel');
      await killInboundJob(business.id, death);

      await plain(`wamid.lost-${death}-yes`, 'yes');
      expect(stubSender.lastText).toBe(replies.earlierMessageLostYes().text);
      expect((await footprint(business.id)).expenses).toBe(0);
      expect(await draftStates(business.id)).toEqual([
        { state: 'superseded', reason: 'inbound_message_failed' },
      ]);
      /* Applied once: the dead message's event is processed, and a second "yes" books nothing. */
      expect(await inboundEventsProcessed(business.id)).not.toContain(false);
      await plain(`wamid.lost-${death}-yes-2`, 'yes');
      expect((await footprint(business.id)).expenses).toBe(0);
    });

    it('answers a later "no" honestly, and a request sent again is confirmed as normal', async () => {
      const business = await seedMerchant();
      await say(`wamid.lostno-${death}-1`, AN_EXPENSE, 'bought fuel 20k cash');
      await queueOnly(`wamid.lostno-${death}-fix`, 'cancel');
      await killInboundJob(business.id, death);

      await plain(`wamid.lostno-${death}-no`, 'no');
      expect(stubSender.lastText).toBe(replies.earlierMessageLostNo().text);
      expect((await footprint(business.id)).expenses).toBe(0);

      /* A draft written after the death is a later message's: it is never withdrawn. */
      await say(`wamid.lostno-${death}-again`, AN_EXPENSE, 'bought fuel 20k cash');
      expect(stubSender.lastText).toContain('Expense: fuel for generator');
      await plain(`wamid.lostno-${death}-yes`, 'yes');
      expect((await footprint(business.id)).expenses).toBe(1);
    });
  },
);

describe('an inbound message that fails and backs off before it dies (markFailed with retries)', () => {
  /** Fail the waiting inbound job's first attempt and leave it backing off for a minute. */
  async function failOnceAndBackOff(businessId: string) {
    await workerDb.execute(sql`
      UPDATE jobs SET max_attempts = 2
       WHERE business_id = ${businessId}::uuid AND kind = 'inbound.message' AND state = 'pending'`);
    const job = await jobsRepo.claimNext(workerDb, 'failing-worker');
    expect(job?.kind).toBe('inbound.message');
    expect((await jobsRepo.markFailed(workerDb, job!, 'handler failed', 60_000)).state).toBe(
      'pending',
    );
    return job!.id;
  }
  /** Bring the backing-off job due and fail its last attempt: it dies. */
  async function failLastAttempt(jobId: string) {
    await workerDb.execute(sql`UPDATE jobs SET run_at = now() WHERE id = ${jobId}::uuid`);
    const job = await jobsRepo.claimNext(workerDb, 'failing-worker-2');
    expect(job?.id).toBe(jobId);
    expect((await jobsRepo.markFailed(workerDb, job!, 'handler failed', 0)).state).toBe('dead');
  }

  it('a "yes" sent while the lost "cancel" retries waits for it, and then confirms nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.backoff-1', AN_EXPENSE, 'bought fuel 20k cash');
    await queueOnly('wamid.backoff-cancel', 'cancel');
    const cancel = await failOnceAndBackOff(business.id);

    /* The yes arrives during the backoff: it must not pass the cancel and book the expense. */
    await plain('wamid.backoff-yes', 'yes');
    expect((await footprint(business.id)).expenses).toBe(0);

    await failLastAttempt(cancel);
    await workerDb.execute(sql`
      UPDATE jobs SET run_at = now()
       WHERE business_id = ${business.id}::uuid AND state = 'pending'`);
    await drain();
    expect(stubSender.lastText).toBe(replies.earlierMessageLostYes().text);
    expect((await footprint(business.id)).expenses).toBe(0);
  });

  it('a request sent while the lost message retried keeps its own draft when that message dies', async () => {
    const business = await seedMerchant();
    await queueOnly('wamid.passing-question', 'cancel');
    const lost = await failOnceAndBackOff(business.id);

    /* A new request passes the backing-off message (requests are not held for its retries). */
    await say('wamid.passing-request', AN_EXPENSE, 'bought fuel 20k cash');
    expect(stubSender.lastText).toContain('Expense: fuel for generator');
    await failLastAttempt(lost);

    /* It reached Rekoda after the lost message, so it is not withdrawn: the yes confirms it. */
    await plain('wamid.passing-yes', 'yes');
    expect((await footprint(business.id)).expenses).toBe(1);
  });

  it('tells the merchant on a message that is not an answer, too', async () => {
    const business = await seedMerchant();
    await say('wamid.notice-1', AN_EXPENSE, 'bought fuel 20k cash');
    await queueOnly('wamid.notice-cancel', 'cancel');
    const lost = await failOnceAndBackOff(business.id);
    await failLastAttempt(lost);

    await plain('wamid.notice-help', 'help');
    expect(stubSender.sent.map((s) => s.text)).toContain(replies.earlierMessageLostNo().text);
    expect(await draftStates(business.id)).toEqual([
      { state: 'superseded', reason: 'inbound_message_failed' },
    ]);
  });
});
