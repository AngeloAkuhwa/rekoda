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
import { lastWamid, receipt } from './meta-preview-expiry.fixtures.js';

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

/* Accepted by WhatsApp and then reported failed: the merchant never read the consequence either,
 * so the late receipt retires the first ask and the next exact phrase only asks again
 * (CodeRabbit on #437 at 1db1a0a). */
describe('an erasure whose first prompt failed after WhatsApp accepted it', () => {
  it('erases only after a prompt that was delivered', async () => {
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

    await say('DELETE MY DATA', 'wamid.F1');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    await receipt(OWNER, lastWamid(), 'failed');
    await drain();

    await say('DELETE MY DATA', 'wamid.F2');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    expect(await claimed()).toBe(0);

    await say('DELETE MY DATA', 'wamid.F3');
    expect(stubSender.lastText).not.toBe(replies.confirmErasure().text);
    expect(await claimed()).toBe(1);
  });
});

/* Judged at the second ask's arrival, not a late worker's clock (CodeRabbit on #437 at 0114957 and
 * ce75a9e): a first ask recorded under an older consequence whose confirmation was still open when
 * the second ask ARRIVED is asked again, even if it lapsed by the time the job ran. */
describe('an erasure whose second ask is processed after the first confirmation lapsed', () => {
  it('still checks the consequence shown at the first ask, and erases nothing', async () => {
    const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await say('DELETE MY DATA', 'wamid.W1');
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        UPDATE pending_confirmations
           SET consequence = 'Every customer contact detail for this business will be permanently deleted.'
         WHERE business_id = ${business.id}::uuid AND command = 'EraseData'`);
      /* The second ask arrives now; its confirmation lapses a moment after it arrived. */
      await post(messagePayload(OWNER, 'wamid.W2', 'DELETE MY DATA'));
      await ownerDb.execute(sql`
        UPDATE pending_confirmations
           SET expires_at = (SELECT created_at FROM external_events
                              WHERE external_id = 'wamid.W2') + interval '1 millisecond'
         WHERE business_id = ${business.id}::uuid AND command = 'EraseData'`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await close();
    }
    await drain();

    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    const claimed = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pending_confirmations
             WHERE business_id = ${business.id}::uuid AND command = 'EraseData'
               AND claimed_at IS NOT NULL`,
      ),
    ).then((r) => r[0]?.n);
    expect(claimed).toBe(0);
  });
});
