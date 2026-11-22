/**
 * A yes after a refusal or a failed reading (G-137; owner review of #437 at 3a60b0f): split from
 * meta-customer-token.integration.test.ts by concern.
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { conversationsRepo, createDb, identity, sql, withBusiness } from '@rekoda/db';
import { setPlanForTest } from '@rekoda/db/testing';
import {
  db,
  deps,
  messagePayload,
  photoPayload,
  post,
  stubSender,
  statusPayload,
  stubTransport,
  urls,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { mediaMessage } from './meta-continuations.fixtures.js';
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

  /* CodeRabbit on #437 at 3ec6a0d: another member is never told to answer a preview a lapsed plan
   * cannot save. */
  it("a lapsed plan is said before pointing at another member's preview", async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await say(
      'wamid.R70',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say('wamid.R71', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'transport',
      amount: 5_000,
      category: 'transport',
      paymentMethod: 'cash',
    });
    await post(messagePayload(DELEGATE, 'wamid.R72', 'transport 5k cash'));
    await drain();
    await setPlanForTest(db, {
      businessId: business.id,
      plan: 'trial',
      expiresAt: new Date(Date.now() - 1_000),
      actor: 'operator:test-clock',
    });

    await plain('wamid.R73', 'yes');
    expect(stubSender.lastText).not.toBe(replies.previewWaitingForAnotherMember().text);
    expect(stubSender.lastText).not.toContain('Ask them to reply');
    expect((await footprint(business.id)).invoices).toBe(0);
  });

  it('a newer preview that was never delivered does not close the refusal before it', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.R50',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say('wamid.R51', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    await say(
      'wamid.R52',
      {
        intent: 'RecordExpense',
        description: 'diesel',
        amount: 12_000,
        category: 'fuel',
        paymentMethod: 'cash',
      },
      'diesel 12k cash',
    );
    // WhatsApp later reports that the expense preview never reached the merchant.
    await post(statusPayload(OWNER, `wamid.STUB${stubSender.sent.length}`, 'failed'));
    await drain();

    // The last thing the merchant saw is the refusal: this yes saves nothing.
    await plain('wamid.R53', 'yes');
    expect(stubSender.lastText).toContain('Nothing was saved from your last message');
    expect((await footprint(business.id)).invoices).toBe(0);
    /* Nor the diesel expense whose preview never arrived (CodeRabbit on #437 at cf96697). */
    const [spent] = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ expenses: number; confirmed: number }>(sql`
        SELECT (SELECT count(*)::int FROM expenses WHERE business_id = ${business.id}::uuid) AS expenses,
               (SELECT count(*)::int FROM command_drafts WHERE business_id = ${business.id}::uuid
                  AND intent = 'RecordExpense' AND state = 'confirmed') AS confirmed`),
    );
    expect(spent).toEqual({ expenses: 0, confirmed: 0 });
  });
  /* CodeRabbit on #437 at 3799977: the same receipt arriving after the preview's window closed. The
   * expired preview was never read either, so the refusal is still the last thing the owner saw,
   * and a newer request from another member is not answered by the owner's "yes". */
  it('a preview that expired before it was reported undelivered does not close the refusal', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await say(
      'wamid.R60',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say('wamid.R61', payment({ kind: 'token', token: 'CUSTOMER_7K2' }), 'Bisi paid 20k');
    await say(
      'wamid.R62',
      {
        intent: 'RecordExpense',
        description: 'diesel',
        amount: 12_000,
        category: 'fuel',
        paymentMethod: 'cash',
      },
      'diesel 12k cash',
    );
    const expenseReceipt = `wamid.STUB${stubSender.sent.length}`;
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`UPDATE command_drafts SET state = 'expired'
                      WHERE business_id = ${business.id}::uuid AND intent = 'RecordExpense'`),
    );
    // The failure receipt is delayed past the expense preview's window.
    await post(statusPayload(OWNER, expenseReceipt, 'failed'));
    await drain();

    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'transport',
      amount: 5_000,
      category: 'transport',
      paymentMethod: 'cash',
    });
    await post(messagePayload(DELEGATE, 'wamid.R63', 'transport 5k cash'));
    await drain();

    await plain('wamid.R64', 'yes');
    expect(stubSender.lastText).toBe(replies.previewWaitingForAnotherMember().text);
    const states = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ intent: string; state: string }>(sql`
        SELECT intent, state FROM command_drafts
         WHERE business_id = ${business.id}::uuid AND intent IN ('RecordSale', 'RecordExpense')
         ORDER BY insertion_seq`),
    );
    // Neither Ada's older sale nor the delegate's newer expense was posted by the owner's yes.
    expect([...states].map((r) => `${r.intent}:${r.state}`)).toEqual([
      'RecordSale:pending',
      'RecordExpense:expired',
      'RecordExpense:pending',
    ]);
    expect((await footprint(business.id)).invoices).toBe(0);
  });
});

/**
 * The unsupported-media refusal is recorded BEFORE its reply is sent (CodeRabbit on #437 at
 * ebeeadb). The send is an HTTP call inside the job's transaction and cannot be rolled back:
 * a write after it that fails rolls the inbound row back, and the retry sends the same
 * refusal again.
 */
describe('a refusal that fails to record is answered once across the retry', () => {
  it.each([
    {
      name: 'unsupported media',
      payload: () =>
        mediaMessage(
          'wamid.MEDIA-ONCE',
          { type: 'sticker', sticker: { id: 'sticker-1', mime_type: 'image/webp' } },
          OWNER,
        ),
      answer: () => replies.onlyText().text,
    },
    {
      /* The gateway withholds a message holding a second account number (G-60): no model reads
       * it, and the refusal used to be recorded after the send (independent review at 4480bc2). */
      name: 'a message the gateway would not hand on',
      payload: () => messagePayload(OWNER, 'wamid.UNREAD-ONCE', 'account 0123456789 or 0987654321'),
      answer: () => replies.messageNotReadSafely().text,
    },
  ])('$name', async ({ payload, answer }) => {
    const business = await seedMerchant();
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS media_refusal_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION media_refusal_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.command->>'refused' = 'true' AND nextval('media_refusal_once') = 1 THEN
            RAISE EXCEPTION 'media refusal: first record fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER media_refusal_fail_once BEFORE INSERT ON command_drafts
          FOR EACH ROW EXECUTE FUNCTION media_refusal_fail_once()`);

      await post(payload());
      await drain();
      await ownerDb.execute(sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`);
      await drain();

      const [job] = await ownerDb.execute<{ attempts: number; state: string }>(sql`
        SELECT attempts, state FROM jobs
         WHERE business_id = ${business.id}::uuid AND kind = 'inbound.message'`);
      expect([Number(job?.attempts), job?.state]).toEqual([2, 'done']);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS media_refusal_fail_once ON command_drafts`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS media_refusal_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS media_refusal_once`);
      await close();
    }
    const sent = stubSender.sent.filter((m) => m.text === answer());
    expect(sent).toHaveLength(1);
    const refusals = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'`,
      ),
    );
    expect(refusals[0]?.n).toBe(1);
  });
});

/**
 * A "yes" behind a question to the books falls back to the newest pending draft, which can be
 * another member's refusal: it is looked past, never claimed (independent review of #437 at
 * ebeeadb). Claiming it would answer the owner with the delegate's refusal and spend the guard
 * that refusal holds on the delegate's own preview.
 */
describe("a yes never claims another member's refusal", () => {
  it('after an unseen preview and a question, the delegate refusal stays theirs', async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    stubSender.failWith();
    await say(
      'wamid.RX1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say(
      'wamid.RX2',
      {
        intent: 'Query',
        topic: 'sales_summary',
        customer: null,
        period: 'today',
        periodText: 'today',
        format: 'chat',
      },
      'how much did I sell today',
    );
    await post(
      mediaMessage(
        'wamid.RX3',
        { type: 'sticker', sticker: { id: 'sticker-1', mime_type: 'image/webp' } },
        DELEGATE,
      ),
    );
    await drain();
    const before = await footprint(business.id);

    await plain('wamid.RX4', 'yes');
    expect(stubSender.lastText).not.toBe(replies.onlyText().text);
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
