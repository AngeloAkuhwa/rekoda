/**
 * A yes, a no or a questioned yes after a refusal (owner review of #437): split from
 * meta-refusal-yes.integration.test.ts, which is at the layout limit.
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { identity, sql, withBusiness } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { drain } from './meta-voice-note.fixtures.js';
import { mediaMessage } from './meta-continuations.fixtures.js';
import {
  DELEGATE,
  OWNER,
  footprint,
  plain,
  sale,
  say,
  seedMerchant,
} from './meta-customer-token.fixtures.js';

useMetaWebhookHarness();

const STICKER = { type: 'sticker', sticker: { id: 'sticker-1', mime_type: 'image/webp' } };
const QUESTION = {
  intent: 'Query',
  topic: 'sales_summary',
  customer: null,
  period: 'today',
  periodText: 'today',
  format: 'chat',
};

/**
 * After a preview, a question and the member's own refusal, the reply to their yes or no says
 * "reply yes to save it": the next yes must save it, never retire the question first (CodeRabbit
 * on #437 at 96b1b52).
 */
describe('the yes the refusal reply promises saves the preview behind it', () => {
  it.each(['yes', 'no'])('after "%s" to the refusal, one more yes saves it', async (answer) => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.RP1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say('wamid.RP2', QUESTION, 'how much did I sell today');
    await post(mediaMessage(`wamid.RP3-${answer}`, STICKER, OWNER));
    await drain();
    const before = await footprint(business.id);

    await plain(`wamid.RP4-${answer}`, answer);
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    await plain(`wamid.RP5-${answer}`, 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });
});

/** A questioned yes ("na so?") is member-aware and read-only, as a yes is (CodeRabbit at 96b1b52). */
describe("a questioned yes looks past another member's refusal", () => {
  it("points the owner at their preview and leaves the delegate's refusal theirs", async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.RQ1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await post(mediaMessage('wamid.RQ2', STICKER, DELEGATE));
    await drain();
    const before = await footprint(business.id);

    await plain('wamid.RQ3', 'na so?');
    expect(stubSender.lastText).toBe(replies.plainYesNeeded().text);
    const refusals = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string }>(
        sql`SELECT state FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'`,
      ),
    );
    expect([...refusals].map((r) => r.state)).toEqual(['pending']);
    expect(await footprint(business.id)).toEqual(before);
  });
});

/**
 * The answer to a refusal that never reached the merchant is undone: the refusal (and any question
 * it retired) is pending again, so the merchant's repeated yes is still about the refusal and
 * never books the older sale (Codex on #437 at 3d66867).
 */
describe('an undelivered answer to a refusal', () => {
  it('leaves the refusal in place: the repeated yes saves nothing', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.RU1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await post(mediaMessage('wamid.RU2', STICKER, OWNER));
    await drain();
    const before = await footprint(business.id);

    stubSender.failWith();
    await plain('wamid.RU3', 'yes');
    await plain('wamid.RU4', 'yes');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    expect(await footprint(business.id)).toEqual(before);
  });
});

/**
 * A bare "no" supersedes every pending draft but another member's refusal, which stays theirs:
 * the delegate's next yes is still about it, never the owner's newer preview (CodeRabbit on #437
 * at 3d66867).
 */
describe("a bare no keeps another member's refusal", () => {
  it("so the delegate's yes never confirms the owner's newer preview", async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await post(mediaMessage('wamid.RN1', STICKER, DELEGATE));
    await drain();
    await plain('wamid.RN2', 'no');
    await say(
      'wamid.RN3',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    const before = await footprint(business.id);

    await post(messagePayload(DELEGATE, 'wamid.RN4', 'yes'));
    await drain();
    expect(stubSender.lastText).toBe(replies.previewWaitingForAnotherMember().text);
    expect(await footprint(business.id)).toEqual(before);
  });
});

/**
 * A correction that replaces the sender's own draft supersedes every pending draft but another
 * member's refusal, which stays theirs: the delegate's first yes is still about it and never
 * confirms the owner's replacement preview (CodeRabbit on #437 at 0e12742).
 */
describe("a correction keeps another member's refusal", () => {
  it("so the delegate's yes never confirms the owner's corrected preview", async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await say('wamid.RC1', sale({ kind: 'none' }), 'sold 2 wigs for 100k');
    await post(mediaMessage('wamid.RC2', STICKER, DELEGATE));
    await drain();
    await say(
      'wamid.RC3',
      {
        ...sale({ kind: 'none' }),
        items: [{ name: 'wig', quantity: 2, unitPrice: 60_000 }],
        statedTotal: 120_000,
      },
      'change the price to 60k',
    );
    const before = await footprint(business.id);

    await post(messagePayload(DELEGATE, 'wamid.RC4', 'yes'));
    await drain();
    expect(await footprint(business.id)).toEqual(before);
    const refusals = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string }>(
        sql`SELECT state FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'`,
      ),
    );
    expect([...refusals].map((r) => r.state)).toEqual(['superseded']);

    await plain('wamid.RC5', 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });
});

/**
 * Answering one's own refusal retires only one's own questions: another member's question since
 * the preview stays the barrier it is, so that member's next yes, about their answer, never saves
 * a preview they did not ask for (CodeRabbit on #437 at 0e12742).
 */
describe("answering a refusal keeps another member's question", () => {
  it.each(['yes', 'no'])(
    'after the owner\'s "%s", the delegate\'s yes saves nothing',
    async (answer) => {
      const business = await seedMerchant();
      const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
      await say(
        `wamid.RD1-${answer}`,
        sale({ kind: 'token', token: ada.token }),
        'sold Ada Obi 2 wigs for 100k',
      );
      stubTransport.replyWith(QUESTION);
      await post(messagePayload(DELEGATE, `wamid.RD2-${answer}`, 'how much did I sell today'));
      await drain();
      await post(mediaMessage(`wamid.RD3-${answer}`, STICKER, OWNER));
      await drain();
      const before = await footprint(business.id);

      await plain(`wamid.RD4-${answer}`, answer);
      /* Another member's question still stands between the owner and the preview. */
      expect(stubSender.lastText).toBe(replies.previewBehindQuestion().text);
      await post(messagePayload(DELEGATE, `wamid.RD5-${answer}`, 'yes'));
      await drain();
      expect(await footprint(business.id)).toEqual(before);
    },
  );
});

/**
 * A questioned yes chooses what it is about the way a plain yes does: the owner's own refusal,
 * behind a delegate's newer preview, is what both are about, so "na so?" never invites a plain yes
 * that would save nothing (CodeRabbit on #437 at 0e12742).
 */
describe("a questioned yes finds the sender's refusal behind another member's preview", () => {
  it('is answered as the plain yes would be, and changes nothing', async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await post(mediaMessage('wamid.RY1', STICKER, OWNER));
    await drain();
    stubTransport.replyWith(sale({ kind: 'none' }));
    await post(messagePayload(DELEGATE, 'wamid.RY2', 'sold 2 wigs for 100k'));
    await drain();
    const before = await footprint(business.id);

    await plain('wamid.RY3', 'na so?');
    expect(stubSender.lastText).toBe(replies.previewWaitingForAnotherMember().text);
    const refusals = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string }>(
        sql`SELECT state FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'`,
      ),
    );
    expect([...refusals].map((r) => r.state)).toEqual(['pending']);
    await plain('wamid.RY4', 'yes');
    expect(stubSender.lastText).toBe(replies.previewWaitingForAnotherMember().text);
    expect(await footprint(business.id)).toEqual(before);
  });
});
