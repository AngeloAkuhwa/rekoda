/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: G-68 final review 2. Split by concern from meta.integration.test.ts; the
 * shared app, stubs and payload helpers are in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { identity, withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { customersRepo } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

/**
 * G-68 final-head review 2: the G-61 rebuild is ONE-SHOT, the two-ask
 * erasure breaks on ANY message between the asks, and a funding answer is
 * taken only inside its window.
 */
describe('G-68 final review 2: one-shot rebuild, strict erasure pair, answer window', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const HOW_MUCH_DID_I_SELL = {
    intent: 'Query',
    topic: 'sales_summary',
    customer: null,
    period: null,
    periodText: null,
    format: 'chat',
  };
  const POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };
  const POS_QUESTION = 'did it come from your bank account or from physical cash?';

  async function seedMerchant(phone = `+${OWNER}`) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function addDelegate(businessId: string) {
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, businessId, delegate.id, 'delegate');
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string, from = OWNER) {
    stubTransport.replyWith(command);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function reply(wamid: string, text: string, from = OWNER) {
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function written(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM inventory_movements WHERE business_id = ${businessId}::uuid) AS arrivals,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings
        `),
      )),
    ];
    return row!;
  }

  async function purchaseStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts
         WHERE business_id = ${businessId}::uuid AND intent = 'RecordPurchase'
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  async function continuationStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM conversation_continuations
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  describe('F2. the rebuild is one-shot', () => {
    it('owner "bank" then delegate "cash", then two yeses: the purchase is booked ONCE', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.F2-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2-d-yes', 'yes', DELEGATE);
      expect(stubSender.lastText).toContain(POS_QUESTION);

      await reply('wamid.F2-o-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      /* The delegate's short answer was retired by the owner's rebuild. */
      expect(await continuationStates(business.id)).toEqual(['consumed', 'superseded']);
      await reply('wamid.F2-d-cash', 'cash', DELEGATE);
      /* The OWNER's rebuilt preview (from Bank) is waiting, but the delegate
       * never saw it and asked for cash: never pointed at it as theirs to
       * confirm, and never invited to send the purchase again either
       * (final-head review). */
      expect(stubSender.lastText).toBe(replies.previewWaitingForAnotherMember().text);

      await reply('wamid.F2-yes-1', 'yes', DELEGATE);
      await reply('wamid.F2-yes-2', 'yes');
      await reply('wamid.F2-yes-3', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 1, arrivals: 1 });
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'confirmed']);
    });

    it('a second answer from the same member after the rebuild makes no second preview', async () => {
      const business = await seedMerchant();
      await say('wamid.F2b-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2b-bank', 'bank');
      await reply('wamid.F2b-cash', 'cash');
      expect(stubSender.lastText).not.toContain('Please check this before I save it');
      /* Their own preview records a different account: it is named. */
      expect(stubSender.lastText).toBe(replies.previewAlreadyWaiting('transfer').text);
      expect(stubSender.lastText).toContain('paid from your bank account');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
    });
  });

  describe('F2c. another member’s waiting preview (final-head review)', () => {
    const RICE = {
      ...POS_PURCHASE,
      description: '5 bags of rice',
      amount: 50_000,
      reportedPayment: 50_000,
      paymentMethod: 'cash',
      productMention: 'bags of rice',
      quantity: 5,
    };

    it('another member sending the purchase again NEVER replaces the owner’s preview, and is told nothing false', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.F2c-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-d-yes', 'yes', DELEGATE);
      await reply('wamid.F2c-o-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      await reply('wamid.F2c-d-cash', 'cash', DELEGATE);
      expect(stubSender.lastText).toBe(replies.previewWaitingForAnotherMember().text);

      /* Sent again anyway by the delegate: never a replacement across
       * members, and the delegate is told nothing about "your" earlier
       * preview, which was never theirs. Since G-81 (OD-23) it is no longer
       * a second confirmable preview either (this test pinned that accepted
       * hazard as base): it is HELD and the delegate is asked whether it is
       * the same purchase, so the two yeses below book it once. */
      await say(
        'wamid.F2c-d-resend',
        { ...POS_PURCHASE, paymentMethod: 'cash' },
        'I bought 10 cartons for 180k, paid cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain('Is this the same purchase?');
      expect(stubSender.lastText).toContain('from another member');
      expect(stubSender.lastText).not.toContain('Your earlier preview');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending', 'held']);
      await reply('wamid.F2c-d-yes-1', 'yes');
      await reply('wamid.F2c-d-yes-2', 'yes', DELEGATE);
      expect(await written(business.id)).toMatchObject({ purchases: 1 });
    });

    it('the same member, a DIFFERENT total: both wait, and the reply says the earlier one still waits', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-x-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-x-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      await say('wamid.F2c-x-rice', RICE, 'bought 5 bags rice 50k cash');
      expect(stubSender.lastText).toContain('Your earlier preview of ₦180,000 is still waiting.');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending', 'pending']);
      await reply('wamid.F2c-x-yes-1', 'yes');
      await reply('wamid.F2c-x-yes-2', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 2 });
    });

    it('the same member, the same total under another product name: replaced, announced, booked ONCE', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-r-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-r-bank', 'bank');
      await say(
        'wamid.F2c-r-resend',
        { ...POS_PURCHASE, paymentMethod: 'cash', productMention: 'carton indomie' },
        'I bought carton indomie for 180k, paid cash',
      );
      expect(stubSender.lastText).toContain(
        'Your earlier preview of ₦180,000 was replaced by this one. If that was a different purchase, reply *yes* to save this one first, then send the other purchase.',
      );
      await reply('wamid.F2c-r-yes-1', 'yes');
      await reply('wamid.F2c-r-yes-2', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 1 });
    });

    it('the same member following the replacement advice gets BOTH purchases in (final-head review of #262)', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-a-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-a-bank', 'bank');
      await say(
        'wamid.F2c-a-indomie',
        { ...POS_PURCHASE, paymentMethod: 'cash', productMention: 'carton indomie' },
        'I bought carton indomie for 180k, paid cash',
      );
      expect(stubSender.lastText).toContain('reply *yes* to save this one first');
      /* As advised: save this one, then send the other purchase. It now
       * meets a SAVED purchase, so it is asked about, never replaced. */
      await reply('wamid.F2c-a-yes-1', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 1 });
      await say(
        'wamid.F2c-a-milo',
        { ...POS_PURCHASE, paymentMethod: 'cash' },
        'I bought 10 cartons for 180k, paid cash',
      );
      expect(stubSender.lastText).toContain('Is this the same purchase?');
      expect(stubSender.lastText).not.toContain('was replaced by this one');
      await reply('wamid.F2c-a-sep', 'separate');
      await reply('wamid.F2c-a-yes-2', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 2 });
    });

    it('a replacement whose send fails gives back the preview the merchant saw (Codex review)', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-f-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-f-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      stubSender.failWith();
      await say(
        'wamid.F2c-f-resend',
        { ...POS_PURCHASE, paymentMethod: 'cash' },
        'I bought 10 cartons for 180k, paid cash',
      );
      /* Nobody saw the replacement: it is superseded, the Bank preview is
       * pending again, and a yes books THAT one, once. */
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending', 'superseded']);
      await reply('wamid.F2c-f-yes-1', 'yes');
      await reply('wamid.F2c-f-yes-2', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 1 });
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'confirmed', 'superseded']);
    });

    it('a resend whose preview fails to send gives the question back; "cash" then rebuilds once (Codex review)', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-w-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      stubSender.failWith();
      await say(
        'wamid.F2c-w-resend',
        { ...POS_PURCHASE, paymentMethod: 'cash' },
        'I bought 10 cartons for 180k, paid cash',
      );
      /* Nobody saw the resend's preview: withdrawn, the question restored. */
      expect(await purchaseStates(business.id)).toEqual(['abandoned', 'superseded']);
      await reply('wamid.F2c-w-cash', 'cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      await reply('wamid.F2c-w-yes-1', 'yes');
      await reply('wamid.F2c-w-yes-2', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 1 });
    });

    it('a rebuild with no recorded requester is never replaced', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-n-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-n-bank', 'bank');
      /* As a rebuild written before 0157 recorded who asked. */
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET requested_by = NULL
           WHERE business_id = ${business.id}::uuid AND rebuilt_from IS NOT NULL`),
      );
      await say(
        'wamid.F2c-n-resend',
        { ...POS_PURCHASE, paymentMethod: 'cash' },
        'I bought 10 cartons for 180k, paid cash',
      );
      expect(stubSender.lastText).not.toContain('Your earlier preview');
      /* G-81: a draft with no recorded requester is never "yours", so it
       * is never replaced; nor is it left beside a second confirmable
       * preview of the same total any more (base, which this test pinned):
       * the new one is HELD and asked about. */
      expect(stubSender.lastText).toContain('Is this the same purchase?');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending', 'held']);
    });

    it('a sale preview after the question is never called the waiting purchase', async () => {
      await seedMerchant();
      await say('wamid.F2c-q-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await say(
        'wamid.F2c-q-sale',
        {
          intent: 'RecordSale',
          customer: { kind: 'token', token: 'CUSTOMER_7K2' },
          items: [{ name: 'wig', quantity: 3, unitPrice: 15_000 }],
          statedTotal: 45_000,
          reportedPayment: 0,
          paymentMethod: 'transfer',
          discount: null,
          deliveryFee: null,
          dueDescription: null,
        },
        'sold Ada 3 wigs for 45k',
      );
      await reply('wamid.F2c-q-cash', 'cash');
      expect(stubSender.lastText).not.toBe(replies.previewAlreadyWaiting().text);
      expect(stubSender.lastText).not.toContain('already waiting');
      expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
    });

    it('the same member naming the same account again is pointed at their preview, unnamed', async () => {
      await seedMerchant();
      await say('wamid.F2c-s-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-s-bank', 'bank');
      await reply('wamid.F2c-s-bank-2', 'bank');
      expect(stubSender.lastText).toBe(replies.previewAlreadyWaiting().text);
    });
  });

  describe('F1. any message between the two erasure asks keeps the data', () => {
    async function seedCustomer(businessId: string) {
      const customer = await customersRepo.createCustomerWithIdentities(
        db,
        businessId,
        'CUSTOMER_T9',
        [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g68-f1' }],
      );
      return () =>
        withBusiness(db, businessId, (tx) =>
          customersRepo.identityFacetsFor(tx, businessId, customer.id),
        );
    }

    it.each([
      ['who still dey owe me', OWNER],
      ['wetin you fit do', OWNER],
      ['make i see my books', OWNER],
      ['how many remain', OWNER],
      ['i wan upgrade', OWNER],
      /* An English free command now breaks the pair too: stricter than base,
       * the safe direction, and what the copy promises. */
      ['who owes me', OWNER],
    ])('%j between the asks breaks the pair', async (between, from) => {
      const business = await seedMerchant();
      const facets = await seedCustomer(business.id);
      await reply('wamid.F1-del1', 'delete my data');
      await reply('wamid.F1-between', between, from);
      await reply('wamid.F1-del2', 'delete my data');
      expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
      expect(await facets()).toHaveLength(1);
    });

    it("another member's answer to their own question breaks the pair", async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      const facets = await seedCustomer(business.id);
      await say('wamid.F1-d-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?', DELEGATE);
      await reply('wamid.F1b-del1', 'delete my data');
      await reply('wamid.F1b-y', 'yesterday', DELEGATE);
      expect(stubSender.lastText).toBe(replies.periodNotCountable('sales').text);
      await reply('wamid.F1b-del2', 'delete my data');
      expect(await facets()).toHaveLength(1);
    });

    it("another member's doubtful funding answer breaks the pair", async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      const facets = await seedCustomer(business.id);
      await say(
        'wamid.F1c-pos',
        POS_PURCHASE,
        'I bought 10 cartons for 180k, paid by POS',
        DELEGATE,
      );
      await reply('wamid.F1c-del1', 'delete my data');
      await reply('wamid.F1c-q', 'cash?', DELEGATE);
      await reply('wamid.F1c-del2', 'delete my data');
      expect(await facets()).toHaveLength(1);
    });

    it('the two asks with nothing between still erase', async () => {
      const business = await seedMerchant();
      const facets = await seedCustomer(business.id);
      await reply('wamid.F1d-del1', 'delete my data');
      await reply('wamid.F1d-del2', 'delete my data');
      expect(stubSender.lastText).toContain('deleted (1 record)');
      expect(await facets()).toHaveLength(0);
    });
  });

  describe('F3. a funding answer is taken only inside its window', () => {
    const age = (businessId: string, minutes: number) =>
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts
             SET created_at = clock_timestamp() - make_interval(mins => ${minutes})
           WHERE business_id = ${businessId}::uuid AND state = 'abandoned'`),
      );

    it('inside the window, a re-ask after the continuation expired still rebuilds', async () => {
      const business = await seedMerchant();
      await say('wamid.F3a-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await age(business.id, 20);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '1 second'
           WHERE business_id = ${business.id}::uuid`),
      );
      await reply('wamid.F3a-yes', 'yes');
      expect(stubSender.lastText).toContain('Reply *bank* or *cash*');
      await reply('wamid.F3a-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
    });

    it('after the window, the re-ask offers no short answer and "bank" rebuilds nothing', async () => {
      const business = await seedMerchant();
      await say('wamid.F3b-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await age(business.id, 31);
      await reply('wamid.F3b-yes', 'yes');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(stubSender.lastText).not.toContain('Reply *bank*');
      expect(stubSender.lastText).toContain('Record it again with where the money came');

      await reply('wamid.F3b-bank', 'bank');
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      expect(await written(business.id)).toEqual({ purchases: 0, arrivals: 0, postings: 0 });
    });

    it('an open continuation past the window does not rebuild either', async () => {
      const business = await seedMerchant();
      await say('wamid.F3c-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await age(business.id, 31);
      await reply('wamid.F3c-bank', 'bank');
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
    });
  });
});
