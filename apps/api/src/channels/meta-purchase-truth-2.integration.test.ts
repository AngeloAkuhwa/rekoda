/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: one real purchase, one financial truth (G-81, OD-23) (part 2 of 5). Split
 * by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are in
 * meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import {
  db,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import {
  DELEGATE,
  ALIGN,
  MILO,
  QUESTION,
  SAME_DONE,
  SEPARATE_LEAD,
  REASK,
  RACE,
  seedMerchant,
  addDelegate,
  drain,
  say,
  reply,
  purchaseStates,
  purchases,
  bookMilo,
} from './meta-purchase-truth.fixtures.js';
import { setPlanForTest } from '@rekoda/db/testing';

useMetaWebhookHarness();

/**
 * G-81, OD-23: one real-world purchase must never become two financial
 * truths, and two real purchases must never be collapsed because they share
 * an amount, a product, a supplier or a day. A purchase that may be one
 * already waiting or booked is ASKED about ("same" or "separate"), never
 * silently dropped and never silently booked; the final net sits in the
 * purchase work, under a lock, before any posting.
 */
describe('one real purchase, one financial truth (G-81, OD-23)', () => {
  describe('14. Pidgin answers and continuation rules', () => {
    it('"na the same" is same', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'P14a');
      await say('wamid.P14a-d', MILO, 'I buy 10 carton Milo 100k cash', DELEGATE);
      await reply('wamid.P14a-same', 'na the same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('"same?" is unsure and re-asks; "abeg na another one o" is separate', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'P14b');
      await say('wamid.P14b-d', MILO, 'I buy another 10 carton Milo 100k cash', DELEGATE);
      await reply('wamid.P14b-unsure', 'same?', DELEGATE);
      expect(stubSender.lastText).toContain(REASK);
      await reply('wamid.P14b-sep', 'abeg na another one o', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await reply('wamid.P14b-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(2);
    });

    /* G-85: "same" or "separate" with a mark drawn over it decides nothing:
     * no link, no second booking, the purchase stays held and is asked
     * about again. */
    it.each(['same⃘', 'na sameͯ', 'separate͓', 'another one⃚'])(
      'G-85: a marked %j re-asks, and the purchase stays held',
      async (text) => {
        const business = await seedMerchant();
        await addDelegate(business.id);
        await bookMilo(business.id, 'G85i');
        await say('wamid.G85i-d', MILO, 'I buy another 10 carton Milo 100k cash', DELEGATE);
        await reply('wamid.G85i-marked', text, DELEGATE);
        expect(stubSender.lastText).toContain(REASK);
        /* `reply` resets the transport log: none since means no model. */
        expect(stubTransport.requests).toHaveLength(0);
        expect(await purchases(business.id)).toBe(1);
        expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
        /* A plain answer still decides it. */
        await reply('wamid.G85i-same', 'same', DELEGATE);
        expect(stubSender.lastText).toContain(SAME_DONE);
        expect(await purchases(business.id)).toBe(1);
      },
    );

    it('another member\'s "same" answers nothing', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'P14c');
      await say('wamid.P14c-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.P14c-o-same', 'same');
      expect(stubSender.lastText).not.toContain(SAME_DONE);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
    });

    it('a question that was never delivered is withdrawn, and "same" answers nothing', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'P14d');
      stubSender.failWith();
      await say('wamid.P14d-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'superseded']);
      await reply('wamid.P14d-same', 'same', DELEGATE);
      expect(stubSender.lastText).not.toContain(SAME_DONE);
    });
  });

  describe('15. the answers meet the plan gates (G-65 compatible)', () => {
    it('"same" sends no document, and "separate" on a lapsed plan drafts nothing', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'G15');
      await say('wamid.G15-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      const documents = stubSender.documents.length;
      await setPlanForTest(db, {
        businessId: business.id,
        plan: 'trial',
        expiresAt: new Date(Date.now() - 1_000),
        actor: 'operator:test-clock',
      });
      await reply('wamid.G15-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toBe(replies.trialEnded().text);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
      await reply('wamid.G15-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(stubSender.documents.length).toBe(documents);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('Codex review of #262', () => {
    const RICE = {
      ...MILO,
      description: '5 bags of rice',
      amount: 50_000,
      reportedPayment: 50_000,
      productMention: 'bags of rice',
      quantity: 5,
    };

    /* Two pending previews of one purchase nothing proves separate, as in
     * tests 5 and 6: built by hand, because the chat flow no longer makes
     * them. The owner's is older; a yes confirms the delegate's first. */
    async function twoPending(businessId: string, tag: string) {
      await addDelegate(businessId);
      await say(
        `wamid.${tag}-o`,
        { ...MILO, supplierReference: 'invoice 0101' },
        'Milo 100k EMK-0101',
      );
      await say(
        `wamid.${tag}-d`,
        { ...MILO, amount: 100_001, reportedPayment: 100_001 },
        'Milo 100k EMK-0202',
        DELEGATE,
      );
      await withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = (command - 'supplierReference') || ${ALIGN}::jsonb
           WHERE business_id = ${businessId}::uuid`),
      );
    }

    it('P1: "separate" after a refusal at the yes excuses the booking it was asked about', async () => {
      const business = await seedMerchant();
      await twoPending(business.id, 'C1');
      await reply('wamid.C1-yes-1', 'yes');
      await reply('wamid.C1-yes-2', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      await reply('wamid.C1-sep', 'separate');
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await reply('wamid.C1-yes-3', 'yes');
      expect(await purchases(business.id)).toBe(2);
    });

    it('P2: a refusal whose question never reached the merchant puts the preview back', async () => {
      const business = await seedMerchant();
      await twoPending(business.id, 'C3');
      await reply('wamid.C3-yes-1', 'yes');
      stubSender.failWith();
      await reply('wamid.C3-yes-2', 'yes');
      /* Fresh review of #262: put back as it was before the yes (pending),
       * so the next yes is refused and asked again (see I5 below). */
      expect(await purchaseStates(business.id)).toEqual(['pending', 'confirmed']);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P1: a yes from a member being asked never books an older preview behind another member’s question', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'C4');
      /* An older, unrelated preview of the owner's, still waiting. */
      await say('wamid.C4-rice', RICE, 'bought 5 bags rice 50k cash');
      /* The owner is asked about Milo; then the delegate is asked too. */
      await say('wamid.C4-o-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      await say('wamid.C4-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.C4-o-yes', 'yes');
      expect(stubSender.lastText).toContain(REASK);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P2: a funding answer whose identity question never reached the merchant gives the funding question back', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'C5');
      await say(
        'wamid.C5-pos',
        { ...MILO, paymentMethod: 'pos' },
        'I bought 10 cartons of Milo for 100k by POS',
        DELEGATE,
      );
      stubSender.failWith();
      await reply('wamid.C5-cash-1', 'cash', DELEGATE);
      await reply('wamid.C5-cash-2', 'cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P2: "same" about another member’s waiting preview never says only they can confirm it', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.C6-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await say('wamid.C6-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.C6-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(stubSender.lastText).not.toContain('member who sent it');
    });
  });

  describe('Codex review of #262, round 2', () => {
    const REF = (supplierReference: string) => ({ ...MILO, supplierReference });

    it('P2: a question asked by a job that ran late opens its window when it is asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'D1');
      stubTransport.replyWith(MILO);
      await post(
        messagePayload(DELEGATE, 'wamid.D1-d', 'I bought 10 cartons of Milo for 100k cash'),
      );
      /* The webhook was stored fifteen minutes before its job ran, and the
       * owner's purchase had been booked before that. */
      await withBusiness(db, business.id, async (tx) => {
        /* The owner's messages reached Rekoda before this one did. */
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '30 minutes'
           WHERE business_id = ${business.id}::uuid AND external_id <> 'wamid.D1-d'`);
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '15 minutes'
           WHERE business_id = ${business.id}::uuid AND external_id = 'wamid.D1-d'`);
        await tx.execute(sql`
          UPDATE expenses SET created_at = clock_timestamp() - interval '20 minutes'
           WHERE business_id = ${business.id}::uuid`);
      });
      await drain();
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.D1-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
    });

    it('P1: "separate" after a re-asked question excuses the match it was re-asked about', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'D2');
      /* The delegate is asked about the owner's booking. */
      await say('wamid.D2-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      /* Meanwhile the owner books another, declared separate. */
      await say('wamid.D2-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await reply('wamid.D2-o-sep', 'separate');
      await reply('wamid.D2-o-yes', 'yes');
      expect(await purchases(business.id)).toBe(2);
      /* The delegate's "separate" is asked about the new booking ... */
      await reply('wamid.D2-d-sep-1', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      /* ... and a second "separate" is about THAT one, so it proceeds. */
      await reply('wamid.D2-d-sep-2', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await reply('wamid.D2-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(3);
    });

    it('P2: a re-asked question that never reached the merchant can still be answered', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'D3');
      await say('wamid.D3-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await say('wamid.D3-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await reply('wamid.D3-o-sep', 'separate');
      await reply('wamid.D3-o-yes', 'yes');
      stubSender.failWith();
      await reply('wamid.D3-d-sep-1', 'separate', DELEGATE);
      /* Nobody saw the re-asked question: the question stays answerable, and
       * the new booking is NOT treated as one the delegate declared separate. */
      await reply('wamid.D3-d-sep-2', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      expect(await purchases(business.id)).toBe(2);
    });

    it('P1: a yes retried more than 24 hours after a matching booking is still refused', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.D4-o', REF('invoice 0101'), 'Milo 100k EMK-0101');
      await say(
        'wamid.D4-d',
        { ...MILO, amount: 100_001, reportedPayment: 100_001 },
        'Milo 100k EMK-0202',
        DELEGATE,
      );
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = (command - 'supplierReference') || ${ALIGN}::jsonb
           WHERE business_id = ${business.id}::uuid`),
      );
      await reply('wamid.D4-yes-1', 'yes');
      expect(await purchases(business.id)).toBe(1);
      /* Both previews and the booking happened 25 hours before this yes ran. */
      await withBusiness(db, business.id, async (tx) => {
        await tx.execute(sql`
          UPDATE expenses SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid`);
        await tx.execute(sql`
          UPDATE conversation_messages SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid`);
        await tx.execute(sql`
          UPDATE command_drafts SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid`);
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid`);
      });
      await reply('wamid.D4-yes-2', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P1: a purchase recorded after a "separate" answer is never excused by its message time', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.D5-o', REF('invoice 0707'), 'Milo 100k EMK-0707');
      await reply('wamid.D5-o-yes', 'yes');
      await say('wamid.D5-d', REF('invoice 0707'), 'Milo 100k EMK-0707', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.D5-d-sep', 'separate', DELEGATE);
      await reply('wamid.D5-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(2);
      /* The first booking leaves the window, so only the "separate" one is left. */
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE expenses SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid
             AND source_id = (SELECT d.id::text FROM command_drafts d
                               JOIN conversation_messages m ON m.id = d.conversation_message_id
                              WHERE m.provider_message_id = 'wamid.D5-o')`),
      );
      /* A purchase whose message reached Rekoda BEFORE the question, but
       * whose draft is recorded only now. */
      await say(
        'wamid.D5-late',
        { ...MILO, amount: 100_001, reportedPayment: 100_001 },
        'Milo 100k EMK-0808',
      );
      expect(stubSender.lastText).toContain('Paid in full by cash');
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = (command - 'supplierReference') || ${ALIGN}::jsonb
           WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
      );
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE conversation_messages SET created_at = (
            SELECT created_at - interval '1 second' FROM conversation_messages
             WHERE provider_message_id = 'wamid.D5-d')
           WHERE provider_message_id = 'wamid.D5-late'`),
      );
      await reply('wamid.D5-late-yes', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(await purchases(business.id)).toBe(2);
    });
  });
});
