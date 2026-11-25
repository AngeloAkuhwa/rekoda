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
    /* The refusal answer itself books nothing (CodeRabbit on #437 at c5392f0). */
    expect(await footprint(business.id)).toEqual(before);
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
 * A correction never takes away another member's refusal: with the delegate's refusal since the
 * owner's preview, the owner's correction is asked about and supersedes nothing (OD-60), and the
 * supersession it would make leaves another member's refusal pending (`skipRefusalsNotBy`). Either
 * way the delegate's first yes is about their own refusal and never confirms the owner's preview
 * (CodeRabbit on #437 at 0e12742).
 */
describe("a correction keeps another member's refusal", () => {
  it("so the delegate's yes never confirms the owner's preview", async () => {
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
    /* The delegate's own refusal is what their yes answered, and closed. */
    const theirs = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string }>(
        sql`SELECT state FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'
               AND requested_by = ${delegate.id}::uuid`,
      ),
    );
    expect([...theirs].map((r) => r.state)).toEqual(['superseded']);
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
  /* Behind 51 of them too: the doubt's scan has no bound the plain yes lacks (CodeRabbit on #437
   * at 503acf3). */
  it.each([1, 51])('behind %i: answered as the plain yes would be, changing nothing', async (n) => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await post(mediaMessage('wamid.RY1', STICKER, OWNER));
    await drain();
    stubTransport.replyWith(sale({ kind: 'none' }));
    await post(messagePayload(DELEGATE, 'wamid.RY2', 'sold 2 wigs for 100k'));
    await drain();
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        WITH src AS (
          SELECT d.*, m.conversation_id, m.direction, m.kind AS message_kind
            FROM command_drafts d JOIN conversation_messages m ON m.id = d.conversation_message_id
           WHERE d.business_id = ${business.id}::uuid AND d.requested_by = ${delegate.id}::uuid
             AND d.intent = 'RecordSale'
        ), copies AS (
          INSERT INTO conversation_messages
                 (business_id, conversation_id, direction, kind, body, provider_message_id)
          SELECT s.business_id, s.conversation_id, s.direction, s.message_kind, '[sale]',
                 'wamid.RYC-' || g
            FROM src s, generate_series(1, ${n - 1}::int) g
          RETURNING id, provider_message_id
        )
        INSERT INTO command_drafts (business_id, conversation_message_id, intent, command, model,
                                    previewed, requested_by, expires_at, created_at)
        SELECT s.business_id, c.id, s.intent, s.command, s.model, true, s.requested_by,
               s.expires_at, s.created_at
          FROM src s, copies c`),
    );
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

/**
 * Only what reached the merchant closes their refusal (CodeRabbit on #437 at 1db1a0a). A record
 * preview withdrawn when its send failed, or never previewed and no longer pending, is nothing they
 * read since the refusal: their yes is still about the refusal, never the sale they refused.
 */
describe('a preview that never reached the merchant keeps their refusal', () => {
  it.each([
    [
      'withdrawn when its send failed',
      sql`state = 'superseded', withdrawn = true, previewed = false`,
    ],
    ['never previewed, then superseded', sql`state = 'superseded', previewed = false`],
  ])('%s: the yes saves nothing', async (_, retire) => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.RW1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await post(mediaMessage('wamid.RW2', STICKER, OWNER));
    await drain();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    await say(
      'wamid.RW3',
      sale({ kind: 'token', token: bola.token }),
      'sold Bola Ige 2 wigs for 100k',
    );
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET ${retire}
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'
           AND command->'customer'->>'token' = ${bola.token}`),
    );
    const before = await footprint(business.id);

    await plain('wamid.RW4', 'yes');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    expect(await footprint(business.id)).toEqual(before);
  });
});

/**
 * A purchase question (G-61) closes the older previews it replaces, never another member's refusal
 * (CodeRabbit on #437 at ce75a9e): the delegate's next yes is about their refusal and books nothing.
 */
describe("a purchase question keeps another member's refusal", () => {
  it("the delegate's refusal stays pending and their yes books nothing", async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await post(mediaMessage('wamid.RG1', STICKER, DELEGATE));
    await drain();
    await say(
      'wamid.RG2',
      {
        intent: 'RecordPurchase',
        supplierMention: 'Emeka',
        description: '10 cartons',
        amount: 180_000,
        reportedPayment: 100_000,
        paymentMethod: null,
        productMention: null,
        quantity: null,
      },
      'I bought 10 cartons for 180k from Emeka, paid 100k',
    );
    expect(stubSender.lastText).toContain('Was that cash or transfer?');
    const refusals = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts
         WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'`),
    );
    expect([...refusals].map((r) => r.state)).toEqual(['pending']);
    const before = await footprint(business.id);

    await post(messagePayload(DELEGATE, 'wamid.RG3', 'yes'));
    await drain();
    expect(await footprint(business.id)).toEqual(before);
  });
});

/**
 * The owner's own preview that never reached them is no answer to their refusal (the rule
 * `hasDraftsAfterBy` applies), so it never stops the scan short of that refusal: the owner's yes is
 * about the refusal and books nothing, never the delegate's newer preview; the delegate still
 * confirms their own (CodeRabbit on #437 at cacc734).
 */
describe("an unseen preview never hides the sender's refusal", () => {
  it("so the owner's yes never books the delegate's preview", async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await post(mediaMessage('wamid.RU1', STICKER, OWNER));
    await drain();
    stubSender.failWith();
    await say('wamid.RU2', sale({ kind: 'none' }), 'sold 2 wigs for 100k');
    stubTransport.replyWith(sale({ kind: 'token', token: ada.token }));
    await post(messagePayload(DELEGATE, 'wamid.RU3', 'sold Ada Obi 2 wigs for 100k'));
    await drain();
    const before = await footprint(business.id);

    await plain('wamid.RU4', 'yes');
    expect(await footprint(business.id)).toEqual(before);

    await post(messagePayload(DELEGATE, 'wamid.RU5', 'yes'));
    await drain();
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });
});

/**
 * The owner's first DELETE MY DATA discards what was waiting, but never another member's refusal:
 * it is theirs to answer, so the delegate's next yes is about it and never confirms the owner's
 * newer preview, which the owner still can (CodeRabbit on #437 at aff3f63).
 */
describe("an erasure ask keeps another member's refusal", () => {
  it("so the delegate's yes books nothing and the owner's yes books the sale", async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await post(mediaMessage('wamid.RE1', STICKER, DELEGATE));
    await drain();
    await plain('wamid.RE2', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    const refusalState = async () =>
      [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ state: string }>(
            sql`SELECT state FROM command_drafts
                 WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'
                   AND requested_by = ${delegate.id}::uuid`,
          ),
        )),
      ].map((r) => r.state);
    expect(await refusalState()).toEqual(['pending']);

    await say('wamid.RE3', sale({ kind: 'none' }), 'sold 2 wigs for 100k');
    const before = await footprint(business.id);
    await post(messagePayload(DELEGATE, 'wamid.RE4', 'yes'));
    await drain();
    expect(await footprint(business.id)).toEqual(before);

    await plain('wamid.RE5', 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });
});

/**
 * The owner's refusal is answered before another member's retired funding question is asked
 * again: the owner's yes (or "na so?") after their own refusal is about that refusal, never an
 * opening of the delegate's question for the owner (CodeRabbit on #437 at aff3f63).
 */
describe("a yes after one's own refusal never re-asks another member's funding question", () => {
  const POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };
  const POS_QUESTION = 'did it come from your bank account or from physical cash?';

  it.each(['yes', 'na so?'])('the owner\'s "%s" answers their refusal', async (answer) => {
    const business = await seedMerchant();
    const owner = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await post(mediaMessage(`wamid.RF1-${answer}`, STICKER, OWNER));
    await drain();
    stubTransport.replyWith(POS_PURCHASE);
    await post(
      messagePayload(DELEGATE, `wamid.RF2-${answer}`, 'I bought 10 cartons for 180k, paid by POS'),
    );
    await drain();
    expect(stubSender.lastText).toContain(POS_QUESTION);
    const before = await footprint(business.id);

    await plain(`wamid.RF3-${answer}`, answer);
    expect(stubSender.lastText).not.toContain(POS_QUESTION);
    expect(await footprint(business.id)).toEqual(before);
    /* No funding answer was opened for the owner: their "cash" would be about nothing. */
    const open = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM conversation_continuations
             WHERE business_id = ${business.id}::uuid AND user_id = ${owner.id}::uuid
               AND state = 'open'`,
      ),
    ).then((r) => r[0]!.n);
    expect(open).toBe(0);
  });
});

/** The state of the sender's refusal drafts, oldest first. */
const refusalStates = async (businessId: string, userId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(
        sql`SELECT state FROM command_drafts
             WHERE business_id = ${businessId}::uuid AND command->>'refused' = 'true'
               AND requested_by = ${userId}::uuid ORDER BY insertion_seq`,
      ),
    )),
  ].map((r) => r.state);

/**
 * The sender's own record whose preview never reached them hides no refusal of theirs, in a
 * questioned yes as in a plain one (CodeRabbit on #437 at b2703e7): behind another member's preview,
 * "na so?" answers as the plain yes does, never by inviting a yes that cannot save the sender's
 * own record.
 */
describe("a questioned yes looks past the sender's own unseen record", () => {
  it('to their refusal, as the plain yes does, and changes nothing', async () => {
    const business = await seedMerchant();
    const owner = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await post(mediaMessage('wamid.RQ1', STICKER, OWNER));
    await drain();
    await say('wamid.RQ2', sale({ kind: 'none' }), 'sold 2 wigs for 100k');
    /* The owner's record is still waiting, but its preview never reached them. */
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET previewed = false
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'
           AND requested_by = ${owner.id}::uuid`),
    );
    stubTransport.replyWith(sale({ kind: 'none' }));
    await post(messagePayload(DELEGATE, 'wamid.RQ3', 'sold 3 wigs for 150k'));
    await drain();
    const before = await footprint(business.id);

    await plain('wamid.RQ4', 'na so?');
    expect(stubSender.lastText).toBe(replies.previewWaitingForAnotherMember().text);
    expect(await refusalStates(business.id, owner.id)).toEqual(['pending']);
    expect(await footprint(business.id)).toEqual(before);

    await plain('wamid.RQ5', 'yes');
    expect(stubSender.lastText).toBe(replies.previewWaitingForAnotherMember().text);
    expect((await footprint(business.id)).invoices).toBe(before.invoices);
  });
});

/**
 * A questioned yes changes nothing (CodeRabbit on #437 at b2703e7): the scan that decides whether
 * the sender's own refusal stands behind another member's retired question looks past a stale
 * refusal of theirs and never closes it.
 */
describe("a questioned yes before another member's funding question", () => {
  it("leaves the sender's stale refusal as it was", async () => {
    const business = await seedMerchant();
    const owner = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await post(mediaMessage('wamid.RS1', STICKER, OWNER));
    await drain();
    /* A preview the owner was shown since, no longer waiting: their refusal is stale. */
    await say('wamid.RS2', sale({ kind: 'none' }), 'sold 2 wigs for 100k');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET state = 'superseded'
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'
           AND requested_by = ${owner.id}::uuid`),
    );
    stubTransport.replyWith({
      intent: 'RecordPurchase',
      supplierMention: 'Emeka',
      description: '10 cartons',
      amount: 180_000,
      reportedPayment: 180_000,
      paymentMethod: 'pos',
      productMention: 'cartons',
      quantity: 10,
    });
    await post(messagePayload(DELEGATE, 'wamid.RS3', 'I bought 10 cartons for 180k, paid by POS'));
    await drain();
    expect(await refusalStates(business.id, owner.id)).toEqual(['pending']);
    const before = await footprint(business.id);

    await plain('wamid.RS4', 'yes?');
    expect(await refusalStates(business.id, owner.id)).toEqual(['pending']);
    expect(await footprint(business.id)).toEqual(before);
  });
});
