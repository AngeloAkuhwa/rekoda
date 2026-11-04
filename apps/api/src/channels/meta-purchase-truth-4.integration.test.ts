/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: one real purchase, one financial truth (G-81, OD-23) (part 4 of 5). Split
 * by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are in
 * meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { spendRepo } from '@rekoda/db';
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
  UNCLEAR,
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
  describe('fresh review of 75fd1c9', () => {
    it('I1: an invoice number and a receipt number for one purchase are asked about, never booked twice', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say(
        'wamid.V1-o',
        { ...MILO, supplierReference: 'invoice 2231' },
        'Milo 100k, invoice 2231',
      );
      await reply('wamid.V1-o-yes', 'yes');
      await say(
        'wamid.V1-d',
        { ...MILO, supplierReference: 'receipt RCPT-0041' },
        'Milo 100k, receipt RCPT-0041',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
      expect(await purchases(business.id)).toBe(1);
    });

    it('I2: a reference that is a name with digits stores no letters, on the draft or the bill', async () => {
      const business = await seedMerchant();
      await say(
        'wamid.V2',
        { ...MILO, reportedPayment: 0, paymentMethod: null, supplierReference: 'TOLU-77' },
        'Milo 100k on credit, TOLU-77',
      );
      await reply('wamid.V2-yes', 'yes');
      const [row] = [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ draft: string | null; bill: string | null }>(sql`
            SELECT (SELECT command->>'supplierReference' FROM command_drafts
                     WHERE business_id = ${business.id}::uuid AND intent = 'RecordPurchase') AS draft,
                   (SELECT supplier_reference FROM bills WHERE business_id = ${business.id}::uuid) AS bill`),
        )),
      ];
      expect(row!.draft ?? '').not.toMatch(/TOLU/i);
      expect(row!.bill ?? '').not.toMatch(/TOLU/i);
    });

    it('minor: after the question expired, "no" and "cancel" behave as with nothing waiting', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'V3');
      await say('wamid.V3-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await withBusiness(db, business.id, async (tx) => {
        await tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 hours'
           WHERE business_id = ${business.id}::uuid AND state = 'held'`);
        await tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '3 hours'
           WHERE business_id = ${business.id}::uuid`);
      });
      await reply('wamid.V3-no', 'no', DELEGATE);
      expect(stubSender.lastText).toBe(replies.nothingToDecline().text);
      await reply('wamid.V3-cancel', 'cancel', DELEGATE);
      expect(stubSender.lastText).toBe(replies.nothingToCancel().text);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
    });

    it('minor: a re-asked question nobody saw keeps a continuation that ends with the restored window', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'V4');
      await say('wamid.V4-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await say('wamid.V4-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await reply('wamid.V4-o-sep', 'separate');
      await reply('wamid.V4-o-yes', 'yes');
      stubSender.failWith();
      await reply('wamid.V4-d-sep-1', 'separate', DELEGATE);
      const rows = [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ held: string; open: string }>(sql`
            SELECT h.expires_at::text AS held, c.expires_at::text AS open
              FROM command_drafts h
              JOIN conversation_continuations c
                ON c.business_id = h.business_id AND c.draft_id = h.id AND c.state = 'open'
             WHERE h.business_id = ${business.id}::uuid AND h.state = 'held'`),
        )),
      ];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.open).toBe(rows[0]!.held);
    });

    it('minor: a second "cash" while the rebuilt purchase is held points at the identity question', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'V5');
      await say(
        'wamid.V5-pos',
        { ...MILO, paymentMethod: 'pos' },
        'I bought 10 cartons of Milo for 100k by POS',
        DELEGATE,
      );
      await reply('wamid.V5-cash', 'cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.V5-cash-2', 'cash', DELEGATE);
      expect(stubSender.lastText).toContain(REASK);
      expect(stubSender.lastText).not.toBe(replies.fundingQuestionClosed().text);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('Codex review of 7f173b6', () => {
    /** The delegate's question was asked 15 minutes ago and closed 5 minutes
     * ago; their answer reached Rekoda 8 minutes ago, inside the window, and
     * its job runs only now (a backlog or a retry). */
    async function answerSentInsideProcessedAfter(businessId: string, wamid: string, text: string) {
      stubTransport.replyWith(UNCLEAR);
      await post(messagePayload(DELEGATE, wamid, text));
      await withBusiness(db, businessId, async (tx) => {
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '30 minutes'
           WHERE business_id = ${businessId}::uuid AND external_id <> ${wamid}`);
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '8 minutes'
           WHERE business_id = ${businessId}::uuid AND external_id = ${wamid}`);
        await tx.execute(sql`
          UPDATE command_drafts
             SET created_at = clock_timestamp() - interval '15 minutes',
                 expires_at = clock_timestamp() - interval '5 minutes'
           WHERE business_id = ${businessId}::uuid AND state = 'held'`);
        await tx.execute(sql`
          UPDATE conversation_continuations
             SET created_at = clock_timestamp() - interval '15 minutes',
                 expires_at = clock_timestamp() - interval '5 minutes'
           WHERE business_id = ${businessId}::uuid AND expects = 'purchase_identity'`);
      });
      await drain();
    }

    it('P2: "same" sent inside the window but processed after it is answered, not closed', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'BX1');
      await say('wamid.X1-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await answerSentInsideProcessedAfter(business.id, 'wamid.X1-same', 'same');
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'superseded']);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P2: "separate" sent inside the window but processed after it shows the fresh preview', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'BX2');
      await say('wamid.X2-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await answerSentInsideProcessedAfter(business.id, 'wamid.X2-sep', 'separate');
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
    });

    it('P2: a known product with no usable quantity proves nothing against a booked one', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await knownProduct(business.id, 'Milo');
      await knownProduct(business.id, 'Peak milk');
      await bookMilo(business.id, 'X3');
      await say(
        'wamid.X3-d',
        { ...MILO, productMention: 'Peak milk', quantity: null },
        'I bought Peak milk for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P2: a waiting preview whose product has no quantity proves nothing either', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await knownProduct(business.id, 'Milo');
      await knownProduct(business.id, 'Peak milk');
      await say(
        'wamid.X4-o',
        { ...MILO, productMention: 'Peak milk', quantity: null },
        'I bought Peak milk for 100k cash',
      );
      await say('wamid.X4-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
    });
  });

  describe('Codex review of 30a5c8f', () => {
    it('P1: a "separate" sent before the question was re-asked never excuses what the re-ask named', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'Y1');
      await say('wamid.Y1-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      /* The owner books another of the same total, declared separate. */
      await say('wamid.Y1-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await reply('wamid.Y1-o-sep', 'separate');
      await reply('wamid.Y1-o-yes', 'yes');
      expect(await purchases(business.id)).toBe(2);
      /* The delegate's later "separate" is processed first and re-asks,
       * naming the new booking. */
      await reply('wamid.Y1-d-sep-late', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      /* An earlier "separate", sent before that re-ask, arrives only now. */
      stubTransport.replyWith(UNCLEAR);
      await post(messagePayload(DELEGATE, 'wamid.Y1-d-sep-early', 'separate'));
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE external_events SET created_at = (
            SELECT created_at - interval '10 milliseconds' FROM external_events
             WHERE business_id = ${business.id}::uuid AND external_id = 'wamid.Y1-d-sep-late')
           WHERE business_id = ${business.id}::uuid AND external_id = 'wamid.Y1-d-sep-early'`),
      );
      await drain();
      expect(stubSender.lastText).not.toContain(SEPARATE_LEAD);
      await reply('wamid.Y1-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(2);
    });
  });

  describe('Codex review of 0e9bf52', () => {
    it('P2: a refused fresh preview keeps what its first answer declared separate', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'Z1');
      await say('wamid.Z1-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.Z1-d-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      /* A received order of the same total is booked after that preview. */
      await withBusiness(db, business.id, (tx) =>
        spendRepo.recordPurchase(tx, {
          businessId: business.id,
          description: 'PO-0009',
          amountK: 10_000_000,
          paidK: 0,
          method: null,
          sourceType: 'purchase_order',
          sourceId: 'po-0009',
          supplierId: null,
        }),
      );
      await reply('wamid.Z1-d-yes-1', 'yes', DELEGATE);
      expect(stubSender.lastText).toContain(RACE);
      /* "separate" to THAT is about the order only: the owner's booking was
       * already declared separate, so it is not asked about again. */
      await reply('wamid.Z1-d-sep-2', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await reply('wamid.Z1-d-yes-2', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(3);
    });

    it('P2: a yes re-ask nobody saw gives back the newer question it retired', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'Z2');
      await say('wamid.Z2-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await say(
        'wamid.Z2-q',
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
      stubSender.failWith();
      await reply('wamid.Z2-d-yes', 'yes', DELEGATE);
      const open = [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ expects: string | null }>(sql`
            SELECT expects FROM conversation_continuations
             WHERE business_id = ${business.id}::uuid AND state = 'open'`),
        )),
      ].map((r) => r.expects);
      expect(open).toEqual(['period']);
      expect(await purchases(business.id)).toBe(1);
    });
  });
});
