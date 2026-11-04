/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: one real purchase, one financial truth (G-81, OD-23) (part 3 of 5). Split
 * by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are in
 * meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { stockRepo, withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { billingRepo, spendRepo } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import {
  OWNER,
  DELEGATE,
  UNCLEAR,
  ALIGN,
  MILO,
  QUESTION,
  SAME_DONE,
  SEPARATE_LEAD,
  REASK,
  CLOSED,
  RACE,
  seedMerchant,
  addDelegate,
  drain,
  say,
  reply,
  purchaseStates,
  purchases,
  knownProduct,
  bookMilo,
} from './meta-purchase-truth.fixtures.js';

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
  describe('fresh review of #262', () => {
    const RICE = {
      ...MILO,
      description: '5 bags of rice',
      amount: 50_000,
      reportedPayment: 50_000,
      productMention: 'bags of rice',
      quantity: 5,
    };
    const POS_QUESTION = 'did it come from your bank account or from physical cash?';

    async function backdate(businessId: string, table: string, column: string, interval: string) {
      await withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE ${sql.raw(table)} SET ${sql.raw(column)} = clock_timestamp() - ${interval}::interval
               WHERE business_id = ${businessId}::uuid`,
        ),
      );
    }

    it('D3: suppliers that existed long before never prove a purchase separate', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await deps.gateway.resolveSupplierMention(business.id, 'Emeka');
      await deps.gateway.resolveSupplierMention(business.id, 'Chidi');
      await backdate(business.id, 'suppliers', 'created_at', '30 days');
      await bookMilo(business.id, 'R1');
      await say(
        'wamid.R1-chidi',
        { ...MILO, supplierMention: 'Chidi' },
        'I bought 10 cartons of Milo from Chidi for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });

    it('D3: products made from chat long ago never prove it either', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await withBusiness(db, business.id, async (tx) => {
        await stockRepo.findOrCreateProduct(tx, business.id, 'Milo');
        await stockRepo.findOrCreateProduct(tx, business.id, 'Peak milk');
      });
      await backdate(business.id, 'products', 'created_at', '30 days');
      await bookMilo(business.id, 'R2');
      await say(
        'wamid.R2-peak',
        { ...MILO, description: '10 cartons of Peak milk', productMention: 'Peak milk' },
        'I bought 10 cartons of Peak milk for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });

    it('B1: a question names every match it may be about', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'B1');
      await say('wamid.B1-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.B1-d-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      /* The owner sends the same real purchase while the delegate's fresh
       * preview waits: the question must name both. */
      await say('wamid.B1-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).toContain('2 stock purchases of ₦100,000');
    });

    it('I1: one member double-sending before the first is processed still gets ONE preview', async () => {
      const business = await seedMerchant();
      stubTransport.replyWith(MILO);
      await post(messagePayload(OWNER, 'wamid.I1-a', 'I bought 10 cartons of Milo for 100k cash'));
      await post(messagePayload(OWNER, 'wamid.I1-b', 'I bought 10 cartons of Milo for 100k cash'));
      await drain();
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
      expect(stubSender.lastText).toContain('Your earlier preview of ₦100,000 was replaced');
    });

    it('I1: two members sending together before either is processed: the second is asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      stubTransport.replyWith(MILO);
      await post(messagePayload(OWNER, 'wamid.I1c-o', 'I bought 10 cartons of Milo for 100k cash'));
      await post(
        messagePayload(DELEGATE, 'wamid.I1c-d', 'I bought 10 cartons of Milo for 100k cash'),
      );
      await drain();
      expect(await purchaseStates(business.id)).toEqual(['pending', 'held']);
    });

    it('I4: a yes from a member still being asked never books an older preview, after another message', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'I4');
      await say('wamid.I4-rice', RICE, 'bought 5 bags rice 50k cash');
      await say('wamid.I4-o-milo', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.I4-o-stock', 'stock');
      await say('wamid.I4-d-milo', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.I4-o-yes', 'yes');
      expect(stubSender.lastText).toContain(REASK);
      expect(await purchases(business.id)).toBe(1);
    });

    it('I5: a refused yes whose question never reached the merchant puts the preview back, and the next yes is asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.I5-o', { ...MILO, supplierReference: 'invoice 0011' }, 'Milo 100k EMK-0011');
      await say(
        'wamid.I5-d',
        { ...MILO, amount: 100_001, reportedPayment: 100_001 },
        'Milo 100k EMK-0022',
        DELEGATE,
      );
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = (command - 'supplierReference') || ${ALIGN}::jsonb
           WHERE business_id = ${business.id}::uuid`),
      );
      await reply('wamid.I5-yes-1', 'yes');
      stubSender.failWith();
      await reply('wamid.I5-yes-2', 'yes');
      expect(await purchaseStates(business.id)).toEqual(['pending', 'confirmed']);
      await reply('wamid.I5-yes-3', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('I6: an unrecognised reply keeps the question open, and "seperate" answers it', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'I6');
      await say('wamid.I6-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.I6-hmm', 'hmm let me check', DELEGATE);
      await reply('wamid.I6-sep', 'seperate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
    });

    it('I6: a bare "same" days after a question is an ordinary message, never "closed"', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'I6b');
      await say('wamid.I6b-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await withBusiness(db, business.id, async (tx) => {
        await tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 days'
           WHERE business_id = ${business.id}::uuid AND state = 'held'`);
        await tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '3 days'
           WHERE business_id = ${business.id}::uuid`);
      });
      await reply('wamid.I6b-same', 'same', DELEGATE);
      expect(stubSender.lastText).not.toContain(CLOSED);
    });

    it('I7: an own waiting preview is not replaced by a purchase that is held and asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.I7-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await say('wamid.I7-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.I7-d-sep', 'separate', DELEGATE);
      await reply('wamid.I7-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(1);
      /* The owner's own preview waits; a matching booking exists. */
      await say('wamid.I7-o-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).not.toContain('replaced by this one');
      expect((await purchaseStates(business.id))[0]).toBe('pending');
    });

    it('minor: "same" closes the stale G-61 question the held purchase was blocking', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'M1');
      await say('wamid.M1-pos', { ...MILO, paymentMethod: 'pos' }, 'Milo 100k POS');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await say('wamid.M1-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.M1-d-same', 'same', DELEGATE);
      expect(await purchaseStates(business.id)).not.toContain('abandoned');
    });

    it('minor: a resend after "separate" replaces the fresh preview without asking again', async () => {
      const business = await seedMerchant();
      await bookMilo(business.id, 'M2');
      await say('wamid.M2-a', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await reply('wamid.M2-sep', 'separate');
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await say('wamid.M2-b', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).not.toContain(QUESTION);
      expect(stubSender.lastText).toContain('was replaced');
      await reply('wamid.M2-yes-1', 'yes');
      await reply('wamid.M2-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(2);
    });

    it('minor: a "no" to the question says how to save nothing (same, never cancel: Codex review of 5bfe87e)', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'M3');
      await say('wamid.M3-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.M3-no', 'no', DELEGATE);
      expect(stubSender.lastText).toContain('If you do not want it saved, reply *same*');
      expect(stubSender.lastText).not.toContain('*cancel*');
      /* Following it literally: the question closes and nothing more is saved. */
      await reply('wamid.M3-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('minor: a closed question mentions the fresh preview still waiting', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'M4');
      await say('wamid.M4-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.M4-sep', 'separate', DELEGATE);
      await reply('wamid.M4-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain('still waiting for a yes');
    });
  });

  describe('on a plan without Chat while the question is open (G-65 integration)', () => {
    async function askedWithoutChat(tag: string) {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, tag);
      await say(`wamid.${tag}-d`, MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await billingRepo.setPlan(db, {
        businessId: business.id,
        plan: 'integrate',
        expiresAt: null,
        actor: 'operator:g81',
      });
      return business;
    }

    it('a yes is told nothing was saved, and invites no "separate"', async () => {
      const business = await askedWithoutChat('NC1');
      await reply('wamid.NC1-d-yes', 'yes', DELEGATE);
      expect(stubSender.lastText).toBe(replies.notSavedNotInPlan().text);
      expect(await purchases(business.id)).toBe(1);
    });

    it('a no is told nothing was saved, and invites no "separate"', async () => {
      const business = await askedWithoutChat('NC2');
      await reply('wamid.NC2-no', 'no', DELEGATE);
      expect(stubSender.lastText).toBe(replies.notSavedNotInPlan().text);
      expect(await purchases(business.id)).toBe(1);
    });

    it('"same" still closes it, writing nothing, with copy that invites no refused yes', async () => {
      const business = await askedWithoutChat('NC3');
      await reply('wamid.NC3-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(stubSender.lastText).not.toMatch(/reply \*yes\*|send the purchase again/i);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'superseded']);
      expect(await purchases(business.id)).toBe(1);
    });

    it('"separate" is refused before anything is drafted', async () => {
      const business = await askedWithoutChat('NC4');
      await reply('wamid.NC4-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toBe(replies.chatNotInPlan().text);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('Codex review of cfc4720', () => {
    it('P2: a purchase whose job ran late is aged from its webhook arrival, not from when it ran', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'C5a');
      /* The owner's purchase reached Rekoda 25 hours ago, but its job (and the
       * booking) ran only 23 hours ago, after a backlog. */
      await withBusiness(db, business.id, async (tx) => {
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid`);
        for (const table of ['conversation_messages', 'expenses']) {
          await tx.execute(sql`
            UPDATE ${sql.raw(table)} SET created_at = clock_timestamp() - interval '23 hours'
             WHERE business_id = ${business.id}::uuid`);
        }
      });
      await say('wamid.C5a-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).not.toContain(QUESTION);
      expect(stubSender.lastText).toContain('Paid in full by cash');
    });

    it('P1: a two-line received order and a chat purchase of its second product are asked about', async () => {
      const business = await seedMerchant();
      await knownProduct(business.id, 'Milo');
      await knownProduct(business.id, 'Peak milk');
      /* A received purchase order of ₦100,000 with two catalogue-linked lines. */
      await withBusiness(db, business.id, async (tx) => {
        const milo = await stockRepo.findOrCreateProduct(tx, business.id, 'Milo');
        const peak = await stockRepo.findOrCreateProduct(tx, business.id, 'Peak milk');
        await spendRepo.recordPurchase(tx, {
          businessId: business.id,
          description: 'PO-0001',
          amountK: 10_000_000,
          paidK: 0,
          method: null,
          sourceType: 'purchase_order',
          sourceId: 'po-0001',
          supplierId: null,
        });
        for (const product of [milo, peak]) {
          await stockRepo.recordDelivery(tx, {
            businessId: business.id,
            product,
            quantity: 5,
            costK: 5_000_000,
            sourceType: 'purchase_order',
            sourceId: 'po-0001',
          });
        }
      });
      await say(
        'wamid.C5b-peak',
        { ...MILO, description: '10 cartons of Peak milk', productMention: 'Peak milk' },
        'I bought 10 cartons of Peak milk for 100k cash',
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });
  });

  describe('Codex review of 3fcc173', () => {
    const RICE = {
      ...MILO,
      description: '5 bags of rice',
      amount: 50_000,
      reportedPayment: 50_000,
      productMention: 'bags of rice',
      quantity: 5,
    };

    it('P1: a yes sent while a preview was waiting never claims an older one once that preview is held', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      /* An older, unrelated preview of the delegate's. */
      await say('wamid.C6-rice', RICE, 'bought 5 bags rice 50k cash', DELEGATE);
      /* The owner's Milo preview, the newest. */
      await say('wamid.C6-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      /* A received order of the same total is booked after it was shown. */
      await withBusiness(db, business.id, (tx) =>
        spendRepo.recordPurchase(tx, {
          businessId: business.id,
          description: 'PO-0007',
          amountK: 10_000_000,
          paidK: 0,
          method: null,
          sourceType: 'purchase_order',
          sourceId: 'po-0007',
          supplierId: null,
        }),
      );
      /* The owner's yes is refused at the work, and the preview is held. */
      await reply('wamid.C6-o-yes', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(await purchaseStates(business.id)).toEqual(['pending', 'held']);
      /* A delegate yes that reached Rekoda BEFORE that preview was held (its
       * job ran late): it was about the Milo preview, never the rice. */
      stubTransport.replyWith(UNCLEAR);
      await post(messagePayload(DELEGATE, 'wamid.C6-d-yes', 'yes'));
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE external_events SET created_at = (
            SELECT created_at + interval '10 milliseconds' FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND state = 'held')
           WHERE business_id = ${business.id}::uuid AND external_id = 'wamid.C6-d-yes'`),
      );
      await drain();
      expect(await purchases(business.id)).toBe(1);
      expect(stubSender.lastText).toContain('Nothing was saved from your yes.');
    });
  });

  describe('Codex review of 71fad6b', () => {
    it('P2: "separate" still answers a held question after an unrelated question opened since', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'C7a');
      await say('wamid.C7a-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      /* A spending question with no period opens "Which period?". */
      await say(
        'wamid.C7a-q',
        {
          intent: 'Query',
          topic: 'expenses_summary',
          customer: null,
          period: null,
          periodText: null,
          format: 'chat',
        },
        'how much did I spend?',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain('which period');
      await reply('wamid.C7a-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
    });

    it('P2: the supplier reference a merchant confirmed reaches the bill', async () => {
      const business = await seedMerchant();
      await say(
        'wamid.C7b',
        { ...MILO, reportedPayment: 0, paymentMethod: null, supplierReference: 'EMK-0041' },
        'Milo 100k on credit, their invoice EMK-0041',
      );
      expect(stubSender.lastText).toContain('Reference: 0041');
      expect(stubSender.lastText).not.toContain('EMK');
      await reply('wamid.C7b-yes', 'yes');
      const rows = await withBusiness(db, business.id, (tx) =>
        tx.execute<{ ref: string | null }>(sql`
          SELECT supplier_reference AS ref FROM bills WHERE business_id = ${business.id}::uuid`),
      );
      expect([...rows].map((r) => r.ref)).toEqual(['Reference 0041']);
    });
  });
});
