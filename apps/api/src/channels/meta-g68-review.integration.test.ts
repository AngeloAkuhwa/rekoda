/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: G-68 review rounds 1 and 2. Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
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
import { setPlanForTest } from '@rekoda/db/testing';

useMetaWebhookHarness();

/**
 * G-68 post-rebase review: a questioned "yes" confirms nothing; every gate
 * on the funding answer is load-bearing; a "no" that closes a question says
 * so truthfully.
 */
describe('G-68 review: doubt, the funding gates, and closing a question', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 15_000 }],
    statedTotal: 45_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
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
    return delegate.id;
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

  const modelCalls = () => stubTransport.requests.length;

  async function footprint(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
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

  describe('I1. an affirmation asked as a question confirms nothing', () => {
    it.each(['na so?', 'yes?', 'e correct?', 'oya?', 'na so 🤔', 'Na so ❓'])(
      '%j to a live ₦45,000 preview writes nothing, and only a plain yes saves it',
      async (text) => {
        const business = await seedMerchant();
        await say('wamid.R-q-sale', A_SALE, 'sold Ada 3 wigs for 45k');
        expect(stubSender.lastText).toContain('Please check this before I save it');

        await reply('wamid.R-q-doubt', text);
        expect(stubSender.lastText).toBe(replies.plainYesNeeded().text);
        expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
        /* `reply` resets the transport log: zero means no model since. */
        expect(modelCalls()).toBe(0);

        await reply('wamid.R-q-yes', 'yes');
        expect((await footprint(business.id)).invoices).toBe(1);
      },
    );

    /* G-85: a mark the normaliser would drop (a ring drawn through the word,
     * an x over it) is not a yes either. */
    it.each(['yes⃘', 'na soͯ', 'yes͓', '⃘yes', 'e correct⃚', 'YES⃙'])(
      'G-85: a marked %j to a live preview writes nothing, and only a plain yes saves it',
      async (text) => {
        const business = await seedMerchant();
        await say('wamid.R-g85-sale', A_SALE, 'sold Ada 3 wigs for 45k');
        expect(stubSender.lastText).toContain('Please check this before I save it');

        await reply('wamid.R-g85-marked', text);
        expect(stubSender.lastText).toBe(replies.plainYesNeeded().text);
        expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
        /* `reply` resets the transport log: zero means no model since. */
        expect(modelCalls()).toBe(0);

        await reply('wamid.R-g85-yes', 'yes');
        expect((await footprint(business.id)).invoices).toBe(1);
      },
    );

    it('with nothing waiting, it says nothing is waiting for a yes', async () => {
      await seedMerchant();
      await reply('wamid.R-q-none', 'na so?');
      expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
      expect(modelCalls()).toBe(0);
    });

    it('to the funding question, it re-asks and keeps the question open', async () => {
      const business = await seedMerchant();
      await say('wamid.R-q-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.R-q-pos-doubt', 'na so?');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(stubSender.lastText).toContain('Reply *bank* or *cash*');
      expect(await continuationStates(business.id)).toEqual(['open']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });

    it('to an expired preview, it is told the request expired', async () => {
      const business = await seedMerchant();
      await say('wamid.R-q-exp', A_SALE, 'sold Ada 3 wigs for 45k');
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 day'
           WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
      );
      await reply('wamid.R-q-exp-doubt', 'na so?');
      expect(stubSender.lastText).toBe(replies.draftExpired().text);
      expect((await footprint(business.id)).invoices).toBe(0);
    });
  });

  describe('I2. every gate on the funding answer refuses, and writes nothing', () => {
    async function askFunding(businessId: string, from = OWNER) {
      await say('wamid.R-g-ask', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS', from);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(await purchaseStates(businessId)).toEqual(['abandoned']);
    }

    it('a member made view-only since the question gets no draft', async () => {
      const business = await seedMerchant();
      const delegateId = await addDelegate(business.id);
      await askFunding(business.id, DELEGATE);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE memberships SET role = 'accountant'
           WHERE business_id = ${business.id}::uuid AND user_id = ${delegateId}::uuid`),
      );
      await reply('wamid.R-g-view', 'cash', DELEGATE);
      expect(stubSender.lastText).toBe(replies.viewOnlyRole().text);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });

    it('a trial that lapsed since the question gets no draft', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await setPlanForTest(db, {
        businessId: business.id,
        plan: 'trial',
        expiresAt: new Date(Date.now() - 1_000),
        actor: 'operator:test-clock',
      });
      await reply('wamid.R-g-lapsed', 'cash');
      expect(stubSender.lastText).toBe(replies.trialEnded().text);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });

    it('a plan without Chat since the question gets no draft', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await setPlanForTest(db, {
        businessId: business.id,
        plan: 'integrate',
        expiresAt: null,
        actor: 'operator:test',
      });
      await reply('wamid.R-g-nochat', 'bank');
      expect(stubSender.lastText).toBe(replies.chatNotInPlan().text);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });

    it('"na so" after the REBUILT preview window closed writes nothing', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await reply('wamid.R-g-cash', 'cash');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 day'
           WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
      );
      await reply('wamid.R-g-late-yes', 'na so');
      expect(stubSender.lastText).toBe(replies.draftExpired().text);
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'expired']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });

    it('a question closed by another member is said to be closed, and nothing is rebuilt', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await askFunding(business.id);
      await reply('wamid.R-g-dno', 'no', DELEGATE);
      expect(stubSender.lastText).toBe(replies.cancelled().text);

      await reply('wamid.R-g-cash-after', 'cash');
      expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
      expect(await purchaseStates(business.id)).toEqual(['superseded']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });
  });

  describe('M4. a "no" that closes only a question says so', () => {
    it('"no" to "Which period?" leaves the question, never "nothing is waiting"', async () => {
      const business = await seedMerchant();
      await say('wamid.R-m4-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.R-m4-no', 'no');
      expect(stubSender.lastText).toBe(replies.questionLeft().text);
      expect(stubSender.lastText).not.toBe(replies.nothingToDecline().text);
      expect(await continuationStates(business.id)).toEqual(['superseded']);
      expect(modelCalls()).toBe(0);
    });

    it('"forget am" to "Which period?" leaves the question too', async () => {
      await seedMerchant();
      await say('wamid.R-m4b-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.R-m4b-cancel', 'forget am');
      expect(stubSender.lastText).toBe(replies.questionLeft().text);
    });

    it('"no" to the funding question still cancels it (G-61)', async () => {
      await seedMerchant();
      await say('wamid.R-m4c-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.R-m4c-no', 'no be so');
      expect(stubSender.lastText).toBe(replies.cancelled().text);
    });
  });
});

/**
 * G-68 final-head review: the two-ask erasure survives a questioned yes, a
 * question mark anywhere makes an affirmation a question, and a re-asked
 * funding question can always be answered as it says.
 */
describe('G-68 final review: erasure, doubt anywhere, re-asked funding question', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 15_000 }],
    statedTotal: 45_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
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

  const modelCalls = () => stubTransport.requests.length;

  async function footprint(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
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

  describe('I1. a questioned yes between the two erasure asks keeps the data', () => {
    it.each(['yes?', 'na so?', 'e correct 🤔'])(
      '%j breaks the pair: nothing is erased',
      async (doubt) => {
        const business = await seedMerchant();
        const customer = await customersRepo.createCustomerWithIdentities(
          db,
          business.id,
          'CUSTOMER_T9',
          [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g68-erase' }],
        );
        const facets = () =>
          withBusiness(db, business.id, (tx) =>
            customersRepo.identityFacetsFor(tx, business.id, customer.id),
          );

        await reply('wamid.F-del1', 'delete my data');
        expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

        await reply('wamid.F-del-doubt', doubt);
        expect(stubSender.lastText).toBe(replies.erasureKept().text);

        /* No longer the second of a pair: a new first ask, nothing erased. */
        await reply('wamid.F-del2', 'delete my data');
        expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
        expect(await facets()).toHaveLength(1);
      },
    );
  });

  describe('I2. a question mark anywhere makes an affirmation a question', () => {
    it.each([
      'yes?!',
      'na so?!',
      'na so ?!',
      'e correct?.',
      'yes ?)',
      'yes? 👍',
      'yes?? ok',
      'na so?o',
      'yes?​',
      'yes¿',
      'yes 🙄',
    ])('%j to a live preview writes nothing', async (text) => {
      const business = await seedMerchant();
      await say('wamid.F-q-sale', A_SALE, 'sold Ada 3 wigs for 45k');
      await reply('wamid.F-q', text);
      expect(stubSender.lastText).toBe(replies.plainYesNeeded().text);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
      expect(modelCalls()).toBe(0);
    });
  });

  describe('I3. a re-asked funding question can be answered as it says', () => {
    it('after the first question expired, a yes re-asks and "bank" then gives a fresh preview', async () => {
      const business = await seedMerchant();
      await say('wamid.F-r-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '1 second'
           WHERE business_id = ${business.id}::uuid`),
      );
      await reply('wamid.F-r-yes', 'yes');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(stubSender.lastText).toContain('Reply *bank* or *cash*');

      await reply('wamid.F-r-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      expect(modelCalls()).toBe(0);
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
    });

    it('after an unrelated free command retired it, a yes re-opens it', async () => {
      const business = await seedMerchant();
      await say('wamid.F-r2-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F-r2-other', 'wetin remain');
      expect(stubSender.lastText).toContain('You are not counting any stock yet');
      await reply('wamid.F-r2-yes', 'na so');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await reply('wamid.F-r2-cash', 'cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
    });

    it("a second member's yes opens it for THEM, and their answer passes their own gates", async () => {
      const business = await seedMerchant();
      const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      await say('wamid.F-r3-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');

      await reply('wamid.F-r3-yes', 'yes', DELEGATE);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await reply('wamid.F-r3-bank', 'bank', DELEGATE);
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      expect(modelCalls()).toBe(0);
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
    });

    it('a questioned answer ("cash?") rebuilds nothing and asks again, keeping it open', async () => {
      const business = await seedMerchant();
      await say('wamid.F-r4-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F-r4-q', 'cash?');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      await reply('wamid.F-r4-cash', 'cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
    });
  });

  describe('minor: a questioned yes carries the role rule', () => {
    it('a view-only member is told so, never "reply yes to save it"', async () => {
      const business = await seedMerchant();
      const accountant = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
      await identity.addMembership(db, business.id, accountant.id, 'accountant');
      await say('wamid.F-v-sale', A_SALE, 'sold Ada 3 wigs for 45k');
      await reply('wamid.F-v-q', 'na so?', DELEGATE);
      expect(stubSender.lastText).toBe(replies.viewOnlyRole().text);
      expect((await footprint(business.id)).invoices).toBe(0);
    });
  });
});
