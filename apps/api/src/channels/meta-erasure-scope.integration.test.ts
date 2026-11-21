/**
 * DELETE MY DATA runs only on a consequence the merchant was shown (Appendix D, R4): a first ask
 * recorded with an older, narrower consequence is shown again and recorded now, and only the next
 * exact phrase erases (CodeRabbit on #437 at 3d66867).
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { createDb, identity, sql, withBusiness } from '@rekoda/db';
import { db, messagePayload, post, urls, useMetaWebhookHarness } from './meta-webhook.fixtures.js';
import { stubSender } from './meta-webhook.fixtures.js';
import { drain } from './meta-voice-note.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';

async function say(text: string, wamid: string) {
  await post(messagePayload(OWNER, wamid, text));
  await drain();
}

describe('an erasure asked under an older consequence', () => {
  it('is asked again under the current one before anything is erased', async () => {
    const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await say('DELETE MY DATA', 'wamid.E1');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);

    /* The first ask was recorded before the erasure reached stored chat copies. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        UPDATE pending_confirmations
           SET consequence = 'Every customer contact detail for this business will be permanently deleted.'
         WHERE business_id = ${business.id}::uuid AND command = 'EraseData'`);
    } finally {
      await close();
    }

    await say('DELETE MY DATA', 'wamid.E2');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    const claimed = () =>
      withBusiness(db, business.id, (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pending_confirmations
               WHERE business_id = ${business.id}::uuid AND command = 'EraseData'
                 AND claimed_at IS NOT NULL`,
        ),
      ).then((r) => r[0]?.n);
    expect(await claimed()).toBe(0);

    await say('DELETE MY DATA', 'wamid.E3');
    expect(stubSender.lastText).not.toBe(replies.confirmErasure().text);
    expect(await claimed()).toBe(1);
  });
});

/* A first ask whose prompt never reached WhatsApp showed the merchant nothing: the next exact
 * phrase is shown the prompt and keeps the data (CodeRabbit on #437 at 58dd68b). */
describe('an erasure whose first prompt was never sent', () => {
  it('erases only after a prompt that was sent', async () => {
    const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const claimed = () =>
      withBusiness(db, business.id, (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pending_confirmations
               WHERE business_id = ${business.id}::uuid AND command = 'EraseData'
                 AND claimed_at IS NOT NULL`,
        ),
      ).then((r) => r[0]?.n);

    stubSender.failWith();
    await say('DELETE MY DATA', 'wamid.U1');
    await say('DELETE MY DATA', 'wamid.U2');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    expect(await claimed()).toBe(0);

    await say('DELETE MY DATA', 'wamid.U3');
    expect(stubSender.lastText).not.toBe(replies.confirmErasure().text);
    expect(await claimed()).toBe(1);
  });
});
