/**
 * A yes after a refusal or a failed reading (G-137; owner review of #437 at 3a60b0f): split from
 * meta-customer-token.integration.test.ts by concern.
 */
import { describe, expect, it } from 'vitest';
import { identity } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  photoPayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { drain, voicePayload } from './meta-voice-note.fixtures.js';
import {
  DELEGATE,
  OWNER,
  footprint,
  payment,
  plain,
  sale,
  say,
  seedMerchant,
} from './meta-customer-token.fixtures.js';

useMetaWebhookHarness();

/**
 * A refusal is not a preview, and a "yes" after it must not confirm what was shown before
 * it (owner review of #437 at 3a60b0f). The merchant last read "I could not tell which
 * customer"; their "yes" is about that, never agreement to an older sale.
 */
describe('a yes after a refused record', () => {
  it('does not confirm the older preview', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.R1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    expect(stubSender.lastText).toContain('Reply *yes*');
    const before = await footprint(business.id);

    await say('wamid.R2', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    expect(stubSender.lastText).toContain('could not tell which customer');

    await plain('wamid.R3', 'yes');
    expect(stubSender.lastText).toContain('Nothing was saved from your last message');
    expect(stubSender.lastText).toContain('still a preview waiting');
    expect(await footprint(business.id)).toEqual(before);

    /* Told the preview is waiting, the next yes is about it (Build 6's rule
     * for a question asked since a preview, applied to a refusal). */
    await plain('wamid.R3b', 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });

  it('a no after a refusal alone cancels nothing and says so', async () => {
    await seedMerchant();
    await say('wamid.R10', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    await plain('wamid.R11', 'no');
    expect(stubSender.lastText).not.toBe('Cancelled.');
    expect(stubSender.lastText).not.toContain('Cancelled');
  });

  it("another member's refusal does not stand between a member and their own preview", async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');

    await say(
      'wamid.R12',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    stubTransport.replyWith(payment({ kind: 'token', token: 'CUSTOMER_7K2' }));
    await post(messagePayload(DELEGATE, 'wamid.R13', 'Bisi paid 20k'));
    await drain();
    expect(stubSender.lastText).toContain('could not tell which customer');

    await plain('wamid.R14', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);
  });

  /* The reviewer of the owner-review fixes: the same shape outside the model path. */
  it.each([
    [
      'a photo cannot be fetched',
      'wamid.R15',
      () => photoPayload(OWNER, 'wamid.R15', { mediaId: 'gone' }),
    ],
    ['a voice note cannot be fetched', 'wamid.R16', () => voicePayload(OWNER, 'wamid.R16', 'gone')],
  ])('does not confirm the older preview when %s', async (_why, _wamid, payload) => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.R17',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    const before = await footprint(business.id);

    await post(payload());
    await drain();
    expect(stubSender.lastText).not.toContain('Reply *yes*');

    await plain('wamid.R18', 'yes');
    expect(stubSender.lastText).toContain('still a preview waiting');
    expect(await footprint(business.id)).toEqual(before);
  });

  /* The same shape, found while testing the one above and older than #437: a yes after
   * "I am very busy right now" (provider down) or "I could not turn that into a record"
   * (an answer that failed the schema) posted the sale previewed before it. */
  it.each([
    ['the model provider is down', () => stubTransport.script(new Error('provider timeout'))],
    ['the model answer is unusable', () => stubTransport.replyWith({ intent: 'Nonsense' })],
  ])('does not confirm the older preview when %s', async (_why, failNext) => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.R7',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    const before = await footprint(business.id);

    failNext();
    await plain('wamid.R8', 'Bisi paid 20k');
    expect(stubSender.lastText).not.toContain('Reply *yes*');

    await plain('wamid.R9', 'yes');
    expect(stubSender.lastText).toContain('still a preview waiting');
    expect(await footprint(business.id)).toEqual(before);
  });

  it('still lets a later, explicit preview be confirmed', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say('wamid.R4', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    expect(stubSender.lastText).toContain('could not tell which customer');

    await say(
      'wamid.R5',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    expect(stubSender.lastText).toContain('Reply *yes*');
    await plain('wamid.R6', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);
  });
});
