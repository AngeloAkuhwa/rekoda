/**
 * CodeRabbit on #437 at c5392f0 (conversations.ts `hasLivePointerReceipt`): a failed receipt for the
 * pointer reply ("a preview is waiting") holds a repeated yes until it is applied, whatever state its
 * job is in.
 *
 * The inbound "yes" applies dead receipts first (`reconcileDeadReceipts`) and checks for a live one
 * just before it claims the draft. The runner records a job's death without the business's inbound
 * lock, so a receipt can die between those two reads: the first passed it while it was running, and a
 * hold that looked only at pending or running jobs would no longer see it, and the yes would book a
 * preview the merchant was never told is waiting. A dead receipt whose event is not yet processed
 * holds the yes exactly as a live one does; once applied, it holds nothing.
 */
import { expect, it } from 'vitest';
import { createDb, withBusiness, sql, conversationsRepo } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { deps, stubSender, urls, useMetaWebhookHarness, db } from './meta-webhook.fixtures.js';
import { lastWamid, receipt } from './meta-preview-expiry.fixtures.js';
import { OWNER, plain, sale, say, seedMerchant } from './meta-customer-token.fixtures.js';

useMetaWebhookHarness();

const QUESTION = {
  intent: 'Query',
  topic: 'sales_summary',
  customer: null,
  period: 'today',
  periodText: 'today',
  format: 'chat',
};

it('a failed pointer receipt whose job died unapplied still holds the yes', async () => {
  const business = await seedMerchant();
  const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
  await say('wamid.PD1', sale({ kind: 'token', token: ada.token }), 'sold Ada Obi 2 wigs for 100k');
  await say('wamid.PD2', QUESTION, 'how much did I sell today');
  await plain('wamid.PD3', 'yes');
  expect(stubSender.lastText).toBe(replies.previewBehindQuestion().text);
  const pointer = lastWamid();

  /* The receipt is stored and its job is queued, then dies before it is applied. */
  await receipt(OWNER, pointer, 'failed');
  const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
  try {
    await ownerDb.execute(sql`
      UPDATE jobs SET state = 'dead'
       WHERE business_id = ${business.id}::uuid AND kind = 'delivery.status'`);
  } finally {
    await close();
  }

  const held = await withBusiness(db, business.id, async (tx) => {
    const [preview] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM command_drafts
       WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'`);
    const before = await conversationsRepo.hasLivePointerReceipt(
      tx,
      business.id,
      preview!.id,
      null,
    );
    /* Applied, it holds nothing more: the question it put back guards the preview instead. */
    await conversationsRepo.reconcileDeadReceipts(tx, business.id);
    const after = await conversationsRepo.hasLivePointerReceipt(tx, business.id, preview!.id, null);
    return { before, after };
  });
  expect(held).toEqual({ before: 'question', after: null });
});
