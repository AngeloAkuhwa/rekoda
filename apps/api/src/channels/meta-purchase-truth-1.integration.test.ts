/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: one real purchase, one financial truth (G-81, OD-23) (part 1 of 5). Split
 * by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are in
 * meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
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
  footprint,
  purchases,
  knownSupplier,
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
  describe('1. a provider replay is a no-op', () => {
    it('the same message delivered twice gives one draft, one reply and one booking', async () => {
      const business = await seedMerchant();
      stubTransport.replyWith(MILO);
      const payload = messagePayload(
        OWNER,
        'wamid.R1-buy',
        'I bought 10 cartons of Milo for 100k cash',
      );
      await post(payload);
      await post(payload);
      await drain();
      await post(payload);
      await drain();
      expect(await purchaseStates(business.id)).toEqual(['pending']);
      const yes = messagePayload(OWNER, 'wamid.R1-yes', 'yes');
      await post(yes);
      await drain();
      await post(yes);
      await drain();
      expect(await purchases(business.id)).toBe(1);
      expect(stubSender.sent.length).toBe(2);
    });
  });

  describe('2. the same member sending it again never books it twice', () => {
    it('a resend while the first preview waits replaces it, and two yeses book it once', async () => {
      const business = await seedMerchant();
      await say('wamid.S2-a', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      await say('wamid.S2-b', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      expect(stubSender.lastText).toContain('Your earlier preview of ₦100,000 was replaced');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
      await reply('wamid.S2-yes-1', 'yes');
      await reply('wamid.S2-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });

    it('a resend after the purchase was booked is asked about, and "same" saves nothing more', async () => {
      const business = await seedMerchant();
      await bookMilo(business.id, 'S2b');
      await say('wamid.S2b-again', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).toContain('sent by you');
      await reply('wamid.S2b-ask-yes', 'yes');
      expect(stubSender.lastText).toContain(REASK);
      await reply('wamid.S2b-same', 'same');
      expect(stubSender.lastText).toContain(SAME_DONE);
      await reply('wamid.S2b-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('3. two members, one purchase', () => {
    it('the delegate is asked, and every yes books it ONCE', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.X3-o', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      await say(
        'wamid.X3-d',
        MILO,
        'I bought 10 cartons of Milo from Emeka for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).toContain('another member');
      expect(await purchaseStates(business.id)).toEqual(['pending', 'held']);
      await reply('wamid.X3-d-yes', 'yes', DELEGATE);
      expect(stubSender.lastText).toContain(REASK);
      await reply('wamid.X3-o-yes', 'yes');
      await reply('wamid.X3-d-same', 'same', DELEGATE);
      await reply('wamid.X3-d-yes-2', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('after the owner booked it, the delegate sending it again is asked, never booked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'X3b');
      await say('wamid.X3b-d', MILO, 'I bought 10 cartons of Milo from Emeka for 100k', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).toContain('A stock purchase of ₦100,000 was already saved');
      await reply('wamid.X3b-d-yes', 'yes', DELEGATE);
      await reply('wamid.X3b-d-yes-2', 'na so', DELEGATE);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('4. a draft with no recorded requester is never the same member', () => {
    it('a member and an unattributed preview of one purchase cannot both book', async () => {
      const business = await seedMerchant();
      await say('wamid.N4-a', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET requested_by = NULL WHERE business_id = ${business.id}::uuid`),
      );
      await say('wamid.N4-b', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).not.toContain('replaced');
      expect(await purchaseStates(business.id)).toEqual(['pending', 'held']);
      await reply('wamid.N4-yes-1', 'yes');
      await reply('wamid.N4-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(0);
      await reply('wamid.N4-same', 'same');
      await reply('wamid.N4-yes-3', 'yes');
      await reply('wamid.N4-yes-4', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('5 and 6. a duplicate that reaches a yes is stopped in the purchase work', () => {
    /* Two pending previews of one purchase that nothing proves separate:
     * built here by hand, as drafts from before this fix would leave them,
     * because the chat flow no longer produces them. */
    async function twoPendingPreviews(businessId: string) {
      await addDelegate(businessId);
      await say(
        'wamid.F6-o',
        { ...MILO, supplierReference: 'invoice 0101' },
        'Milo 100k, receipt EMK-0101',
      );
      await say(
        'wamid.F6-d',
        { ...MILO, amount: 100_001, reportedPayment: 100_001 },
        'Milo 100k, receipt EMK-0202',
        DELEGATE,
      );
      await withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = (command - 'supplierReference') || ${ALIGN}::jsonb
           WHERE business_id = ${businessId}::uuid`),
      );
      expect(await purchaseStates(businessId)).toEqual(['pending', 'pending']);
    }

    it('the second yes is refused truthfully, and leaves no footprint', async () => {
      const business = await seedMerchant();
      await twoPendingPreviews(business.id);
      /* OD-15: a yes confirms the newest preview, the delegate's. */
      await reply('wamid.F6-yes-1', 'yes');
      expect(await purchases(business.id)).toBe(1);
      const before = await footprint(business.id);
      await reply('wamid.F6-yes-2', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(stubSender.lastText).toContain(QUESTION);
      expect(await footprint(business.id)).toEqual(before);
      expect(await purchaseStates(business.id)).toEqual(['held', 'confirmed']);
      await reply('wamid.F6-same', 'same');
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(await footprint(business.id)).toEqual(before);
    });

    it('with DIFFERENT references kept on both previews, the second yes is still refused (OWN-32)', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say(
        'wamid.F6r-o',
        { ...MILO, supplierReference: 'invoice 0101' },
        'Milo 100k, invoice 0101',
      );
      await say(
        'wamid.F6r-d',
        { ...MILO, amount: 100_001, reportedPayment: 100_001, supplierReference: 'invoice 0202' },
        'Milo 100,001, invoice 0202',
        DELEGATE,
      );
      /* Only the total is aligned: both references stay, as two previews left
       * from before OWN-32 would carry them. */
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = command || ${ALIGN}::jsonb
           WHERE business_id = ${business.id}::uuid`),
      );
      const refs = await withBusiness(db, business.id, (tx) =>
        tx.execute<{ ref: string }>(sql`
          SELECT command->>'supplierReference' AS ref FROM command_drafts
           WHERE business_id = ${business.id}::uuid ORDER BY insertion_seq`),
      );
      expect([...refs].map((r) => r.ref)).toEqual(['INV:0101', 'INV:0202']);
      await reply('wamid.F6r-yes-1', 'yes');
      expect(await purchases(business.id)).toBe(1);
      const before = await footprint(business.id);
      /* RED before OWN-32: invoice 0101 and invoice 0202 proved two purchases,
       * so this yes booked the second. */
      await reply('wamid.F6r-yes-2', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(await footprint(business.id)).toEqual(before);
    });

    it('through the command bus too: no idempotency record survives the refusal', async () => {
      const config = deps.config as { commandRecordPurchase: boolean };
      const was = config.commandRecordPurchase;
      config.commandRecordPurchase = true;
      try {
        const business = await seedMerchant();
        await twoPendingPreviews(business.id);
        await reply('wamid.F6b-yes-1', 'yes');
        const before = await footprint(business.id);
        expect(before.keys).toBe(1);
        await reply('wamid.F6b-yes-2', 'yes');
        expect(stubSender.lastText).toContain(RACE);
        expect(await footprint(business.id)).toEqual(before);
      } finally {
        config.commandRecordPurchase = was;
      }
    });
  });

  describe('7. two real purchases of the same amount are both bookable', () => {
    it('"another 10 cartons" is asked about, and "separate" books the second', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'N7');
      await say(
        'wamid.N7-d',
        MILO,
        'I bought another 10 cartons of Milo from Emeka for ₦100,000 today',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.N7-d-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      expect(stubSender.lastText).toContain('Paid in full by cash');
      await reply('wamid.N7-d-yes', 'yes', DELEGATE);
      const books = await footprint(business.id);
      expect(books.purchases).toBe(2);
      expect(books.arrivals).toBe(2);
    });
  });

  describe('8. a different KNOWN product is a different purchase (dormant: no catalogue writer yet)', () => {
    /* DORMANT in production (fresh review of 75fd1c9): nothing writes
     * `external_catalogue_id` today, so this proof is set up by hand here and
     * no live purchase is proven separate by product. Before any catalogue
     * writer ships, product proof must never rest on a raw name match. */
    it('same supplier and amount, another known product: no question, both book', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await knownSupplier(business.id, 'Emeka');
      await knownProduct(business.id, 'Milo');
      await knownProduct(business.id, 'Peak milk');
      await bookMilo(business.id, 'P8');
      await say(
        'wamid.P8-peak',
        { ...MILO, description: '10 cartons of Peak milk', productMention: 'Peak milk' },
        'I bought 10 cartons of Peak milk from Emeka for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).not.toContain(QUESTION);
      await reply('wamid.P8-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(2);
    });

    it('a product named for the first time proves nothing: asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await knownSupplier(business.id, 'Emeka');
      await bookMilo(business.id, 'P8b');
      await say(
        'wamid.P8b-new',
        { ...MILO, description: '10 cartons of Milo 400g', productMention: 'Milo 400g' },
        'I bought 10 cartons of Milo 400g from Emeka for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });

    it('quantity alone never proves a different purchase', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'P8c');
      await say(
        'wamid.P8c-q',
        { ...MILO, quantity: 12, description: '12 cartons of Milo' },
        'I bought 12 cartons of Milo from Emeka for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });
  });

  describe('9. a different explicit reference is asked about, never proof (OWN-32, G-92(5))', () => {
    it('same product and amount, another supplier receipt number: asked, and "separate" books both', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say(
        'wamid.F9-a',
        { ...MILO, supplierReference: 'receipt 0041' },
        'Milo 100k receipt EMK-0041',
      );
      await reply('wamid.F9-a-yes', 'yes');
      await say(
        'wamid.F9-b',
        { ...MILO, supplierReference: 'receipt 0042' },
        'Milo 100k receipt EMK-0042',
        DELEGATE,
      );
      /* RED before OWN-32: two receipt numbers proved two purchases, so one
       * purchase read twice (a misread digit, or the supplier's receipt and
       * a POS slip) booked twice with no question. */
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.F9-b-yes-early', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(1);
      await reply('wamid.F9-b-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await reply('wamid.F9-b-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(2);
    });

    it('a misread digit on one invoice is asked about, and "same" books nothing more', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say(
        'wamid.F9m-a',
        { ...MILO, supplierReference: 'invoice 2231' },
        'Milo 100k invoice 2231',
      );
      await reply('wamid.F9m-a-yes', 'yes');
      await say(
        'wamid.F9m-b',
        { ...MILO, supplierReference: 'INV 2281' },
        'Milo 100k INV 2281',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
      const before = await footprint(business.id);
      await reply('wamid.F9m-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      await reply('wamid.F9m-yes', 'yes', DELEGATE);
      expect(await footprint(business.id)).toEqual(before);
    });

    it('the SAME reference is asked about', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say(
        'wamid.F9c-a',
        { ...MILO, supplierReference: 'receipt 0041' },
        'Milo 100k receipt EMK-0041',
      );
      await reply('wamid.F9c-a-yes', 'yes');
      await say(
        'wamid.F9c-b',
        { ...MILO, supplierReference: 'RCPT-41' },
        'Milo 100k receipt emk 0041',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });
  });

  describe('10. the same purchase in other words is still found', () => {
    it('different wording and a different supplier and product spelling: asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'W10');
      await say(
        'wamid.W10-d',
        {
          ...MILO,
          supplierMention: 'Emeka Stores',
          description: 'milo ten cartons',
          productMention: 'cartons of milo',
          paymentMethod: 'transfer',
        },
        'Milo, ten cartons, Emeka Stores, 100k transfer',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });

    it('a booked purchase older than 24 hours is not compared', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'W10b');
      /* D2 measures from the earlier purchase's MESSAGE: it and its booking
       * both happened 25 hours ago. */
      await withBusiness(db, business.id, async (tx) => {
        for (const table of ['expenses', 'conversation_messages', 'external_events']) {
          await tx.execute(sql`
            UPDATE ${sql.raw(table)} SET created_at = clock_timestamp() - interval '25 hours'
             WHERE business_id = ${business.id}::uuid`);
        }
      });
      await say('wamid.W10b-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).not.toContain(QUESTION);
      expect(stubSender.lastText).toContain('Paid in full by cash');
    });
  });

  describe('11. an expired question cannot execute', () => {
    it('"separate" after the question closed rebuilds nothing, and a yes saves nothing', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'E11');
      await say('wamid.E11-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await withBusiness(db, business.id, async (tx) => {
        await tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 hour'
           WHERE business_id = ${business.id}::uuid AND state = 'held'`);
        await tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '1 hour'
           WHERE business_id = ${business.id}::uuid`);
      });
      const before = await footprint(business.id);
      await reply('wamid.E11-d-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(CLOSED);
      /* No model call, so no unit, and nothing written. */
      expect(stubTransport.requests).toHaveLength(0);
      expect(await footprint(business.id)).toEqual(before);
      await reply('wamid.E11-d-yes', 'yes', DELEGATE);
      /* Past its window the question asks nothing (fresh review of #262): the
       * yes is answered as one with nothing waiting, and saves nothing. */
      expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
      expect(await purchases(business.id)).toBe(1);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
    });
  });

  describe('12. G-23 still governs every preview', () => {
    it('the fresh preview "separate" shows has its own window, and the held draft never expires into a yes', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'G12');
      await say('wamid.G12-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await withBusiness(db, business.id, (tx) =>
        conversationsRepo.expireStaleDrafts(tx, business.id, {
          now: new Date(Date.now() + 86_400_000),
        }),
      );
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
      await reply('wamid.G12-d-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 day'
           WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
      );
      await reply('wamid.G12-d-yes', 'yes', DELEGATE);
      expect(stubSender.lastText).toBe(replies.draftExpired().text);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('13. G-61 still asks where the money came from first', () => {
    const POS = { ...MILO, paymentMethod: 'pos' };
    const POS_QUESTION = 'did it come from your bank account or from physical cash?';

    it('a POS duplicate is asked the funding question, then the identity question on "cash"', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'G13');
      await say('wamid.G13-pos', POS, 'I bought 10 cartons of Milo for 100k by POS', DELEGATE);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await reply('wamid.G13-cash', 'cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.G13-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      await reply('wamid.G13-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(1);
    });
  });
});
