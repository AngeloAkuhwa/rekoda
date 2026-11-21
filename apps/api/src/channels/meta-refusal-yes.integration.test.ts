/**
 * A yes after a refusal or a failed reading (G-137; owner review of #437 at 3a60b0f): split from
 * meta-customer-token.integration.test.ts by concern.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, identity, withBusiness } from '@rekoda/db';
import { setPlanForTest } from '@rekoda/db/testing';
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

  /* Qodo on #437: a refusal the merchant moved past is no longer what a yes is about. */
  it('a yes after a newer preview was saved never says nothing was saved', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.R19',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say('wamid.R20', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    await say(
      'wamid.R21',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await plain('wamid.R22', 'yes');
    expect(stubSender.lastText).toContain('Saved');

    await plain('wamid.R23', 'yes');
    expect(stubSender.lastText).not.toContain('Nothing was saved from your last message');
  });

  /* Qodo on #437 (G-57): a view-only member's refused question leaves no draft. */
  it("a view-only member's question the provider could not answer leaves no draft", async () => {
    const business = await seedMerchant();
    const accountant = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    const before = await footprint(business.id);

    stubTransport.script(new Error('provider timeout'));
    await post(messagePayload(DELEGATE, 'wamid.R24', 'who owes me the most this month'));
    await drain();

    expect(await footprint(business.id)).toEqual(before);
    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toEqual([]);
  });

  /* CodeRabbit on #437: a "no" straight after a refusal is about the refusal. */
  it('a no after a refusal keeps the older preview and says it is waiting', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.R25',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say('wamid.R26', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');

    await plain('wamid.R27', 'no');
    expect(stubSender.lastText).toContain('still a preview waiting');
    await plain('wamid.R28', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);
  });

  /* CodeRabbit on #437: another member's yes must not use up the owner's refusal. */
  it("another member's yes leaves the owner's refusal standing before the owner's preview", async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');

    await say(
      'wamid.R29',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    stubTransport.replyWith(sale({ kind: 'token', token: ada.token }));
    await post(messagePayload(DELEGATE, 'wamid.R30', 'sold Ada Obi 2 wigs for 100k'));
    await drain();
    await say('wamid.R31', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');

    await post(messagePayload(DELEGATE, 'wamid.R32', 'yes'));
    await drain();
    expect((await footprint(business.id)).invoices).toBe(1);

    /* The owner's yes is still about the owner's refusal, never the owner's older sale. */
    await plain('wamid.R33', 'yes');
    expect(stubSender.lastText).toContain('Nothing was saved from your last message');
    expect((await footprint(business.id)).invoices).toBe(1);
  });

  it("another member's newer preview never lets the owner's yes past the owner's refusal", async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');

    await say('wamid.R30', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    expect(stubSender.lastText).toContain('could not tell which customer');
    stubTransport.replyWith(sale({ kind: 'token', token: ada.token }));
    await post(messagePayload(DELEGATE, 'wamid.R31', 'sold Ada Obi 2 wigs for 100k'));
    await drain();
    expect(stubSender.lastText).toContain('Reply *yes*');

    // The owner was last shown their refusal: this yes is about it, never the delegate's sale,
    // which is named as the delegate's, not as a preview from before the refusal.
    await plain('wamid.R32', 'yes');
    expect(stubSender.lastText).toContain('A preview another member asked for is already waiting');
    expect(stubSender.lastText).not.toContain('from before it');
    expect((await footprint(business.id)).invoices).toBe(0);

    // The delegate's own yes confirms the delegate's preview.
    await post(messagePayload(DELEGATE, 'wamid.R33', 'yes'));
    await drain();
    expect((await footprint(business.id)).invoices).toBe(1);
  });

  it('a yes after a refusal never points at a preview a lapsed plan cannot save', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.R40',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say('wamid.R41', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    await setPlanForTest(db, {
      businessId: business.id,
      plan: 'trial',
      expiresAt: new Date(Date.now() - 1_000),
      actor: 'operator:test-clock',
    });

    await plain('wamid.R42', 'yes');
    expect(stubSender.lastText).not.toContain('reply *yes* to save it');
    await plain('wamid.R43', 'no');
    expect(stubSender.lastText).not.toContain('reply *yes* to save it');
    expect((await footprint(business.id)).invoices).toBe(0);
  });
});
