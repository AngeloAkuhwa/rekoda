/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: Nigerian and chat routing (G-68, G-24). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, identity, usageRepo, withBusiness, sql } from '@rekoda/db';
import { replies, usagePeriod } from '@rekoda/core';
import { truncateAll } from '@rekoda/db/testing';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  urls,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

/**
 * Nigerian and chat routing correctness (G-68, G-24; OWN-18).
 *
 * Standard English, Nigerian English, Nigerian Pidgin and code-switching are
 * first-class merchant registers, and every one of them converges on the
 * SAME confirmation, expiry, consent, cost and privacy rules. These run the
 * whole webhook-to-reply path, so "the router said affirm" is checked as
 * "the yes did what a yes does", and "no model" as zero transport requests
 * and zero AI_ACTIONS.
 */
describe('Nigerian and chat routing (G-68, G-24)', () => {
  const PHONE = '+2348031234567';
  const WA = '2348031234567';
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 100_000 }],
    statedTotal: 300_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
  const AN_EXPENSE = {
    intent: 'RecordExpense',
    description: 'fuel for generator',
    amount: 20_000,
    category: 'utilities',
    paymentMethod: 'cash',
  };
  const A_POS_PURCHASE = {
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
  const EXPIRED = replies.draftExpired().text;
  const NOTHING_TO_DECLINE = replies.nothingToDecline().text;

  async function seedMerchant() {
    const user = await identity.upsertUserByPhone(db, PHONE);
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

  async function say(wamid: string, command: Record<string, unknown>, text: string) {
    stubTransport.replyWith(command);
    await post(messagePayload(WA, wamid, text));
    await drain();
  }

  async function plain(wamid: string, text: string) {
    await post(messagePayload(WA, wamid, text));
    await drain();
  }

  const lapse = (businessId: string, where = sql`state = 'pending'`) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 days'
         WHERE business_id = ${businessId}::uuid AND ${where}`),
    );

  async function states(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts WHERE business_id = ${businessId}::uuid
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  async function written(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS expenses,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings
        `),
      )),
    ];
    return row!;
  }

  async function aiActions(businessId: string): Promise<number> {
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    return rows.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0;
  }

  async function lastInboundBody(businessId: string): Promise<string | null> {
    const messages = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesFor(tx, businessId),
    );
    const inbound = messages.filter((m) => m.direction === 'inbound');
    return inbound[inbound.length - 1]?.body ?? null;
  }

  describe('a bare "no" with nothing waiting is answered, never silent (G-68)', () => {
    it.each(['no', 'nope', 'nah', 'no be so', 'e no correct'])(
      '%j gets a truthful reply, no model, no unit, no fake cancellation',
      async (text) => {
        const business = await seedMerchant();
        await plain(`wamid.G68-bare-${text}`, text);

        expect(stubSender.sent).toHaveLength(1);
        expect(stubSender.lastText).toBe(NOTHING_TO_DECLINE);
        expect(stubSender.lastText).not.toBe(replies.cancelled().text);
        expect(stubTransport.requests).toHaveLength(0);
        expect(await aiActions(business.id)).toBe(0);
        /* Routed locally: stored as its classification, never tokenised. */
        expect(await lastInboundBody(business.id)).toBe('[deny]');
        expect(await states(business.id)).toEqual([]);
      },
    );

    it.each([
      'cancel',
      'forget it',
      'forget am',
      'leave am',
      'no do am',
      'make we leave am',
      'cancel am',
    ])('%j with nothing waiting says so, and never "Cancelled"', async (text) => {
      const business = await seedMerchant();
      await plain(`wamid.G68-cancel-${text}`, text);
      expect(stubSender.lastText).toBe(replies.nothingToCancel().text);
      expect(stubSender.lastText).not.toBe(replies.cancelled().text);
      expect(stubTransport.requests).toHaveLength(0);
      expect(await aiActions(business.id)).toBe(0);
      expect(await lastInboundBody(business.id)).toBe('[cancel]');
    });

    it('"forget am" after a confirmed invoice is not told the invoice was cancelled', async () => {
      const business = await seedMerchant();
      await say('wamid.G68-void', A_SALE, 'sold Ada 3 wigs for 300k');
      await plain('wamid.G68-void-yes', 'na so');
      expect((await written(business.id)).invoices).toBe(1);

      await plain('wamid.G68-void-forget', 'forget am');
      expect(stubSender.lastText).toBe(replies.nothingToCancel().text);
      expect(stubSender.lastText).not.toMatch(/^Cancelled/);
      /* The invoice is exactly as it was. */
      expect((await written(business.id)).invoices).toBe(1);
      expect(await states(business.id)).toEqual(['confirmed']);
    });

    it('a "no" to a live preview still cancels it, in either register', async () => {
      for (const [i, text] of ['no', 'no be so'].entries()) {
        const business = await seedMerchant();
        await say(`wamid.G68-live-${i}`, A_SALE, 'sold Ada 3 wigs for 300k');
        expect(stubSender.lastText).toContain('Please check this before I save it');
        await plain(`wamid.G68-live-${i}-no`, text);
        expect(stubSender.lastText).toBe(replies.cancelled().text);
        expect(await states(business.id)).toEqual(['superseded']);
        /* And the yes that follows confirms nothing. */
        await plain(`wamid.G68-live-${i}-yes`, 'na so');
        expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
        expect((await written(business.id)).invoices).toBe(0);
        await truncateAll(urls);
        stubSender.reset();
      }
    });
  });

  describe('"na so" confirms exactly what "yes" confirms (G-68)', () => {
    it.each([
      'na so',
      'Na So',
      'NA SO',
      'na so!',
      'na so 👍',
      'na so o',
      'e correct',
      'e correct o',
      'oya yes',
      'oya',
    ])('%j confirms the live preview, once', async (text) => {
      const business = await seedMerchant();
      await say('wamid.G68-affirm', A_SALE, 'sold Ada 3 wigs for 300k');
      const requestsAfterPreview = stubTransport.requests.length;
      const unitsAfterPreview = await aiActions(business.id);
      /* Positive control: the preview DID reach the model and DID spend a
       * unit, so the "unchanged" assertions below can fail. */
      expect(requestsAfterPreview).toBe(1);
      expect(unitsAfterPreview).toBe(1);

      await plain('wamid.G68-affirm-yes', text);
      expect(await written(business.id)).toMatchObject({ invoices: 1 });
      expect(await states(business.id)).toEqual(['confirmed']);
      /* The confirmation itself reached no model and spent no AI unit. */
      expect(stubTransport.requests.length).toBe(requestsAfterPreview);
      expect(await aiActions(business.id)).toBe(unitsAfterPreview);
      expect(await lastInboundBody(business.id)).toBe('[affirm]');
    });

    it('a qualified "na so" is a correction for the model, never a bare yes', async () => {
      const business = await seedMerchant();
      await say('wamid.G68-q', A_SALE, 'sold Ada 3 wigs for 300k');
      const requestsAfterPreview = stubTransport.requests.length;
      stubTransport.replyWith({ intent: 'Unclear', clarification: 'How much for each wig?' });
      await plain('wamid.G68-q-but', 'na so but change am to 40k');
      expect(stubTransport.requests.length).toBe(requestsAfterPreview + 1);
      expect((await written(business.id)).invoices).toBe(0);
    });
  });

  describe('Pidgin cannot bypass draft expiry (G-23)', () => {
    it.each(['yes', 'na so', 'oya'])(
      'an expired preview and %j: nothing executes, nothing is charged',
      async (text) => {
        const business = await seedMerchant();
        await say('wamid.G68-exp', A_SALE, 'sold Ada 3 wigs for 300k');
        const requestsAfterPreview = stubTransport.requests.length;
        const unitsAfterPreview = await aiActions(business.id);
        expect(unitsAfterPreview).toBe(1);
        await lapse(business.id);
        await plain('wamid.G68-exp-yes', text);
        expect(stubSender.lastText).toBe(EXPIRED);
        expect(stubTransport.requests.length).toBe(requestsAfterPreview);
        expect(await aiActions(business.id)).toBe(unitsAfterPreview);
        expect(await written(business.id)).toMatchObject({ invoices: 0, postings: 0 });
        expect(await states(business.id)).toEqual(['expired']);
      },
    );

    it.each(['no', 'no be so'])(
      'an expired preview and %j: no resurrection, and the older preview is untouched',
      async (text) => {
        const business = await seedMerchant();
        await say('wamid.G68-n1', A_SALE, 'sold Ada 3 wigs for 300k');
        await say('wamid.G68-n2', AN_EXPENSE, 'bought fuel 20k cash');
        await withBusiness(db, business.id, (tx) =>
          tx.execute(sql`
            UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
             WHERE business_id = ${business.id}::uuid AND intent = 'RecordExpense'`),
        );
        await plain('wamid.G68-n-no', text);
        expect(stubSender.lastText).toBe(replies.expiredNothingToCancel().text);
        expect(await states(business.id)).toEqual(['pending', 'expired']);
        expect(await written(business.id)).toMatchObject({ invoices: 0, expenses: 0 });
      },
    );
  });

  describe('a retired G-61 funding question is asked again, in any register', () => {
    it.each(['yes', 'na so', 'oya'])(
      '%j re-asks the POS question and records nothing',
      async (text) => {
        const business = await seedMerchant();
        await say(
          'wamid.G68-pos',
          A_POS_PURCHASE,
          'I bought 10 cartons for 180k from Emeka, paid by POS',
        );
        expect(stubSender.lastText).toContain(POS_QUESTION);
        expect(await states(business.id)).toEqual(['abandoned']);

        await plain('wamid.G68-pos-yes', text);
        expect(stubSender.lastText).toContain(POS_QUESTION);
        expect(await states(business.id)).toEqual(['abandoned']);
        expect(await written(business.id)).toMatchObject({ expenses: 0, postings: 0 });
      },
    );
  });

  describe('a retired G-61 funding question is closed by "no", in either register', () => {
    it.each(['no', 'no be so'])('%j closes the POS question for good', async (text) => {
      const business = await seedMerchant();
      await say(
        'wamid.G68-pos-no',
        A_POS_PURCHASE,
        'I bought 10 cartons for 180k from Emeka, paid by POS',
      );
      expect(stubSender.lastText).toContain(POS_QUESTION);

      await plain('wamid.G68-pos-no-no', text);
      expect(stubSender.lastText).toBe(replies.cancelled().text);
      await plain('wamid.G68-pos-no-yes', 'na so');
      expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
      expect(await states(business.id)).not.toContain('abandoned');
      expect(await written(business.id)).toMatchObject({ expenses: 0, postings: 0 });
    });
  });

  describe('deterministic Pidgin costs what deterministic English costs: nothing', () => {
    it('answers each twin identically, with no model call and no AI unit, routed locally', async () => {
      const business = await seedMerchant();
      const twins: ReadonlyArray<readonly [string, string]> = [
        ['how does this work', 'how e dey work'],
        ['who owes me', 'who dey owe me'],
        ['what is left', 'wetin remain'],
        ['send it again', 'send am again'],
        ['i want to upgrade', 'I wan upgrade'],
        ['show me my books', 'make I see my books'],
        ['forget it', 'forget am'],
      ];
      for (const [i, [english, pidgin]] of twins.entries()) {
        await plain(`wamid.G68-en-${i}`, english);
        const englishReply = stubSender.lastText;
        const englishBody = await lastInboundBody(business.id);
        await plain(`wamid.G68-pcm-${i}`, pidgin);
        /* Routed locally, both: stored as a classification, never tokenised. */
        expect(englishBody).toMatch(/^\[[a-z_]+\]$/);
        /* The dashboard link is minted per ask, so compare its shape. */
        if (englishBody === '[dashboard]') {
          expect(await lastInboundBody(business.id)).toBe('[dashboard]');
        } else {
          expect(stubSender.lastText).toBe(englishReply);
          expect(await lastInboundBody(business.id)).toBe(englishBody);
        }
      }
      expect(stubSender.sent).toHaveLength(twins.length * 2);
      expect(stubTransport.requests).toHaveLength(0);
      expect(await aiActions(business.id)).toBe(0);

      /* Positive control: one model-path message does reach the transport,
       * is tokenised, and spends a unit, so the zeros above can fail. */
      stubTransport.replyWith({ intent: 'Unclear', clarification: 'How many wigs?' });
      await plain('wamid.G68-control', 'Ada bought wigs');
      /* An unclear message may escalate, so at least one request, one unit. */
      expect(stubTransport.requests.length).toBeGreaterThan(0);
      expect(await aiActions(business.id)).toBe(1);
      expect(await lastInboundBody(business.id)).not.toMatch(/^\[[a-z_]+\]$/);
    });
  });

  describe('STOP and START change consent only when the message IS the command (G-24)', () => {
    it.each([
      'STOP',
      'stop',
      'stop!',
      'unsubscribe',
      'quit',
      'STOP,',
      'stop?',
      '"STOP"',
      'STOP 🙏🏾🙏🏾🙏🏾',
      '*STOP*',
      '🛑STOP🛑',
      'STOP STOP',
      'stop!!! stop!!!',
      'STOP/',
      'STOP#',
      'STOP 1\uFE0F\u20E3',
      'STOP \u2116',
    ])('%j opts the merchant out', async (text) => {
      await seedMerchant();
      await plain('wamid.G24-stop', text);
      expect(await identity.optedOutAt(db, PHONE)).not.toBeNull();
      expect(stubSender.lastText).toBe(replies.optedOut().text);
      expect(stubTransport.requests).toHaveLength(0);
    });

    it.each([
      'START',
      'start',
      'start!',
      'unstop',
      'subscribe',
      'START 🇳🇬',
      'START 👍',
      'start ✅🙏🏾',
    ])('%j opts the merchant back in', async (text) => {
      await seedMerchant();
      await identity.setOptOut(db, PHONE, new Date());
      await plain('wamid.G24-start', text);
      expect(await identity.optedOutAt(db, PHONE)).toBeNull();
      expect(stubTransport.requests).toHaveLength(0);
    });

    it.each([
      'start the generator',
      'start generator',
      'start recording another sale',
      '-----start-----',
      'start?',
      '"start"',
      'START ❓',
      'start 🛑',
      'start 👎',
      'START\v!',
      'START\f!',
      `${'-'.repeat(400)} start ${'-'.repeat(400)}`,
    ])('%j does not re-subscribe an opted-out merchant', async (text) => {
      await seedMerchant();
      const at = new Date('2026-09-30T08:00:00Z');
      await identity.setOptOut(db, PHONE, at);
      await plain('wamid.G24-not-start', text);
      expect(await identity.optedOutAt(db, PHONE)).toEqual(at);
    });

    it.each([
      'stop by my shop tomorrow',
      'stop by my shop',
      'please stop sending invoices to Ada',
      '-----stop-----',
      `${'-'.repeat(400)} unsubscribe ${'-'.repeat(400)}`,
      `stop${'-'.repeat(400)}`,
      `STOP${'!'.repeat(2000)}`,
    ])('%j does not opt a merchant out', async (text) => {
      await seedMerchant();
      await plain('wamid.G24-not-stop', text);
      expect(await identity.optedOutAt(db, PHONE)).toBeNull();
    });
  });

  /* G-80: a natural Nigerian opt-out is a typed STOP, from a closed list,
   * heard with no model and no AI action. */
  describe('a natural Nigerian opt-out is heard as STOP (G-80)', () => {
    it.each([
      'abeg stop',
      'no send me again',
      'stop abeg',
      'abeg stop am',
      'abeg no send me again',
      'please stop',
      'stop o',
      'stop na',
      'make una stop',
      'stop sending me messages',
    ])('%j opts the merchant out, exactly as STOP does', async (text) => {
      const business = await seedMerchant();
      await plain('wamid.G80-stop', text);
      expect(await identity.optedOutAt(db, PHONE)).not.toBeNull();
      // The opt-out reply is unchanged: the copy a typed STOP gets.
      expect(stubSender.lastText).toBe(replies.optedOut().text);
      expect(stubTransport.requests).toHaveLength(0);
      expect(await aiActions(business.id)).toBe(0);
      // Stored as what it was, not what it said, like any deterministic message.
      expect(await lastInboundBody(business.id)).toBe('[stop]');
    });

    it('a natural opt-out is honoured while a preview is waiting, and leaves it unconfirmed', async () => {
      const business = await seedMerchant();
      await say('wamid.G80-sale', A_SALE, 'Ada bought 3 wigs 300k');
      const requests = stubTransport.requests.length;
      await plain('wamid.G80-abeg', 'abeg stop');
      expect(await identity.optedOutAt(db, PHONE)).not.toBeNull();
      expect(stubTransport.requests).toHaveLength(requests);
      expect((await written(business.id)).invoices).toBe(0);
      expect(await states(business.id)).not.toContain('confirmed');
    });

    it.each([
      'stop by my shop',
      'stop payment on invoice INV-1',
      'I told him to stop',
      "don't stop sending receipts",
      'how do I stop an invoice?',
      'stop the sale',
      'abeg stop the sale',
      'stop am for Ada account',
      'no send Ada invoice again',
      'abeg send me again',
      'abeg stop?',
      `${'-'.repeat(400)} abeg stop ${'-'.repeat(400)}`,
      'abeg stop\nI will pay tomorrow',
      "don't send me again",
      'stop ehn',
      'abeg stop, I want to check something',
      'customer said abeg stop',
    ])('%j does not opt a merchant out', async (text) => {
      await seedMerchant();
      await plain('wamid.G80-not-stop', text);
      expect(await identity.optedOutAt(db, PHONE)).toBeNull();
    });

    it.each(['abeg start', 'please start', 'start o'])(
      '%j does not re-subscribe an opted-out merchant: START gains nothing',
      async (text) => {
        await seedMerchant();
        const at = new Date('2026-09-30T08:00:00Z');
        await identity.setOptOut(db, PHONE, at);
        await plain('wamid.G80-not-start', text);
        expect(await identity.optedOutAt(db, PHONE)).toEqual(at);
      },
    );
  });
});
