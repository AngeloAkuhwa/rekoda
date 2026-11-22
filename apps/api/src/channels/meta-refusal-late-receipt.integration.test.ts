/**
 * OD-62(o): WhatsApp ACCEPTS the answer to a member's own refusal and later reports it `failed`.
 *
 * The merchant never read "reply yes to save it", so their repeated yes is about the refusal again,
 * exactly as after a send that failed outright (`reopenClosedDrafts`, Codex on #437 at 3d66867).
 * Before this, the late receipt left the refusal closed and the yes booked the older sale (Codex on
 * #437 at 58dd68b). The financial footprint is asserted, never only the reply.
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
import { lastWamid, receipt } from './meta-preview-expiry.fixtures.js';
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

/** Meta's later `failed` receipt for the reply just sent, run to completion. */
async function lateFailure(): Promise<void> {
  await receipt(OWNER, lastWamid(), 'failed');
  await drain();
}

/** Each refusal as "<sender phone>:<state>", oldest first. */
async function refusalStates(businessId: string): Promise<string[]> {
  const phones = new Map<string, string>();
  for (const phone of [OWNER, DELEGATE]) {
    phones.set((await identity.upsertUserByPhone(db, `+${phone}`)).id, `+${phone}`);
  }
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string; by: string | null }>(sql`
      SELECT state, requested_by::text AS by FROM command_drafts
       WHERE business_id = ${businessId}::uuid AND command->>'refused' = 'true'
       ORDER BY insertion_seq`),
  );
  return [...rows].map((r) => `${phones.get(r.by ?? '') ?? 'nobody'}:${r.state}`);
}

async function saleAndRefusal(tag: string) {
  const business = await seedMerchant();
  const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
  await say(
    `wamid.${tag}1`,
    sale({ kind: 'token', token: ada.token }),
    'sold Ada Obi 2 wigs for 100k',
  );
  await post(mediaMessage(`wamid.${tag}2`, STICKER, OWNER));
  await drain();
  return business;
}

describe('a late failed receipt for the answer to a refusal (OD-62(o))', () => {
  /* A "no" to the refusal points at the same preview (the deny path), so it is put back the same way. */
  it.each(['yes', 'no'])(
    'after "%s": the refusal is back, the repeated yes saves nothing, the next yes saves the preview',
    async (answer) => {
      const business = await saleAndRefusal(`LR${answer}`);
      const before = await footprint(business.id);

      await plain(`wamid.LR3-${answer}`, answer);
      expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
      await lateFailure();

      await plain(`wamid.LR4-${answer}`, 'yes');
      expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
      expect(await footprint(business.id)).toEqual(before);
      /* Read and answered this time: the yes the reply promised saves the preview, once. */
      await plain(`wamid.LR5-${answer}`, 'yes');
      expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
    },
  );

  it('puts back the question the answer retired with it', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.LQ1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say('wamid.LQ2', QUESTION, 'how much did I sell today');
    await post(mediaMessage('wamid.LQ3', STICKER, OWNER));
    await drain();
    const before = await footprint(business.id);

    await plain('wamid.LQ4', 'yes');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    await lateFailure();
    const reads = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts WHERE business_id = ${business.id}::uuid AND intent = 'Query'`),
    );
    expect([...reads].map((r) => r.state)).toEqual(['pending']);

    await plain('wamid.LQ5', 'yes');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    expect(await footprint(business.id)).toEqual(before);
  });

  it('applies a duplicated receipt once', async () => {
    const business = await saleAndRefusal('LD');
    const before = await footprint(business.id);
    await plain('wamid.LD3', 'yes');
    const wamid = lastWamid();
    await receipt(OWNER, wamid, 'failed');
    await receipt(OWNER, wamid, 'failed');
    await drain();

    expect(await refusalStates(business.id)).toEqual([`+${OWNER}:pending`]);
    await plain('wamid.LD4', 'yes');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    expect(await footprint(business.id)).toEqual(before);
  });

  it('after a newer preview, the yes confirms only that newer preview', async () => {
    const business = await saleAndRefusal('LN');
    const before = await footprint(business.id);
    await plain('wamid.LN3', 'yes');
    const answer = lastWamid();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    await say(
      'wamid.LN4',
      sale({ kind: 'token', token: bola.token }),
      'sold Bola Ige 2 wigs for 100k',
    );
    await receipt(OWNER, answer, 'failed');
    await drain();

    await plain('wamid.LN5', 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
    const invoiced = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ customer_id: string | null }>(sql`
        SELECT customer_id FROM invoices WHERE business_id = ${business.id}::uuid`),
    );
    expect([...invoiced].map((r) => r.customer_id)).toEqual([bola.customerId]);
  });

  it("restores only the member's own refusal, never another member's", async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.LM1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await post(mediaMessage('wamid.LM2', STICKER, DELEGATE));
    await post(mediaMessage('wamid.LM3', STICKER, OWNER));
    await drain();
    const before = await footprint(business.id);

    await plain('wamid.LM4', 'yes');
    expect(await refusalStates(business.id)).toEqual([
      `+${DELEGATE}:pending`,
      `+${OWNER}:superseded`,
    ]);
    await lateFailure();
    expect(await refusalStates(business.id)).toEqual([`+${DELEGATE}:pending`, `+${OWNER}:pending`]);

    await post(messagePayload(OWNER, 'wamid.LM5', 'yes'));
    await drain();
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    expect(await footprint(business.id)).toEqual(before);
  });
});

describe('a late failed receipt never reaches past its own reply (OD-62(o))', () => {
  it('after the preview was already booked, the restored refusal books nothing more', async () => {
    const business = await saleAndRefusal('LB');
    const before = await footprint(business.id);
    await plain('wamid.LB3', 'yes');
    const answer = lastWamid();
    await plain('wamid.LB4', 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);

    await receipt(OWNER, answer, 'failed');
    await drain();
    await plain('wamid.LB5', 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });

  it("another business's reply id restores nothing in this business", async () => {
    const other = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    const shop = await identity.createBusinessWithOwner(db, {
      name: 'Other Shop',
      businessType: null,
      ownerUserId: other.id,
    });
    await post(mediaMessage('wamid.LY1', STICKER, DELEGATE));
    await drain();
    await post(messagePayload(DELEGATE, 'wamid.LY2', 'yes'));
    await drain();
    const theirs = lastWamid();
    expect(await refusalStates(shop.id)).toEqual([`+${DELEGATE}:superseded`]);

    /* This business's own refusal is answered too, so a receipt that matched by reply id alone,
     * across businesses, would have something here to put back. */
    const business = await saleAndRefusal('LX');
    await plain('wamid.LX3', 'yes');
    expect(await refusalStates(business.id)).toEqual([`+${OWNER}:superseded`]);
    await receipt(OWNER, theirs, 'failed');
    await drain();
    expect(await refusalStates(shop.id)).toEqual([`+${DELEGATE}:superseded`]);
    expect(await refusalStates(business.id)).toEqual([`+${OWNER}:superseded`]);
  });
});

/* Only what the member read closes their refusal: an answer to a question WhatsApp accepted and
 * then reported failed was never read, so it never stands between the refusal and the next yes
 * (CodeRabbit on #437 at ccdcc8e). The yes is about the refusal, and the sale is not booked by it. */
describe('a question whose answer was reported failed after a refusal', () => {
  it('leaves the refusal to the next yes, which books nothing', async () => {
    const business = await saleAndRefusal('LQF');
    const before = await footprint(business.id);

    await say('wamid.LQF3', QUESTION, 'how much did I sell today');
    await lateFailure();

    await plain('wamid.LQF4', 'yes');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    expect(await footprint(business.id)).toEqual(before);
    const query = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string; reason: string | null }>(sql`
        SELECT state, retired_reason AS reason FROM command_drafts
         WHERE business_id = ${business.id}::uuid AND intent = 'Query'`),
    );
    expect([...query]).toEqual([{ state: 'superseded', reason: 'preview_not_delivered' }]);
  });
});

/* The same for an answer whose send failed outright (Codex on #437 at cacc734): never read, so it
 * never stands between the refusal and the next yes. */
describe('a question whose answer failed to send after a refusal', () => {
  it('leaves the refusal to the next yes, which books nothing', async () => {
    const business = await saleAndRefusal('LQS');
    const before = await footprint(business.id);

    stubSender.failWith();
    await say('wamid.LQS3', QUESTION, 'how much did I sell today');

    await plain('wamid.LQS4', 'yes');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    expect(await footprint(business.id)).toEqual(before);
    expect(await queryStates(business.id)).toEqual(['superseded:preview_not_delivered']);
  });
});

/* A question answer reported failed is never put back to pending by the refusal's own later
 * failure, whichever receipt arrives first (CodeRabbit on #437 at cacc734). */
describe('a failed question answer and a failed refusal answer, in either order', () => {
  it.each(['question first', 'refusal first'])('%s: the question stays retired', async (order) => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    const tag = order === 'question first' ? 'LO1' : 'LO2';
    await say(
      `wamid.${tag}a`,
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say(`wamid.${tag}b`, QUESTION, 'how much did I sell today');
    const questionAnswer = lastWamid();
    await post(mediaMessage(`wamid.${tag}c`, STICKER, OWNER));
    await drain();
    await plain(`wamid.${tag}d`, 'yes');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    const refusalAnswer = lastWamid();

    for (const wamid of order === 'question first'
      ? [questionAnswer, refusalAnswer]
      : [refusalAnswer, questionAnswer]) {
      await receipt(OWNER, wamid, 'failed');
      await drain();
    }
    expect(await queryStates(business.id)).toEqual(['superseded:preview_not_delivered']);
  });
});

async function queryStates(businessId: string): Promise<string[]> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string; reason: string | null }>(sql`
      SELECT state, retired_reason AS reason FROM command_drafts
       WHERE business_id = ${businessId}::uuid AND intent = 'Query' ORDER BY insertion_seq`),
  );
  return [...rows].map((r) => `${r.state}:${r.reason ?? ''}`);
}

/**
 * A held purchase's identity question that WhatsApp accepted and then reported failed asked
 * nobody: the held purchase is withdrawn, as it is when the question's send fails at once
 * (OWN-102(4)), so it is not something its member read since their refusal. The member's next yes
 * is about their refusal, never another member's newer preview (CodeRabbit on #437 at aff3f63).
 */
describe('a held purchase whose question failed late', () => {
  const RICE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '5 bags of rice',
    amount: 50_000,
    reportedPayment: 50_000,
    paymentMethod: 'cash',
    productMention: 'bags of rice',
    quantity: 5,
  };

  it("is withdrawn, and the member's yes answers their refusal and books nothing", async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await say('wamid.HL1', RICE, 'bought 5 bags rice 50k cash');
    await post(mediaMessage('wamid.HL2', STICKER, DELEGATE));
    await drain();
    stubTransport.replyWith(RICE);
    await post(messagePayload(DELEGATE, 'wamid.HL3', 'bought 5 bags rice 50k cash'));
    await drain();
    expect(stubSender.lastText).toContain('Is this the same purchase?');
    await receipt(DELEGATE, lastWamid(), 'failed');
    await drain();
    const held = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string; withdrawn: boolean }>(sql`
        SELECT state, withdrawn FROM command_drafts
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordPurchase'
           AND requested_by = ${delegate.id}::uuid`),
    );
    expect([...held]).toEqual([{ state: 'superseded', withdrawn: true }]);

    await say('wamid.HL4', sale({ kind: 'none' }), 'sold 2 wigs for 100k');
    const before = await footprint(business.id);
    await post(messagePayload(DELEGATE, 'wamid.HL5', 'yes'));
    await drain();
    expect(await footprint(business.id)).toEqual(before);
    expect(await refusalStates(business.id)).toEqual([`+${DELEGATE}:superseded`]);
  });
});

/* A clarification question whose send failed, at once or later, was never read either (CodeRabbit on
 * #437 at 88258dc): it never stands between the member's refusal and their yes, so that yes never
 * books another member's newer preview. */
describe("an undelivered clarification before another member's preview", () => {
  /* "after it expired" or "superseded": the receipt arrives once the question has lapsed or been
   * retired (CodeRabbit on #437 at b8330cd and 503acf3). */
  it.each(['at once', 'later', 'after it expired', 'after it was superseded'])(
    "failed %s: the member's yes answers their refusal and books nothing",
    async (when) => {
      const business = await seedMerchant();
      const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      await post(mediaMessage(`wamid.UC1-${when}`, STICKER, OWNER));
      await drain();
      if (when === 'at once') stubSender.failWith();
      await say(
        `wamid.UC2-${when}`,
        { intent: 'Unclear', clarification: 'Which customer was that for?' },
        'sold 2 wigs',
      );
      if (when.startsWith('after')) {
        const state = when === 'after it expired' ? 'expired' : 'superseded';
        await withBusiness(db, business.id, (tx) =>
          tx.execute(sql`UPDATE command_drafts SET state = ${state} WHERE intent = 'Unclear'
                            AND COALESCE(command->>'refused', '') <> 'true'`),
        );
      }
      if (when !== 'at once') await lateFailure();
      stubTransport.replyWith(sale({ kind: 'none' }));
      await post(messagePayload(DELEGATE, `wamid.UC3-${when}`, 'sold 3 wigs for 150k'));
      await drain();
      const before = await footprint(business.id);

      await plain(`wamid.UC4-${when}`, 'yes');
      expect(await footprint(business.id)).toEqual(before);
    },
  );
});
