/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: G-68 final review 3 and the Codex review. Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { identity, withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { billingRepo, customersRepo } from '@rekoda/db';
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
 * G-68 final-head review 3: a resend closes the question for everyone, the
 * funding continuation lives exactly as long as its answer window, and any
 * message (media included) between the erasure asks keeps the data.
 */
describe('G-68 final review 3: resend closes the question, window-long answer, media between asks', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
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

  async function purchases(businessId: string): Promise<number> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM expenses WHERE business_id = ${businessId}::uuid`),
    );
    return [...rows][0]!.n;
  }

  it('the owner resends the purchase while the delegate holds a short answer: booked ONCE', async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');

    await say('wamid.R3-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await reply('wamid.R3-d-yes', 'yes', DELEGATE);
    await say(
      'wamid.R3-resend',
      { ...POS_PURCHASE, paymentMethod: 'transfer' },
      'I bought 10 cartons for 180k, paid by POS from my bank account',
    );
    expect(stubSender.lastText).toContain('Paid in full by transfer');
    await reply('wamid.R3-o-yes', 'yes');
    expect(await purchases(business.id)).toBe(1);

    await reply('wamid.R3-d-cash', 'cash', DELEGATE);
    expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
    await reply('wamid.R3-yes-2', 'yes', DELEGATE);
    await reply('wamid.R3-yes-3', 'yes');
    expect(await purchases(business.id)).toBe(1);
  });

  const shift = (businessId: string, minutes: number) =>
    withBusiness(db, businessId, async (tx) => {
      await tx.execute(sql`
        UPDATE command_drafts SET created_at = created_at - make_interval(mins => ${minutes})
         WHERE business_id = ${businessId}::uuid AND state = 'abandoned'`);
      await tx.execute(sql`
        UPDATE conversation_continuations
           SET created_at = created_at - make_interval(mins => ${minutes}),
               expires_at = expires_at - make_interval(mins => ${minutes})
         WHERE business_id = ${businessId}::uuid`);
    });

  it('"bank" at minute 11, with no re-ask, still rebuilds: the offer lasts the whole window', async () => {
    const business = await seedMerchant();
    await say('wamid.W-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await shift(business.id, 11);
    await reply('wamid.W-bank', 'bank');
    expect(stubSender.lastText).toContain('Paid in full by transfer');
  });

  it('"bank" at minute 31, with no re-ask, rebuilds nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.W2-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await shift(business.id, 31);
    await reply('wamid.W2-bank', 'bank');
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
    expect(await purchases(business.id)).toBe(0);
  });

  it('a photo between the two erasure asks breaks the pair: nothing is erased', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g68-media' }],
    );
    await reply('wamid.M-del1', 'delete my data');
    await post({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'PNID' },
                messages: [{ id: 'wamid.M-photo', from: OWNER, timestamp: '1', type: 'image' }],
              },
            },
          ],
        },
      ],
    });
    await drain();
    await reply('wamid.M-del2', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    const facets = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(facets).toHaveLength(1);
  });
});

/**
 * Codex review of #259 (and a fresh final-head reviewer): durable erasure
 * pairing, negating emoji, a rebuild nobody saw, gates before the claim, the
 * newest continuation as of the message, and an honest "already waiting".
 */
describe('G-68 Codex review: erasure events, emoji, failed rebuild send, gates, waiting preview', () => {
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

  async function count(businessId: string, table: 'invoices' | 'expenses'): Promise<number> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE business_id = ${businessId}::uuid`,
      ),
    );
    return [...rows][0]!.n;
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

  it('P1: a message whose processing FAILED between the erasure asks still breaks the pair', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g68-fail' }],
    );
    await reply('wamid.CX-del1', 'delete my data');
    /* The tokeniser fails before the message row is written: the job fails. */
    const spy = vi
      .spyOn(deps.gateway, 'tokenise')
      .mockRejectedValueOnce(new Error('vault unavailable'));
    try {
      await reply('wamid.CX-between', 'Ada bought 3 wigs for 150k');
    } finally {
      spy.mockRestore();
    }
    await reply('wamid.CX-del2', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    const facets = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(facets).toHaveLength(1);
  });

  it('P2: a message that arrived AFTER the second erasure ask does not break the pair (Codex review)', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T8',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g68-after' }],
    );
    await reply('wamid.CX-a-del1', 'delete my data');
    /* The second ask and a later message are both ingested before either
     * job runs: the later one was not said between the two asks. */
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(OWNER, 'wamid.CX-a-del2', 'delete my data'));
    await post(messagePayload(OWNER, 'wamid.CX-a-after', 'Ada bought 3 wigs for 150k'));
    await drain();
    const facets = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(facets).toHaveLength(0);
  });

  it.each([
    'na so ❌',
    'e correct 👎',
    'oya 🚫',
    'yes ⛔',
    'yes 🛑',
    'yes 🙅🏾',
    'na so ❎',
    'yes ✖️',
    'yes 😂',
  ])('P1: %j to a live preview writes nothing', async (text) => {
    const business = await seedMerchant();
    await say('wamid.CX-e-sale', A_SALE, 'sold Ada 3 wigs for 45k');
    await reply('wamid.CX-e', text);
    expect(stubSender.lastText).toBe(replies.plainYesNeeded().text);
    expect(await count(business.id, 'invoices')).toBe(0);
  });

  it.each(['yes 👍', 'na so 😊', 'e correct ✅'])('%j still confirms', async (text) => {
    const business = await seedMerchant();
    await say('wamid.CX-p-sale', A_SALE, 'sold Ada 3 wigs for 45k');
    await reply('wamid.CX-p', text);
    expect(await count(business.id, 'invoices')).toBe(1);
  });

  it('P2: a rebuilt preview that was never delivered is undone, and "cash" again works once', async () => {
    const business = await seedMerchant();
    await say('wamid.CX-f-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    stubSender.failWith();
    await reply('wamid.CX-f-cash', 'cash');
    /* Nothing the merchant saw: the rebuild is undone, the question restored. */
    expect(await purchaseStates(business.id)).toEqual(['abandoned', 'superseded']);
    /* A yes now confirms nothing: the preview nobody saw is not confirmable.
     * It finds the QUESTION again and re-asks it (the undone rebuild is never
     * the latest thing to answer). */
    await reply('wamid.CX-f-yes-early', 'yes');
    expect(stubSender.lastText).toContain(POS_QUESTION);
    expect(await count(business.id, 'expenses')).toBe(0);
    expect(await purchaseStates(business.id)).toEqual(['abandoned', 'superseded']);

    await reply('wamid.CX-f-cash-2', 'cash');
    expect(stubSender.lastText).toContain('Paid in full by cash');
    await reply('wamid.CX-f-yes', 'yes');
    await reply('wamid.CX-f-yes-2', 'yes');
    expect(await count(business.id, 'expenses')).toBe(1);
  });

  it('after an undone rebuild, "no" finds the question again and closes it', async () => {
    const business = await seedMerchant();
    await say('wamid.CX-fn-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    stubSender.failWith();
    await reply('wamid.CX-fn-cash', 'cash');
    expect(await purchaseStates(business.id)).toEqual(['abandoned', 'superseded']);
    await reply('wamid.CX-fn-no', 'no');
    expect(stubSender.lastText).toContain('Cancelled');
    expect(await purchaseStates(business.id)).toEqual(['superseded', 'superseded']);
    /* Closed for good: a later "cash" rebuilds nothing. */
    await reply('wamid.CX-fn-cash-2', 'cash');
    expect(stubSender.lastText).not.toContain('Paid in full by cash');
    expect(await count(business.id, 'expenses')).toBe(0);
  });

  it('P2: a gate refusal does not use up the answer; after access returns, "cash" rebuilds', async () => {
    const business = await seedMerchant();
    await say('wamid.CX-g-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });
    await reply('wamid.CX-g-refused', 'cash');
    expect(stubSender.lastText).toBe(replies.chatNotInPlan().text);
    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan: 'trial',
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      actor: 'operator:test',
    });
    await reply('wamid.CX-g-cash', 'cash');
    expect(stubSender.lastText).toContain('Paid in full by cash');
  });

  it('an EXPIRED rebuilt preview is never reported as waiting', async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    await say('wamid.CX-x-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await reply('wamid.CX-x-d-yes', 'yes', DELEGATE);
    await reply('wamid.CX-x-bank', 'bank');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
    );
    await reply('wamid.CX-x-cash', 'cash', DELEGATE);
    expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
  });

  it('a preview a yes cannot reach (a newer retired question) is never reported as waiting', async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    await say('wamid.CX-u-sale', A_SALE, 'sold Ada 3 wigs for 45k');
    await say('wamid.CX-u-r1', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS', DELEGATE);
    await say('wamid.CX-u-r2', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    /* The owner's sale preview, pending again behind both retired questions. */
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET state = 'pending'
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'`),
    );
    await reply('wamid.CX-u-cash', 'cash', DELEGATE);
    expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
  });

  /* Codex review, second round. */
  it.each(['cash ❌', 'bank 👎', 'cash 🚫'])(
    'P2: %j to the funding question rebuilds nothing and keeps it open',
    async (text) => {
      const business = await seedMerchant();
      await say('wamid.CX2-e-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.CX2-e', text);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      /* Still open: a plain answer now rebuilds it. */
      await reply('wamid.CX2-e-cash', 'cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
    },
  );

  /* G-85: a funding answer with a mark drawn over it names no account. */
  it.each(['cash⃘', 'bank͓', 'bankͯ', 'na cash⃚', 'transfer̀'])(
    'G-85: a marked %j to the funding question rebuilds nothing and keeps it open',
    async (text) => {
      const business = await seedMerchant();
      await say('wamid.G85-f-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.G85-f', text);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      /* `reply` resets the transport log: none since means no model. */
      expect(stubTransport.requests).toHaveLength(0);
      /* Still open: a plain answer now rebuilds it. */
      await reply('wamid.G85-f-cash', 'cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
    },
  );

  it('P2: an undone rebuild re-opens EVERY member’s answer it retired; the other member’s "cash" rebuilds once', async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    await say('wamid.CX2-m-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    /* The delegate is asked too, and so holds the question as well. */
    await reply('wamid.CX2-m-d-yes', 'yes', DELEGATE);
    expect(stubSender.lastText).toContain(POS_QUESTION);
    stubSender.failWith();
    await reply('wamid.CX2-m-cash', 'cash');
    expect(await purchaseStates(business.id)).toEqual(['abandoned', 'superseded']);

    await reply('wamid.CX2-m-d-cash', 'cash', DELEGATE);
    expect(stubSender.lastText).toContain('Paid in full by cash');
    await reply('wamid.CX2-m-d-ok', 'yes', DELEGATE);
    await reply('wamid.CX2-m-d-ok2', 'yes', DELEGATE);
    expect(await count(business.id, 'expenses')).toBe(1);
  });

  it('P2: a newer question, answered and its preview cancelled, never revives an older one', async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    /* Q1, held by the delegate. */
    await say(
      'wamid.CX2-n-q1',
      POS_PURCHASE,
      'I bought 10 cartons for 180k, paid by POS',
      DELEGATE,
    );
    /* Q2 from the owner, answered into a preview, then cancelled. */
    await say('wamid.CX2-n-q2', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await reply('wamid.CX2-n-cash', 'cash');
    expect(stubSender.lastText).toContain('Paid in full by cash');
    await reply('wamid.CX2-n-no', 'no');

    const before = await purchaseStates(business.id);
    await reply('wamid.CX2-n-d-cash', 'cash', DELEGATE);
    expect(stubSender.lastText).not.toContain('Paid in full by cash');
    expect(await purchaseStates(business.id)).toEqual(before);
    await reply('wamid.CX2-n-d-yes', 'yes', DELEGATE);
    expect(await count(business.id, 'expenses')).toBe(0);
  });
});
