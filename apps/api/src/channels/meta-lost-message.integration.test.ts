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
