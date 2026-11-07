/**
 * Every kind of answer waits behind an earlier message that is still retrying (OWN-74, PR #428).
 *
 * A short reply that answers something Rekoda asked (the funding source, a period, a numbered
 * choice, "same" or "separate" for a held purchase) cannot be told from a new request before it is
 * read. If it ran while an earlier "cancel" was backing off, and that cancel then died, the answer
 * could already have rebuilt or advanced what the cancel withdrew. So each one waits; once the
 * cancel dies, its question is closed and its draft retired before the answer is read, the
 * merchant is told, and nothing the answer could have revived is left confirmable. Each test checks
 * both the books and what the merchant was sent. Helpers are in meta-lost-message.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { continuationsRepo, conversationsRepo, identity, withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { db, stubSender, useMetaWebhookHarness } from './meta-webhook.fixtures.js';
import {
  HOW_MUCH_DID_I_SELL,
  OWNER,
  WHICH_PERIOD,
  continuations,
  reply,
  say,
  seedMerchant as seedFashion,
} from './meta-continuations.fixtures.js';
import {
  MILO,
  QUESTION,
  SEPARATE_LEAD,
  bookMilo,
  footprint as purchaseFootprint,
  seedMerchant as seedProvisions,
} from './meta-purchase-truth.fixtures.js';
import {
  asTenant,
  bringDue,
  failLastAttempt,
  failOnceAndBackOff,
  pendingInbound,
  queueOnly,
} from './meta-lost-message.fixtures.js';
import { drain } from './meta-preview-expiry.fixtures.js';

useMetaWebhookHarness();

const LOST = replies.earlierMessageLostNo().text;

/** Queue a "cancel" and leave it backing off after one failed attempt. */
async function retryingCancel(businessId: string, tag: string) {
  await queueOnly(`wamid.${tag}-cancel`, 'cancel');
  return failOnceAndBackOff(businessId);
}

/** Kill the retrying cancel, then run whatever waited behind it. */
async function cancelDies(businessId: string, cancel: string) {
  await failLastAttempt(businessId, cancel);
  await bringDue(businessId);
  await drain();
}

const sentSince = (count: number) => stubSender.sent.slice(count).map((s) => s.text);

describe('an answer sent while an earlier "cancel" retries waits for it (OWN-74)', () => {
  it('a period answer waits, and the question the cancel withdrew is never answered', async () => {
    const business = await seedFashion();
    await say('wamid.per-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);
    const cancel = await retryingCancel(business.id, 'per');
    const before = stubSender.sent.length;

    await reply('wamid.per-answer', 'Last month.');
    /* Waiting, unanswered: nothing sent and the question still open. */
    expect(sentSince(before)).toEqual([]);
    expect(await pendingInbound(business.id)).toBe(2);
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['open']);

    await cancelDies(business.id, cancel);
    const told = sentSince(before);
    expect(told[0]).toBe(LOST);
    expect(told.join('\n')).not.toContain('invoiced across');
    expect((await continuations(business.id)).map((c) => `${c.kind}:${c.state}`)).toEqual([
      'clarification:superseded',
    ]);
  });

  it('a numbered choice waits, and the list the cancel withdrew is never chosen from', async () => {
    const business = await seedFashion();
    const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
    await withBusiness(db, business.id, async (tx) => {
      const thread = await conversationsRepo.recordInbound(
        tx,
        {
          businessId: business.id,
          channel: 'meta',
          kind: 'text',
          body: '[list]',
          providerMessageId: 'wamid.choice-list',
        },
        { kind: 'MERCHANT', businessId: business.id, channel: 'meta' },
      );
      await continuationsRepo.openContinuation(tx, {
        businessId: business.id,
        userId: user.id,
        sourceMessageId: thread.id,
        state: {
          kind: 'clarification',
          expects: 'choice',
          topic: 'debtors',
          options: [
            { ordinal: 1, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000001' } },
            { ordinal: 2, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000002' } },
          ],
        },
      });
    });
    const cancel = await retryingCancel(business.id, 'choice');
    const before = stubSender.sent.length;

    await reply('wamid.choice-2', '2');
    expect(sentSince(before)).toEqual([]);
    expect(await pendingInbound(business.id)).toBe(2);

    await cancelDies(business.id, cancel);
    const told = sentSince(before);
    expect(told[0]).toBe(LOST);
    expect(told).not.toContain(replies.optionChosen('INV-2026-000002').text);
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
  });

  it('"separate" for a held purchase waits, and the cancel\'s withdrawal leaves nothing a "yes" can book', async () => {
    const business = await seedProvisions();
    await bookMilo(business.id, 'sep');
    await say('wamid.sep-again', MILO, 'I bought another 10 cartons of Milo from Emeka for 100k');
    expect(stubSender.lastText).toContain(QUESTION);
    const cancel = await retryingCancel(business.id, 'sep');
    const before = stubSender.sent.length;

    await reply('wamid.sep-separate', 'separate');
    expect(sentSince(before)).toEqual([]);

    await cancelDies(business.id, cancel);
    await reply('wamid.sep-yes', 'yes');
    const told = sentSince(before);
    expect(told).toContain(LOST);
    expect(told.join('\n')).not.toContain(SEPARATE_LEAD);
    const books = await purchaseFootprint(business.id);
    expect(books.purchases).toBe(1);
    expect(books.arrivals).toBe(1);
  });

  /* The held purchase still answers a bare "same" or "separate" once its question's continuation
   * was retired by another message (G-81). That answer is not behind an open clarification, so it
   * must wait on its own words: otherwise it rebuilt a fresh preview after the cancel, which the
   * cancel's withdrawal could not reach, and a later "yes" booked the purchase a second time. */
  it('a bare "separate" for a held purchase whose question was retired waits too: lost cancel, separate, yes', async () => {
    const business = await seedProvisions();
    await bookMilo(business.id, 'bare');
    await say('wamid.bare-again', MILO, 'I bought another 10 cartons of Milo from Emeka for 100k');
    expect(stubSender.lastText).toContain(QUESTION);
    await asTenant(
      business.id,
      sql`UPDATE conversation_continuations SET state = 'superseded'
           WHERE business_id = ${business.id}::uuid AND state = 'open'`,
    );
    const cancel = await retryingCancel(business.id, 'bare');
    const before = stubSender.sent.length;

    await reply('wamid.bare-separate', 'separate');
    expect(sentSince(before)).toEqual([]);
    expect(await pendingInbound(business.id)).toBe(2);

    await cancelDies(business.id, cancel);
    await reply('wamid.bare-yes', 'yes');
    const told = sentSince(before);
    expect(told).toContain(LOST);
    expect(told.join('\n')).not.toContain(SEPARATE_LEAD);
    const books = await purchaseFootprint(business.id);
    expect(books.purchases).toBe(1);
    expect(books.postings).toBe(1);
  });

  it('a new request is not held behind the retrying cancel', async () => {
    const business = await seedProvisions();
    const cancel = await retryingCancel(business.id, 'new');
    const before = stubSender.sent.length;

    await say('wamid.new-buy', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
    expect(sentSince(before).join('\n')).toContain('Paid in full by cash');
    expect(await pendingInbound(business.id)).toBe(1);

    await cancelDies(business.id, cancel);
    await reply('wamid.new-yes', 'yes');
    expect((await purchaseFootprint(business.id)).purchases).toBe(1);
  });
});
