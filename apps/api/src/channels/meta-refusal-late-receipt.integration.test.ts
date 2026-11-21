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

    const business = await saleAndRefusal('LX');
    await receipt(OWNER, theirs, 'failed');
    await drain();
    expect(await refusalStates(shop.id)).toEqual([`+${DELEGATE}:superseded`]);
    expect(await refusalStates(business.id)).toEqual([`+${OWNER}:pending`]);
  });
});
