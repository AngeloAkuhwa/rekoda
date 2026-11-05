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
  stubStt,
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
import { arrangeAudio, voicePayload, voiceUsed } from './meta-voice-note.fixtures.js';

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

describe('a lost message whose draft window closes before the next message is read', () => {
  it('a "yes" sent inside the window still confirms nothing once the window has closed', async () => {
    const business = await seedMerchant();
    await say('wamid.window-1', AN_EXPENSE, 'bought fuel 20k cash');
    await queueOnly('wamid.window-cancel', 'cancel');
    await killInboundJob(business.id, 'markFailed');

    /* The "yes" reaches Rekoda inside the window, but is read only after the window has closed:
     * it is judged at its arrival, so the lost "cancel" before it must still have withdrawn it. */
    await post(messagePayload('2348031234567', 'wamid.window-yes', 'yes'));
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp()
         WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await drain();

    expect((await footprint(business.id)).expenses).toBe(0);
    expect(stubSender.lastText).toBe(replies.earlierMessageLostYes().text);
  });
});

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
  /**
   * Bring the backing-off job due and fail its last attempt: it dies. Any other waiting job is
   * put out of reach first, so a deferred answer whose half-second wait has passed cannot be
   * claimed in its place.
   */
  async function failLastAttempt(businessId: string, jobId: string) {
    await workerDb.execute(sql`
      UPDATE jobs SET run_at = CASE WHEN id = ${jobId}::uuid THEN now() ELSE now() + interval '1 hour' END
       WHERE business_id = ${businessId}::uuid AND state = 'pending'`);
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

    await failLastAttempt(business.id, cancel);
    await workerDb.execute(sql`
      UPDATE jobs SET run_at = now()
       WHERE business_id = ${business.id}::uuid AND state = 'pending'`);
    await drain();
    expect(stubSender.lastText).toBe(replies.earlierMessageLostYes().text);
    expect((await footprint(business.id)).expenses).toBe(0);
  });

  it('a spoken "yes" sent while the lost "cancel" retries waits for it too, and confirms nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.voice-backoff-1', AN_EXPENSE, 'bought fuel 20k cash');
    await queueOnly('wamid.voice-backoff-cancel', 'cancel');
    const cancel = await failOnceAndBackOff(business.id);

    /* The answer is a voice note: it is not heard until it is transcribed, so it waits unheard. */
    arrangeAudio(1);
    stubStt.answerWith({ text: 'yes', seconds: 1, confidence: 0.95 });
    await post(voicePayload('2348031234567', 'wamid.voice-backoff-yes'));
    await drain();
    expect((await footprint(business.id)).expenses).toBe(0);
    /* It waits before any provider is paid: nothing transcribed, no voice seconds metered. */
    expect(stubStt.calls).toHaveLength(0);
    expect(await voiceUsed(business.id)).toBe(0);
    const sentBefore = stubSender.sent.length;

    await failLastAttempt(business.id, cancel);
    await workerDb.execute(sql`
      UPDATE jobs SET run_at = now()
       WHERE business_id = ${business.id}::uuid AND state = 'pending'`);
    await drain();
    /* Told before it is heard (so a note that cannot be transcribed is told too), then answered. */
    expect(stubSender.sent.slice(sentBefore).map((s) => s.text)).toEqual([
      replies.earlierMessageLostNo().text,
      replies.earlierMessageLostYes().text,
    ]);
    expect((await footprint(business.id)).expenses).toBe(0);
  });

  it('a request sent while the lost message retried keeps its own draft when that message dies', async () => {
    const business = await seedMerchant();
    await queueOnly('wamid.passing-question', 'cancel');
    const lost = await failOnceAndBackOff(business.id);

    /* A new request passes the backing-off message (requests are not held for its retries). */
    await say('wamid.passing-request', AN_EXPENSE, 'bought fuel 20k cash');
    expect(stubSender.lastText).toContain('Expense: fuel for generator');
    await failLastAttempt(business.id, lost);

    /* It reached Rekoda after the lost message, so it is not withdrawn: the yes confirms it. */
    await plain('wamid.passing-yes', 'yes');
    expect((await footprint(business.id)).expenses).toBe(1);
  });

  it('tells the merchant on a message that is not an answer, too', async () => {
    const business = await seedMerchant();
    await say('wamid.notice-1', AN_EXPENSE, 'bought fuel 20k cash');
    await queueOnly('wamid.notice-cancel', 'cancel');
    const lost = await failOnceAndBackOff(business.id);
    await failLastAttempt(business.id, lost);

    await plain('wamid.notice-help', 'help');
    expect(stubSender.sent.map((s) => s.text)).toContain(replies.earlierMessageLostNo().text);
    expect(await draftStates(business.id)).toEqual([
      { state: 'superseded', reason: 'inbound_message_failed' },
    ]);
  });
});
