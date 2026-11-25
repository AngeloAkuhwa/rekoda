/**
 * CodeRabbit on #437 (PRRT_kwDOT845J8676qPh): a repeated "yes" must never book a preview while a
 * failed receipt for the pointer reply that stood in front of it is stored and not yet applied.
 *
 * A first "yes" to a preview behind a question retires the question and is answered with a pointer
 * ("a preview is waiting, reply yes"). If WhatsApp accepts that reply and later reports it failed,
 * the receipt puts the question back, so the merchant's repeated yes is pointed again. A second
 * "yes" whose job was created BEFORE the receipt's job used to run first, find no question, and
 * book; the restoration then came too late to undo it. The financial footprint is asserted, never
 * only the reply.
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { sql, withBusiness } from '@rekoda/db';
import {
  db,
  messagePayload,
  post,
  stubSender,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { drain } from './meta-voice-note.fixtures.js';
import { lastWamid, receipt } from './meta-preview-expiry.fixtures.js';
import {
  OWNER,
  footprint,
  plain,
  sale,
  say,
  seedMerchant,
} from './meta-customer-token.fixtures.js';
import { deps } from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

const QUESTION = {
  intent: 'Query',
  topic: 'sales_summary',
  customer: null,
  period: 'today',
  periodText: 'today',
  format: 'chat',
};

/** A preview, a question after it, and a first yes answered with a pointer WhatsApp accepted. */
async function pointedAt(tag: string) {
  const business = await seedMerchant();
  const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
  await say(
    `wamid.${tag}1`,
    sale({ kind: 'token', token: ada.token }),
    'sold Ada Obi 2 wigs for 100k',
  );
  await say(`wamid.${tag}2`, QUESTION, 'how much did I sell today');
  const before = await footprint(business.id);
  await plain(`wamid.${tag}3`, 'yes');
  expect(stubSender.lastText).toBe(replies.previewBehindQuestion().text);
  return { business, before, pointer: lastWamid() };
}

/** The deferred yes is re-queued half a second out (`deferClaimed`): let it come due, then run it. */
async function settle(): Promise<void> {
  await drain();
  await new Promise((resolve) => setTimeout(resolve, 700));
  await drain();
}

const states = async (businessId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{ intent: string; state: string }>(sql`
        SELECT intent, state FROM command_drafts
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
    )),
  ].map((r) => `${r.intent}:${r.state}`);

describe('a repeated yes and a failed receipt for the pointer reply (CodeRabbit on #437)', () => {
  it('the receipt is stored after the second yes was queued: the yes books nothing, in either run order', async () => {
    const { business, before, pointer } = await pointedAt('RC1');

    await post(messagePayload(OWNER, 'wamid.RC1-yes2', 'yes'));
    await receipt(OWNER, pointer, 'failed');
    await drain();
    /* Held, not booked: the yes waits for the receipt (nothing sent, nothing written). */
    expect(await footprint(business.id)).toEqual(before);

    await settle();
    expect(await footprint(business.id)).toEqual(before);
    /* The receipt put the question back and the waiting yes was pointed again, so the merchant is
     * told what the first pointer failed to say; the yes after that is the one that books. */
    expect(stubSender.lastText).toBe(replies.previewBehindQuestion().text);
    expect(await states(business.id)).toEqual(['RecordSale:pending', 'Query:superseded']);
  });

  it('a later yes, after the receipt was applied and the pointer re-read, books once', async () => {
    const { business, before, pointer } = await pointedAt('RC2');

    await post(messagePayload(OWNER, 'wamid.RC2-yes2', 'yes'));
    await receipt(OWNER, pointer, 'failed');
    await settle();
    expect(await footprint(business.id)).toEqual(before);
    /* Read this time: the yes after the second pointer saves the preview, once. */
    await plain('wamid.RC2-yes3', 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
    await plain('wamid.RC2-yes4', 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });

  it('a receipt applied before the second yes behaves the same: nothing booked', async () => {
    const { business, before, pointer } = await pointedAt('RC3');

    await receipt(OWNER, pointer, 'failed');
    await drain();
    await plain('wamid.RC3-yes2', 'yes');

    expect(await footprint(business.id)).toEqual(before);
    expect(stubSender.lastText).toBe(replies.previewBehindQuestion().text);
  });

  it('duplicate failed receipts change nothing more than one', async () => {
    const { business, before, pointer } = await pointedAt('RC4');

    await post(messagePayload(OWNER, 'wamid.RC4-yes2', 'yes'));
    await receipt(OWNER, pointer, 'failed');
    await receipt(OWNER, pointer, 'failed');
    await settle();

    expect(await footprint(business.id)).toEqual(before);
    expect(await states(business.id)).toEqual(['RecordSale:pending', 'Query:superseded']);
  });

  it('a pointer WhatsApp delivered: the second yes books once, and there is nothing to wait for', async () => {
    const { business, before } = await pointedAt('RC5');

    await post(messagePayload(OWNER, 'wamid.RC5-yes2', 'yes'));
    await drain();

    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });

  it('two yeses queued together with the receipt book exactly once, never twice', async () => {
    const { business, before, pointer } = await pointedAt('RC6');

    await post(messagePayload(OWNER, 'wamid.RC6-yes2', 'yes'));
    await post(messagePayload(OWNER, 'wamid.RC6-yes3', 'yes'));
    await receipt(OWNER, pointer, 'failed');
    await settle();

    /* The first yes is pointed again (the receipt was applied before it ran); the second reads that
     * pointer and books. One invoice, not two, and none before the pointer was re-read. */
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });
});
