/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: Nigerian and Pidgin answers continue what was asked (G-68 Phase 2). Split
 * by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are in
 * meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  continuationsRepo,
  conversationsRepo,
  identity,
  usageRepo,
  withBusiness,
  sql,
} from '@rekoda/db';
import { replies, usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { issueRepo } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  photoPayload,
  post,
  stubOcr,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

/**
 * G-68 Phase 2: Nigerian and Pidgin answers through Build 6's typed
 * continuation state, and nothing else. A short reply continues only what
 * Rekoda asked THIS member, while it is open, and only with the kind of
 * answer the stored question expects. No fuzzy memory: with nothing
 * compatible open, the reply is understood exactly as it would have been.
 */
describe('Nigerian and Pidgin answers continue what was asked (G-68 Phase 2)', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const WHICH_PERIOD = replies.whichPeriod('sales').text;
  const STRAY = replies.strayNumber().text;
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

  /** A message the model would read as unclear, if it ever reached it. */
  async function reply(wamid: string, text: string, from = OWNER) {
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  const modelCalls = () => stubTransport.requests.length;

  async function aiActions(businessId: string): Promise<number> {
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    return rows.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0;
  }

  async function continuations(businessId: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ kind: string; expects: string | null; state: string; draft_id: string | null }>(
        sql`
        SELECT kind, expects, state, draft_id FROM conversation_continuations
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`,
      ),
    );
    return [...rows];
  }

  async function draftStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string; intent: string }>(sql`
        SELECT state, intent FROM command_drafts WHERE business_id = ${businessId}::uuid
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => `${r.intent}:${r.state}`);
  }

  const purchaseStates = async (businessId: string) =>
    (await draftStates(businessId)).filter((d) => d.startsWith('RecordPurchase'));

  async function written(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*)::int FROM inventory_movements WHERE business_id = ${businessId}::uuid) AS arrivals
        `),
      )),
    ];
    return row!;
  }

  /** Net movement per account code, from the ledger. */
  async function nets(businessId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    for (const e of entries) out[e.account] = (out[e.account] ?? 0) + e.debitK - e.creditK;
    return out;
  }

  async function lastInboundBody(businessId: string): Promise<string | null> {
    const messages = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesFor(tx, businessId),
    );
    const inbound = messages.filter((m) => m.direction === 'inbound');
    return inbound[inbound.length - 1]?.body ?? null;
  }

  /**
   * G-80: a natural opt-out while something is waiting takes EXACTLY the
   * typed STOP's path. Two merchants, one sends STOP and the other a natural
   * form, and everything they leave behind must match: never an answer to
   * the open question, never a yes to the preview, no model, no AI action.
   */
  describe('a natural opt-out while something is waiting is a typed STOP (G-80)', () => {
    const TYPED = '2348039990011';
    const NATURAL = '2348039990012';

    async function aftermath(businessId: string, phone: string) {
      return {
        optedOut: (await identity.optedOutAt(db, `+${phone}`)) !== null,
        drafts: await draftStates(businessId),
        continuations: (await continuations(businessId)).map((c) => `${c.kind}:${c.state}`),
        written: await written(businessId),
        aiActions: await aiActions(businessId),
      };
    }

    it.each(['abeg stop', 'no send me again', 'stop o', 'abeg stop am'])(
      'with a purchase preview waiting, %j does what STOP does and confirms nothing',
      async (text) => {
        const cash = { ...POS_PURCHASE, paymentMethod: 'cash' };
        const typed = await seedMerchant(`+${TYPED}`);
        const natural = await seedMerchant(`+${NATURAL}`);
        await say('wamid.G80-p-typed', cash, 'bought 10 cartons 180k cash', TYPED);
        await say('wamid.G80-p-natural', cash, 'bought 10 cartons 180k cash', NATURAL);
        await reply('wamid.G80-p-typed-stop', 'STOP', TYPED);
        expect(stubSender.lastText).toBe(replies.optedOut().text);
        await reply('wamid.G80-p-natural-stop', text, NATURAL);
        expect(stubSender.lastText).toBe(replies.optedOut().text);

        /* `reply` resets the stub's request log: the natural reply made none. */
        expect(modelCalls()).toBe(0);
        const a = await aftermath(typed.id, TYPED);
        const b = await aftermath(natural.id, NATURAL);
        expect(b).toEqual(a);
        expect(b.optedOut).toBe(true);
        expect(b.drafts.some((d) => d.endsWith(':confirmed'))).toBe(false);
        expect(b.written.purchases).toBe(0);
      },
    );

    it.each(['abeg stop', 'stop abeg'])(
      'with "Which period?" open, %j does what STOP does and is not taken as an answer',
      async (text) => {
        const typed = await seedMerchant(`+${TYPED}`);
        const natural = await seedMerchant(`+${NATURAL}`);
        await say('wamid.G80-q-typed', HOW_MUCH_DID_I_SELL, 'How much did I sell?', TYPED);
        expect(stubSender.lastText).toBe(WHICH_PERIOD);
        await say('wamid.G80-q-natural', HOW_MUCH_DID_I_SELL, 'How much did I sell?', NATURAL);
        expect(stubSender.lastText).toBe(WHICH_PERIOD);
        await reply('wamid.G80-q-typed-stop', 'STOP', TYPED);
        await reply('wamid.G80-q-natural-stop', text, NATURAL);
        expect(stubSender.lastText).toBe(replies.optedOut().text);

        /* `reply` resets the stub's request log: the natural reply made none. */
        expect(modelCalls()).toBe(0);
        const b = await aftermath(natural.id, NATURAL);
        expect(b).toEqual(await aftermath(typed.id, TYPED));
        expect(b.optedOut).toBe(true);
      },
    );

    it('with the funding question open, "abeg stop" does what STOP does and rebuilds nothing', async () => {
      const typed = await seedMerchant(`+${TYPED}`);
      const natural = await seedMerchant(`+${NATURAL}`);
      await say('wamid.G80-f-typed', POS_PURCHASE, 'bought 10 cartons 180k POS', TYPED);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await say('wamid.G80-f-natural', POS_PURCHASE, 'bought 10 cartons 180k POS', NATURAL);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await reply('wamid.G80-f-typed-stop', 'STOP', TYPED);
      await reply('wamid.G80-f-natural-stop', 'abeg stop', NATURAL);
      expect(stubSender.lastText).toBe(replies.optedOut().text);

      /* `reply` resets the stub's request log: the natural reply made none. */
      expect(modelCalls()).toBe(0);
      const b = await aftermath(natural.id, NATURAL);
      expect(b).toEqual(await aftermath(typed.id, TYPED));
      expect(b.optedOut).toBe(true);
      expect(b.written.purchases).toBe(0);
    });
  });

  describe('A. a period answer resumes "Which period?", in either register', () => {
    it.each([
      'last month o',
      'na last month',
      'dis month',
      'this month so far',
      'the month wey pass',
    ])('%j answers the open question with no model', async (text) => {
      const business = await seedMerchant();
      await say('wamid.P2-a-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      expect(stubSender.lastText).toBe(WHICH_PERIOD);

      await reply('wamid.P2-a-answer', text);
      expect(stubSender.lastText).toMatch(/invoiced|any sales/);
      expect(modelCalls()).toBe(0);
      expect((await continuations(business.id)).map((c) => `${c.kind}:${c.state}`)).toEqual([
        'clarification:consumed',
        'query:open',
      ]);
    });

    it('"last month" with nothing compatible open attaches to nothing', async () => {
      await seedMerchant();
      await reply('wamid.P2-a-none', 'last month o');
      expect(modelCalls()).toBeGreaterThan(0);
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
    });

    it('"today today" is an urgency idiom, never a window', async () => {
      const business = await seedMerchant();
      await say('wamid.P2-a-tt-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.P2-a-tt', 'today today');
      expect(modelCalls()).toBeGreaterThan(0);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    });

    it('a window Rekoda cannot count keeps "Which period?" open, and the next answer resumes it', async () => {
      const business = await seedMerchant();
      await say('wamid.P2-a-y-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');

      await reply('wamid.P2-a-y', 'yesterday o');
      expect(stubSender.lastText).toBe(replies.periodNotCountable('sales').text);
      expect(modelCalls()).toBe(0);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['open']);

      await reply('wamid.P2-a-y-2', 'dis month');
      expect(stubSender.lastText).toMatch(/invoiced|any sales/);
      expect(modelCalls()).toBe(0);
    });

    it('a new command after the question routes normally, and the question is gone', async () => {
      const business = await seedMerchant();
      await say('wamid.P2-a-n-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.P2-a-n', 'wetin remain');
      expect(stubSender.lastText).toContain('You are not counting any stock yet');
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    });
  });

  describe('B. "2" means option 2 only of an open list shown to this member', () => {
    async function openList(businessId: string, phone = `+${OWNER}`, now?: Date) {
      const user = await identity.upsertUserByPhone(db, phone);
      return withBusiness(db, businessId, async (tx) => {
        const thread = await conversationsRepo.recordInbound(
          tx,
          {
            businessId,
            channel: 'meta',
            kind: 'text',
            body: '[list]',
            providerMessageId: `wamid.list-${phone}-${String(now?.getTime() ?? 0)}`,
          },
          { kind: 'MERCHANT', businessId, channel: 'meta' },
        );
        return continuationsRepo.openContinuation(tx, {
          businessId,
          userId: user.id,
          sourceMessageId: thread.id,
          state: {
            kind: 'clarification',
            expects: 'choice',
            topic: 'debtors',
            options: [
              { ordinal: 1, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000001' } },
              { ordinal: 2, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000002' } },
            ],
          },
          ...(now ? { now } : {}),
        });
      });
    }

    it('names option 2 and CONSUMES the list (never merely superseded)', async () => {
      const business = await seedMerchant();
      await openList(business.id);
      await reply('wamid.P2-b-2', '2');
      expect(stubSender.lastText).toBe(replies.optionChosen('INV-2026-000002').text);
      expect(modelCalls()).toBe(0);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['consumed']);
    });

    it('a number the list did not show is stray, and retires the list', async () => {
      const business = await seedMerchant();
      await openList(business.id);
      await reply('wamid.P2-b-7', '7');
      expect(stubSender.lastText).toBe(STRAY);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    });

    it('another member\'s "2" is stray, and the list stays the owner\'s', async () => {
      const business = await seedMerchant();
      const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      await openList(business.id);
      await reply('wamid.P2-b-d', '2', DELEGATE);
      expect(stubSender.lastText).toBe(STRAY);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['open']);
    });

    it('an expired list is gone: "2" is stray', async () => {
      const business = await seedMerchant();
      await openList(business.id, `+${OWNER}`, new Date(Date.now() - 3_600_000));
      await reply('wamid.P2-b-e', '2');
      expect(stubSender.lastText).toBe(STRAY);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['expired']);
    });

    it('"2" while a period is expected is stray (Build 6, unchanged)', async () => {
      const business = await seedMerchant();
      await say('wamid.P2-b-p-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.P2-b-p', '2');
      expect(stubSender.lastText).toBe(STRAY);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    });
  });

  describe('E. the G-61 funding question answered with a short "bank" or "cash"', () => {
    async function askFunding(businessId: string) {
      await say(
        'wamid.P2-e-ask',
        POS_PURCHASE,
        'I bought stock and paid with POS: 10 cartons for 180k from Emeka',
      );
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(await purchaseStates(businessId)).toEqual(['RecordPurchase:abandoned']);
      const [open] = await continuations(businessId);
      expect(open).toMatchObject({
        kind: 'clarification',
        expects: 'funding_source',
        state: 'open',
      });
      expect(open!.draft_id).not.toBeNull();
    }

    /* G-78: "cash" or "bank" read off a photograph is not the merchant's
     * answer. The photograph never rebuilds the purchase and, as a new thing
     * they sent, retires the open question. */
    it('a photograph reading "bank" does not answer the open question (G-78)', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);

      stubSender.media.set('photo-1', {
        bytes: Buffer.from('JFIF-fake-photo'),
        mimeType: 'image/jpeg',
      });
      stubOcr.answerWith({ text: 'bank', confidence: 0.99 });
      stubTransport.replyWith({ intent: 'Unclear' });
      await post(photoPayload(OWNER, 'wamid.G78.F2'));
      await drain();

      expect(stubSender.lastText).not.toContain('Paid in full by transfer');
      expect(await written(business.id)).toEqual({ purchases: 0, postings: 0, arrivals: 0 });
      expect((await continuations(business.id)).map((c) => c.state)).not.toContain('open');
    });

    it.each([
      ['bank', 'transfer', 'BANK'],
      ['na bank o', 'transfer', 'BANK'],
      ['from my bank account', 'transfer', 'BANK'],
      ['cash', 'cash', 'CASH'],
      ['na cash', 'cash', 'CASH'],
    ])(
      '%j shows a FRESH preview by %s, writes nothing, and only the next yes records it',
      async (answer, method, account) => {
        const business = await seedMerchant();
        await askFunding(business.id);
        const unitsAfterQuestion = await aiActions(business.id);
        expect(unitsAfterQuestion).toBe(1);

        await reply('wamid.P2-e-answer', answer);
        expect(stubSender.lastText).toContain('Please check this before I save it');
        expect(stubSender.lastText).toContain(`Paid in full by ${method}`);
        /* No model, no unit, nothing written: only a fresh draft to confirm. */
        expect(modelCalls()).toBe(0);
        expect(await aiActions(business.id)).toBe(unitsAfterQuestion);
        expect(await written(business.id)).toEqual({ purchases: 0, postings: 0, arrivals: 0 });
        /* The question is answered ONCE: closed by its rebuild. */
        expect(await draftStates(business.id)).toEqual([
          'RecordPurchase:superseded',
          'RecordPurchase:pending',
        ]);
        expect((await continuations(business.id)).map((c) => c.state)).toEqual(['consumed']);

        /* The normal yes, in either register, records the REBUILT purchase once. */
        await reply('wamid.P2-e-yes', 'na so');
        await reply('wamid.P2-e-yes-2', 'yes');
        expect((await written(business.id)).purchases).toBe(1);
        expect(await draftStates(business.id)).toEqual([
          'RecordPurchase:superseded',
          'RecordPurchase:confirmed',
        ]);
        expect(await nets(business.id)).toEqual({ INVENTORY: 18_000_000, [account]: -18_000_000 });
      },
    );

    it.each(['yes', 'na so', 'oya'])(
      '%j to the question alone re-asks it, and the short answer still works after',
      async (text) => {
        const business = await seedMerchant();
        await askFunding(business.id);
        await reply('wamid.P2-e-y', text);
        expect(stubSender.lastText).toContain(POS_QUESTION);
        expect(await written(business.id)).toEqual({ purchases: 0, postings: 0, arrivals: 0 });
        expect((await continuations(business.id)).map((c) => c.state)).toEqual(['open']);

        await reply('wamid.P2-e-y-cash', 'cash');
        expect(stubSender.lastText).toContain('Paid in full by cash');
      },
    );

    it('POS is a channel, never an answer', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await reply('wamid.P2-e-pos', 'pos');
      expect(modelCalls()).toBeGreaterThan(0);
      expect(await purchaseStates(business.id)).toEqual(['RecordPurchase:abandoned']);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    });

    it('an expired question is gone: "bank" goes to the model and records nothing', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '1 second'
           WHERE business_id = ${business.id}::uuid`),
      );
      await reply('wamid.P2-e-late', 'bank');
      expect(modelCalls()).toBeGreaterThan(0);
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
      expect(await purchaseStates(business.id)).toEqual(['RecordPurchase:abandoned']);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['expired']);
    });

    it('another member\'s "bank" does not answer the owner\'s question', async () => {
      const business = await seedMerchant();
      const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      await askFunding(business.id);

      await reply('wamid.P2-e-d', 'bank', DELEGATE);
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
      expect(await purchaseStates(business.id)).toEqual(['RecordPurchase:abandoned']);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['open']);
    });

    it('the wrong kind of answer retires the question; a later "bank" answers nothing', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await reply('wamid.P2-e-w', 'last month');
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
      await reply('wamid.P2-e-w-bank', 'bank');
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
      expect(await purchaseStates(business.id)).toEqual(['RecordPurchase:abandoned']);
    });

    it('"no be so" closes the question, and a "bank" after it answers nothing', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await reply('wamid.P2-e-no', 'no be so');
      expect(stubSender.lastText).toBe(replies.cancelled().text);
      await reply('wamid.P2-e-no-bank', 'bank');
      /* Told the question was closed, with no model call (G-68 review). */
      expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
      expect(await written(business.id)).toEqual({ purchases: 0, postings: 0, arrivals: 0 });
    });

    it('the short answer is stored like any model-path text: tokenised, never a name', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await reply('wamid.P2-e-body', 'na bank');
      expect(await lastInboundBody(business.id)).toBe('na bank');
    });
  });
});
