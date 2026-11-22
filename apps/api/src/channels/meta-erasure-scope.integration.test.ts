/**
 * DELETE MY DATA runs only on a consequence the merchant was shown (Appendix D, R4): a first ask
 * recorded with an older, narrower consequence is shown again and recorded now, and only the next
 * exact phrase erases (CodeRabbit on #437 at 3d66867).
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { createDb, identity, sql, withBusiness } from '@rekoda/db';
import { ownerDb } from '@rekoda/db/testing';
import {
  db,
  deps,
  messagePayload,
  post,
  urls,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { stubSender } from './meta-webhook.fixtures.js';
import { drain } from './meta-voice-note.fixtures.js';
import { lastWamid, receipt } from './meta-preview-expiry.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';

/** How many vaulted customer details the business holds: what an erasure deletes. */
const facetsOf = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM customer_identities
           WHERE business_id = ${businessId}::uuid`,
    ),
  ).then((r) => r[0]!.n);

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
    await deps.gateway.resolveMention(business.id, 'Bola Ige');
    const facets = await facetsOf(business.id);
    expect(facets).toBeGreaterThan(0);
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

    /* The second ask erased nothing. */
    expect(await facetsOf(business.id)).toBe(facets);

    await say('DELETE MY DATA', 'wamid.E3');
    expect(stubSender.lastText).not.toBe(replies.confirmErasure().text);
    expect(stubSender.lastText).toMatch(/^Done\. Your customers' saved details are deleted/);
    expect(await claimed()).toBe(1);
    expect(await facetsOf(business.id)).toBe(0);
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

/* A failure receipt for the first prompt stored before the second ask is processed counts at once
 * (CodeRabbit on #437 at b2703e7). One queued BEFORE the ask already holds the ask back
 * (`hasEarlierLiveJob`); one that arrives after the ask but before it runs is not waited for, and
 * still erases nothing: an irreversible erasure is never run on a prompt WhatsApp says failed. */
describe('an erasure whose first prompt is reported failed while the second ask waits', () => {
  it('erases nothing, and the next ask is a new first ask', async () => {
    const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await deps.gateway.resolveMention(business.id, 'Bola Ige');
    const before = await facetsOf(business.id);
    expect(before).toBeGreaterThan(0);
    const claimed = () =>
      withBusiness(db, business.id, (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pending_confirmations
               WHERE business_id = ${business.id}::uuid AND command = 'EraseData'
                 AND claimed_at IS NOT NULL`,
        ),
      ).then((r) => r[0]?.n);

    await say('DELETE MY DATA', 'wamid.FP1');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    const prompt = lastWamid();
    /* The second ask is queued, then the receipt for the first prompt: its job comes after the ask's,
     * so the ask is not held back by it. */
    await post(messagePayload(OWNER, 'wamid.FP2', 'DELETE MY DATA'));
    await receipt(OWNER, prompt, 'failed');
    const queued = await withBusiness(ownerDb(), business.id, (tx) =>
      tx.execute<{ kind: string }>(sql`
        SELECT kind FROM jobs WHERE business_id = ${business.id}::uuid AND state = 'pending'
         ORDER BY created_at, id`),
    );
    expect([...queued].map((j) => j.kind)).toEqual(['inbound.message', 'delivery.status']);
    await drain();

    expect(await claimed()).toBe(0);
    expect(await facetsOf(business.id)).toBe(before);
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
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

/* A first ask with no recorded consequence at all (one parked before recording became mandatory,
 * or whose record is gone) showed the merchant nothing this system can prove: the next exact
 * phrase is asked again and recorded, and erases nothing (CodeRabbit on #437 at 56c4140). */
describe('an erasure whose first ask has no recorded consequence', () => {
  it('is asked again before anything is erased', async () => {
    const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await deps.gateway.resolveMention(business.id, 'Bola Ige');
    const facets = await facetsOf(business.id);
    expect(facets).toBeGreaterThan(0);
    await say('DELETE MY DATA', 'wamid.L1');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);

    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        DELETE FROM pending_confirmations
         WHERE business_id = ${business.id}::uuid AND command = 'EraseData'`);
    } finally {
      await close();
    }
    const claimed = () =>
      withBusiness(db, business.id, (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pending_confirmations
               WHERE business_id = ${business.id}::uuid AND command = 'EraseData'
                 AND claimed_at IS NOT NULL`,
        ),
      ).then((r) => r[0]?.n);

    await say('DELETE MY DATA', 'wamid.L2');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    expect(await claimed()).toBe(0);

    /* The second ask erased nothing. */
    expect(await facetsOf(business.id)).toBe(facets);

    await say('DELETE MY DATA', 'wamid.L3');
    expect(stubSender.lastText).not.toBe(replies.confirmErasure().text);
    expect(stubSender.lastText).toMatch(/^Done\. Your customers' saved details are deleted/);
    expect(await claimed()).toBe(1);
    expect(await facetsOf(business.id)).toBe(0);
  });
});

/* OWN-102(7): the second ask is judged at its arrival. One that arrived while the first ask's
 * confirmation stood erases under THAT confirmation, however late the worker runs it, and no fresh
 * confirmation is ever opened in its place (CodeRabbit on #437 at cacc734). */
describe('an erasure whose second ask is processed after the confirmation lapsed', () => {
  it('erases under the confirmation that stood at arrival, and opens no other', async () => {
    const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await deps.gateway.resolveMention(business.id, 'Bola Ige');
    await say('DELETE MY DATA', 'wamid.LA1');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);

    await post(messagePayload(OWNER, 'wamid.LA2', 'DELETE MY DATA'));
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        UPDATE pending_confirmations SET expires_at = clock_timestamp()
         WHERE business_id = ${business.id}::uuid AND command = 'EraseData'`);
    } finally {
      await close();
    }
    await new Promise((r) => setTimeout(r, 30));
    await drain();

    expect(stubSender.lastText).toMatch(/^Done\. Your customers' saved details are deleted/);
    expect(await facetsOf(business.id)).toBe(0);
    const confirmations = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pending_confirmations
             WHERE business_id = ${business.id}::uuid AND command = 'EraseData'`,
      ),
    ).then((r) => r[0]!.n);
    expect(confirmations).toBe(1);
  });
});

/**
 * The second ask erases only if the first ask's prompt was on its way before the second arrived
 * (OWN-102(7): arrival and delivery evidence; CodeRabbit on #437 at aff3f63). A prompt recorded
 * after the second ask reached Rekoda was not what the merchant answered: the second ask is a new
 * first ask, and nothing is erased.
 */
describe('an erasure ask that arrived before the first prompt was sent', () => {
  async function seedWithContact() {
    const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await deps.gateway.resolveMention(business.id, 'Bola Ige');
    return business;
  }

  it('sent twice at once, the second ask erases nothing', async () => {
    const business = await seedWithContact();
    const facets = await facetsOf(business.id);
    await post(messagePayload(OWNER, 'wamid.ET1', 'DELETE MY DATA'));
    await post(messagePayload(OWNER, 'wamid.ET2', 'DELETE MY DATA'));
    await drain();
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    expect(await facetsOf(business.id)).toBe(facets);
  });

  /* The second ask reaches Rekoda while the first prompt is still being sent: WhatsApp had not yet
   * accepted it, so the merchant could not have read it (CodeRabbit on #437 at 4d9fa80). */
  it('arriving while the first prompt is in flight, it erases nothing', async () => {
    const business = await seedWithContact();
    const facets = await facetsOf(business.id);
    const send = stubSender.send.bind(stubSender);
    let injected = false;
    stubSender.send = async (message) => {
      if (!injected && message.text.includes('Reply *DELETE MY DATA* again')) {
        injected = true;
        await post(messagePayload(OWNER, 'wamid.EF2', 'DELETE MY DATA'));
      }
      return send(message);
    };
    try {
      await post(messagePayload(OWNER, 'wamid.EF1', 'DELETE MY DATA'));
      await drain();
    } finally {
      stubSender.send = send;
    }
    expect(injected).toBe(true);
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    expect(await facetsOf(business.id)).toBe(facets);
  });

  it('a prompt WhatsApp accepted after the second ask arrived authorises nothing', async () => {
    const business = await seedWithContact();
    const facets = await facetsOf(business.id);
    await say('DELETE MY DATA', 'wamid.EP1');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    /* WhatsApp's acceptance of the prompt is put after the second ask's arrival. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        UPDATE command_drafts
           SET command = command || jsonb_build_object(
                 'promptSentAt', clock_timestamp() + interval '1 minute')
         WHERE business_id = ${business.id}::uuid AND intent = 'EraseData'`);
    } finally {
      await close();
    }

    await say('DELETE MY DATA', 'wamid.EP2');
    expect(stubSender.lastText).toBe(replies.confirmErasure().text);
    expect(await facetsOf(business.id)).toBe(facets);
  });
});
