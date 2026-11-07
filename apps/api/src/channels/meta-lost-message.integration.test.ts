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
import { withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import {
  db,
  messagePayload,
  post,
  stubSender,
  stubStt,
  useMetaWebhookHarness,
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
import { POS_PURCHASE } from './meta-continuations.fixtures.js';
import {
  asTenant,
  failLastAttempt,
  failOnceAndBackOff,
  inboundEventsProcessed,
  killInboundJob,
  queueOnly,
  type Death,
} from './meta-lost-message.fixtures.js';

useMetaWebhookHarness();

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

describe('a funding question behind a lost message (CodeRabbit on #428)', () => {
  it.each<Death>(['markFailed', 'reclaimStalled'])(
    'cannot be reopened by a later "yes" and answered "cash" to book the purchase (%s)',
    async (death) => {
      const business = await seedMerchant();
      await say(
        `wamid.fundlost-${death}-1`,
        POS_PURCHASE,
        'I bought 10 cartons for 100k, paid by POS',
      );
      expect(stubSender.lastText).toContain('Reply *bank* or *cash*');
      await queueOnly(`wamid.fundlost-${death}-cancel`, 'cancel');
      await killInboundJob(business.id, death);

      await plain(`wamid.fundlost-${death}-yes`, 'yes');
      expect(stubSender.lastText).toBe(replies.earlierMessageLostYes().text);
      await plain(`wamid.fundlost-${death}-cash`, 'cash');
      await plain(`wamid.fundlost-${death}-yes-2`, 'yes');
      const after = await footprint(business.id);
      expect(after.expenses).toBe(0);
      expect(after.postings).toBe(0);
    },
  );
});

describe('a run that returns early does not consume a lost message (Qodo on #428)', () => {
  it('leaves the withdrawal for a run that can tell the merchant, instead of retiring it silently', async () => {
    const business = await seedMerchant();
    await say('wamid.early-1', AN_EXPENSE, 'bought fuel 20k cash');
    await queueOnly('wamid.early-cancel', 'cancel');
    await killInboundJob(business.id, 'markFailed');

    /* The next message's payload cannot be read, so its run returns before it reaches the notice. */
    await queueOnly('wamid.early-bad', 'hello');
    await asTenant(
      business.id,
      sql`UPDATE external_events SET payload = '{}'::jsonb
           WHERE business_id = ${business.id}::uuid AND external_id = 'wamid.early-bad'`,
    );
    await drain();
    expect(await draftStates(business.id)).toEqual([{ state: 'pending', reason: null }]);

    /* The next readable message still withdraws it and tells the merchant. */
    await plain('wamid.early-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.earlierMessageLostYes().text);
    expect((await footprint(business.id)).expenses).toBe(0);
  });
});

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
  it('a "yes" sent while the lost "cancel" retries waits for it, and then confirms nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.backoff-1', AN_EXPENSE, 'bought fuel 20k cash');
    await queueOnly('wamid.backoff-cancel', 'cancel');
    const cancel = await failOnceAndBackOff(business.id);

    /* The yes arrives during the backoff: it must not pass the cancel and book the expense. */
    await plain('wamid.backoff-yes', 'yes');
    expect((await footprint(business.id)).expenses).toBe(0);

    await failLastAttempt(business.id, cancel);
    await asTenant(
      business.id,
      sql`
      UPDATE jobs SET run_at = now()
       WHERE business_id = ${business.id}::uuid AND state = 'pending'`,
    );
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
    await asTenant(
      business.id,
      sql`
      UPDATE jobs SET run_at = now()
       WHERE business_id = ${business.id}::uuid AND state = 'pending'`,
    );
    await drain();
    /* Told before it is heard (so a note that cannot be transcribed is told too), then answered. */
    expect(stubSender.sent.slice(sentBefore).map((s) => s.text)).toEqual([
      replies.earlierMessageLostNo().text,
      replies.earlierMessageLostYes().text,
    ]);
    expect((await footprint(business.id)).expenses).toBe(0);
  });

  it('a "cash" answer to the funding question waits for the retrying "cancel", so a lost cancel cannot be overtaken (CodeRabbit on #428)', async () => {
    const business = await seedMerchant();
    await say('wamid.fund-1', POS_PURCHASE, 'I bought 10 cartons for 100k, paid by POS');
    expect(stubSender.lastText).toContain('Reply *bank* or *cash*');
    await queueOnly('wamid.fund-cancel', 'cancel');
    const cancel = await failOnceAndBackOff(business.id);

    /* The answer arrives during the backoff: it must not rebuild the purchase from a question the
     * lost "cancel" may have withdrawn. */
    const sentBefore = stubSender.sent.length;
    await plain('wamid.fund-cash', 'cash');
    /* Waiting, unanswered: no purchase preview while the cancel retries. */
    expect(stubSender.sent.length).toBe(sentBefore);
    await failLastAttempt(business.id, cancel);
    await asTenant(
      business.id,
      sql`
      UPDATE jobs SET run_at = now()
       WHERE business_id = ${business.id}::uuid AND state = 'pending'`,
    );
    await drain();

    /* Nothing is left confirmable: the later yes books no purchase. */
    await plain('wamid.fund-yes', 'yes');
    const told = stubSender.sent.slice(sentBefore).map((s) => s.text);
    expect(told[0]).toBe(replies.earlierMessageLostNo().text);
    expect(told.join('\n')).not.toContain('Please check this before I save it');
    const after = await footprint(business.id);
    expect(after.expenses).toBe(0);
    expect(after.postings).toBe(0);
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

  it('a "yes" that answers a newer request still tells the merchant the older one was withdrawn', async () => {
    const business = await seedMerchant();
    await say('wamid.older-1', AN_EXPENSE, 'bought fuel 20k cash');
    await queueOnly('wamid.older-cancel', 'cancel');
    const lost = await failOnceAndBackOff(business.id);

    /* A new request passes the backing-off message, so two drafts wait: the older one, pending
     * when the lost message arrived, and this one, sent after it. */
    await say(
      'wamid.older-newer',
      { ...AN_EXPENSE, description: 'printer paper', amount: 5_000 },
      'bought printer paper 5k cash',
    );
    expect(stubSender.lastText).toContain('printer paper');
    await failLastAttempt(business.id, lost);
    const sentBefore = stubSender.sent.length;

    /* The yes confirms the newer request, which its own answer reports. The older one is
     * withdrawn, and the merchant must be told so: a withdrawal is never silent. */
    await plain('wamid.older-yes', 'yes');
    expect((await footprint(business.id)).expenses).toBe(1);
    expect(await draftStates(business.id)).toContainEqual({
      state: 'superseded',
      reason: 'inbound_message_failed',
    });
    const told = stubSender.sent.slice(sentBefore).map((s) => s.text);
    expect(told).toContain(replies.earlierMessageLostNo().text);
    expect(told).toHaveLength(2);
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
