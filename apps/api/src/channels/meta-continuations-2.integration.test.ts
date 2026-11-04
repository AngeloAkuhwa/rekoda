/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a short reply continues what Rekoda just asked (Build 6) (part 2 of 2).
 * Split by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are
 * in meta-webhook.fixtures.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { createDb, withBusiness, sql } from '@rekoda/db';
import { replies, resolvePeriod } from '@rekoda/core';
import { customersRepo, issueRepo, settleRepo } from '@rekoda/db';
import {
  db,
  messagePayload,
  post,
  stubOcr,
  stubSender,
  stubStt,
  stubTransport,
  urls,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import {
  OWNER,
  DELEGATE,
  WHICH_PERIOD,
  NOT_COUNTABLE,
  HOW_MUCH_DID_I_SELL,
  UNCLEAR,
  POS_PURCHASE,
  A_SALE,
  seedMerchant,
  drain,
  say,
  reply,
  modelCalls,
  continuations,
  footprint,
  draftStates,
  BEHIND,
  THIS_MONTH,
  addDelegate,
  mediaMessage,
} from './meta-continuations.fixtures.js';

useMetaWebhookHarness();

/**
 * Conversational continuation (Build 6): a short reply attaches to the
 * question Rekoda just asked THAT person, or continues the read it just
 * answered them, and nothing else.
 *
 *     "How much did I sell?" -> "Which period?" -> "Last month."
 *
 * What resumes is always a read, answered from SQL with no model. A reply
 * that does not fit is understood exactly as it would have been without the
 * question, and the question is gone. Nothing here reaches a draft: the
 * financial confirmation path (G-23) and the retired purchase question
 * (G-61) behave exactly as before.
 */
describe('a short reply continues what Rekoda just asked (Build 6)', () => {
  /**
   * One sale of ₦150,000 last month (₦60,000 paid), one of ₦40,000 this month.
   *
   * Kept identical to the copy in meta-continuations-1.integration.test.ts. It calls repository
   * financial writers, which scripts/check-boundaries.mjs allows only in the command layer
   * and in test files, so it cannot move to a shared fixture module. Change both together.
   */
  async function seedTwoMonths(businessId: string) {
    const lastMonth = resolvePeriod('last_month', new Date());
    const inLastMonth = new Date(lastMonth.from.getTime() + 2 * 86_400_000).toISOString();
    await withBusiness(db, businessId, async (tx) => {
      const old = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'b6-old',
        actor: 'system',
      });
      await settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: old.invoiceId,
        amountK: 6_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'b6-old-pay',
        actor: 'system',
      });
      await tx.execute(sql`
        UPDATE invoices SET created_at = ${inLastMonth}::timestamptz
         WHERE business_id = ${businessId}::uuid AND id = ${old.invoiceId}::uuid`);
      await tx.execute(sql`
        UPDATE payments SET created_at = ${inLastMonth}::timestamptz
         WHERE business_id = ${businessId}::uuid`);
      await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'bag', quantity: 1, unitPriceK: 4_000_000 }],
        subtotalK: 4_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 4_000_000,
        paidK: 0,
        balanceDueK: 4_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'b6-new',
        actor: 'system',
      });
    });
    /* The answers read the ledger (G-118), so last month's sale and payment
     * are back-dated THERE too, as the owner with the append-only guards
     * suspended: a fixture, never a product path. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`SET session_replication_role = replica`);
      await ownerDb.execute(sql`
        UPDATE ledger_entries SET created_at = ${inLastMonth}::timestamptz
         WHERE business_id = ${businessId}::uuid
           AND transaction_id IN (SELECT id FROM ledger_transactions
                                   WHERE business_id = ${businessId}::uuid
                                     AND source_id IN ('b6-old', 'b6-old-pay'))`);
      await ownerDb.execute(sql`
        UPDATE ledger_transactions SET created_at = ${inLastMonth}::timestamptz
         WHERE business_id = ${businessId}::uuid AND source_id IN ('b6-old', 'b6-old-pay')`);
      await ownerDb.execute(sql`SET session_replication_role = origin`);
    } finally {
      await close();
    }
    return {
      lastMonthLabel: lastMonth.label,
      thisMonthLabel: resolvePeriod('month', new Date()).label,
    };
  }

  it('a G-61 retired purchase question stays retired, and "bank" never records the purchase', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-g61-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await say('wamid.B6-g61-pos', POS_PURCHASE, 'I bought 10 cartons for 100k, paid by POS');
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    expect(await draftStates(business.id)).toEqual([
      'Query:superseded',
      'RecordPurchase:abandoned',
    ]);
    /* The period question did not survive the purchase; the funding
     * question it asked is now the open one (G-68 Phase 2). */
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded', 'open']);

    /* A yes still asks the retired question again (G-61), unchanged. */
    await reply('wamid.B6-g61-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    expect((await draftStates(business.id))[1]).toBe('RecordPurchase:abandoned');

    /* "bank" answers the open funding question (G-68 Phase 2, the work
     * Build 6 left for it): a FRESH preview of the rebuilt purchase, no
     * model, and never the old purchase executed. Nothing is written
     * until a normal yes. */
    await reply('wamid.B6-g61-bank', 'bank');
    expect(modelCalls()).toBe(0);
    expect(stubSender.lastText).toContain('Paid in full by transfer');
    expect(await footprint(business.id)).toMatchObject({ expenses: 0, postings: 0 });
    /* Answered once: the retired question is closed by its rebuild. */
    expect((await draftStates(business.id))[1]).toBe('RecordPurchase:superseded');
    expect((await draftStates(business.id))[2]).toBe('RecordPurchase:pending');
  });

  it('a question between the two erasure asks breaks the pair: nothing is erased', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-b6-erase' }],
    );
    const facets = () =>
      withBusiness(db, business.id, (tx) =>
        customersRepo.identityFacetsFor(tx, business.id, customer.id),
      );

    await reply('wamid.B6-del1', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

    /* Anything in between keeps the data, a question to the books included. */
    await say('wamid.B6-del-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    /* Inside the window, but no longer the second of a pair: a new first ask. */
    await reply('wamid.B6-del2', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    expect(await facets()).toHaveLength(1);
  });

  it('a correction after only a question is a new request, not a correction', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-corr-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await say('wamid.B6-corr-sale', A_SALE, 'sorry, 3 wigs not 4');

    expect(stubSender.lastText).not.toContain(replies.correctionTaken().text);
    /* The question's draft was not superseded as if it had been corrected. */
    expect(await draftStates(business.id)).toEqual(['Query:pending', 'RecordSale:pending']);
  });

  it("a member's resumed read stands between a preview and a later yes, like any question", async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);

    await say('wamid.B6-x-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?', OWNER);
    expect(stubSender.lastText).toBe(WHICH_PERIOD);
    await say('wamid.B6-x-sale', A_SALE, 'sold Ada 3 wigs for 300k', DELEGATE);
    /* The owner's "last month" resumes the owner's question, answered from
     * SQL, with the delegate's preview older than it. */
    await reply('wamid.B6-x-answer', 'last month', OWNER);
    expect(stubSender.lastText).toContain('sales');
    expect(modelCalls()).toBe(0);

    /* "correct" is about the figure just read, never the older preview. */
    await reply('wamid.B6-x-correct', 'correct', OWNER);
    expect(stubSender.lastText).toBe(BEHIND);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    expect((await draftStates(business.id))[1]).toBe('RecordSale:pending');
  });

  it("a member's resumed read between the two erasure asks breaks the pair: nothing is erased", async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T8',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-b6-erase-x' }],
    );
    const facets = () =>
      withBusiness(db, business.id, (tx) =>
        customersRepo.identityFacetsFor(tx, business.id, customer.id),
      );

    await say('wamid.B6-xd-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?', DELEGATE);
    expect(stubSender.lastText).toBe(WHICH_PERIOD);
    await reply('wamid.B6-xd-del1', 'delete my data', OWNER);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

    await reply('wamid.B6-xd-answer', 'last month', DELEGATE);
    expect(stubSender.lastText).toContain('sales');
    expect(modelCalls()).toBe(0);

    await reply('wamid.B6-xd-del2', 'delete my data', OWNER);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    expect(await facets()).toHaveLength(1);
  });

  it('a junk photo after "Which period?" retires the question', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-j-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    stubSender.media.set('photo-1', {
      bytes: Buffer.from('JFIF-fake-photo'),
      mimeType: 'image/jpeg',
    });
    stubOcr.answerWith({ text: 'when the beat drops and nobody is ready', confidence: 0.9 });
    stubTransport.script({
      toolInput: { type: 'junk' },
      usage: { inputTokens: 400, outputTokens: 12 },
      stopReason: 'tool_use',
    });
    const photo = messagePayload(OWNER, 'wamid.B6-j-photo', '');
    const sent = photo.entry[0]!.changes[0]!.value.messages[0]! as Record<string, unknown>;
    delete sent['text'];
    sent['type'] = 'image';
    sent['image'] = { id: 'photo-1', mime_type: 'image/jpeg' };
    await post(photo);
    await drain();
    expect(stubSender.lastText).toBe(replies.notABusinessDocument().text);
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);

    /* "last month" now answers nothing: the newest thing said was the photo. */
    await reply('wamid.B6-j-late', 'last month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
  });

  it.each([
    {
      name: 'a voice note that could not be transcribed',
      arrange: () => {
        const page = Buffer.alloc(28);
        page.write('OggS', 0, 'ascii');
        page.writeBigUInt64LE(BigInt(5 * 48_000), 6);
        page.writeUInt32LE(1, 14);
        page.writeUInt8(1, 26);
        stubSender.media.set('media-1', { bytes: page, mimeType: 'audio/ogg' });
        stubStt.failWith();
      },
      fields: { type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg', voice: true } },
      answer: 'could not listen to that voice note',
    },
    {
      name: 'unsupported media',
      arrange: () => undefined,
      fields: { type: 'sticker', sticker: { id: 'sticker-1', mime_type: 'image/webp' } },
      answer: replies.onlyText().text,
    },
    {
      name: 'a photo that could not be read',
      arrange: () => {
        stubSender.media.set('photo-1', {
          bytes: Buffer.from('JFIF-fake-photo'),
          mimeType: 'image/jpeg',
        });
        stubOcr.failWith();
      },
      fields: { type: 'image', image: { id: 'photo-1', mime_type: 'image/jpeg' } },
      answer: null,
    },
  ])('$name after "Which period?" retires the question', async ({ arrange, fields, answer }) => {
    const business = await seedMerchant();
    await say('wamid.B6-ee-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    arrange();
    await post(mediaMessage('wamid.B6-ee-media', fields));
    await drain();
    if (answer) expect(stubSender.lastText).toContain(answer);
    expect(stubSender.lastText).not.toBe(WHICH_PERIOD);
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);

    await reply('wamid.B6-ee-late', 'last month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
  });

  it('a question or an answer that was never delivered is not continued', async () => {
    const business = await seedMerchant();
    await seedTwoMonths(business.id);

    /* "Which period?" never reached the merchant. */
    stubSender.failWith();
    await say('wamid.B6-f1-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    await reply('wamid.B6-f1-late', 'last month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);

    /* Nor did the resumed answer: there is no read to follow up. */
    await say('wamid.B6-f2-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    stubSender.failWith();
    await reply('wamid.B6-f2-answer', 'last month');
    expect(modelCalls()).toBe(0);
    expect((await continuations(business.id)).map((c) => `${c.kind}:${c.state}`)).toEqual([
      'clarification:superseded',
      'clarification:consumed',
      'query:superseded',
    ]);
    await reply('wamid.B6-f2-follow', 'what about this month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
  });

  it('a "no" after nothing but a question cancels nothing and says it cancelled nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-no-ask', THIS_MONTH, 'How much did I sell this month?');
    const sentBefore = stubSender.sent.length;

    await reply('wamid.B6-no', 'no');
    /* What a "no" with nothing waiting gets: no "Cancelled", and since G-68
     * no silence either, but the truthful nothing-to-decline reply. */
    expect(stubSender.sent.slice(sentBefore).map((m) => m.text)).not.toContain(
      replies.cancelled().text,
    );
    expect(stubSender.sent.slice(sentBefore).map((m) => m.text)).toEqual([
      replies.nothingToDecline().text,
    ]);
    /* The read is still dropped, as every pending draft is. */
    expect(await draftStates(business.id)).toEqual(['Query:superseded']);
  });

  it("a question's draft never keeps the merchant's words for the window", async () => {
    const business = await seedMerchant();
    await say(
      'wamid.B6-pt',
      { ...HOW_MUCH_DID_I_SELL, period: 'custom', periodText: 'the month I sold to Ada' },
      'sales in the month I sold to Ada',
    );
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ command: Record<string, unknown> }>(sql`
        SELECT command FROM command_drafts WHERE business_id = ${business.id}::uuid`),
    );
    const stored = [...rows].map((r) => r.command);
    expect(stored).toHaveLength(1);
    expect(stored[0]!['periodText']).toBeNull();
    expect(JSON.stringify(stored)).not.toContain('Ada');
  });

  it('a named window with words that draw a different window, or none, is asked about', async () => {
    const business = await seedMerchant();
    const { lastMonthLabel } = await seedTwoMonths(business.id);
    const asked = async (wamid: string, period: string, periodText: string) => {
      await say(wamid, { ...HOW_MUCH_DID_I_SELL, period, periodText }, `sales ${periodText}`);
      return stubSender.lastText;
    };

    /* Words core cannot draw: said so, never answered for the named window. */
    expect(await asked('wamid.B6-t7-1', 'month', 'yesterday')).toBe(NOT_COUNTABLE);
    expect(await asked('wamid.B6-t7-2', 'today', 'yesterday')).toBe(NOT_COUNTABLE);
    expect(await asked('wamid.B6-t7-3', 'week', 'last week')).toBe(NOT_COUNTABLE);
    /* Words that draw another window: asked. */
    expect(await asked('wamid.B6-t7-4', 'month', 'last month')).toBe(WHICH_PERIOD);
    /* Words that draw the same window: answered. */
    expect(await asked('wamid.B6-t7-5', 'month', 'this month')).toContain('₦40,000');

    /* The question stays open: "last month" resumes it. */
    await asked('wamid.B6-t7-6', 'month', 'yesterday');
    await reply('wamid.B6-t7-answer', 'last month');
    expect(stubSender.lastText).toContain(`${lastMonthLabel}: ₦150,000`);
    expect(modelCalls()).toBe(0);
  });

  it('a yes behind a question Rekoda asked is never told a preview is waiting', async () => {
    const business = await seedMerchant();
    await say(
      'wamid.B6-uq-half',
      { intent: 'Unclear', clarification: 'How much did she pay?' },
      'she paid half',
    );
    await say('wamid.B6-uq-ask', THIS_MONTH, 'How much did I sell this month?');
    expect(stubSender.lastText).toContain('sales');

    await reply('wamid.B6-uq-yes', 'yes');
    expect(stubSender.lastText).not.toBe(BEHIND);
    expect(stubSender.lastText).not.toContain('preview');
    expect(await footprint(business.id)).toMatchObject({
      invoices: 0,
      payments: 0,
      expenses: 0,
      postings: 0,
    });
    /* As before Build 6: the yes was about the newest thing, the question. */
    expect(await draftStates(business.id)).toEqual(['Unclear:pending', 'Query:confirmed']);
  });

  it('a yes behind a parked erasure ask and a question is not pointed at a preview', async () => {
    const business = await seedMerchant();
    await reply('wamid.B6-ue-del1', 'delete my data');
    await say('wamid.B6-ue-ask', THIS_MONTH, 'How much did I sell this month?');

    await reply('wamid.B6-ue-yes', 'yes');
    expect(stubSender.lastText).not.toBe(BEHIND);
    expect(await draftStates(business.id)).toEqual(['EraseData:pending', 'Query:confirmed']);
  });

  it('logs no message text on the continuation path', async () => {
    const business = await seedMerchant();
    await seedTwoMonths(business.id);
    const spies = (['log', 'debug', 'verbose', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    try {
      await say('wamid.B6-log-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.B6-log-answer', 'Last month please');
      await reply('wamid.B6-log-follow', 'what about this month');
      const logged = spies.flatMap((spy) => spy.mock.calls.flat().map((arg) => String(arg)));
      /* Positive control: the spies did capture the handler's own lines. */
      expect(logged.some((line) => line.includes('answered an inbound message'))).toBe(true);
      for (const words of ['How much did I sell', 'Last month please', 'what about this month']) {
        expect(logged.some((line) => line.includes(words))).toBe(false);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('keeps a customer as a vault token, never a name', async () => {
    const business = await seedMerchant();
    await say(
      'wamid.B6-pii',
      {
        ...HOW_MUCH_DID_I_SELL,
        topic: 'customer_balance',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
      },
      'how much does Ada owe me',
    );

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ row: string }>(sql`
        SELECT row_to_json(c)::text AS row FROM conversation_continuations c
         WHERE business_id = ${business.id}::uuid`),
    );
    const stored = [...rows].map((r) => r.row);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('CUSTOMER_7K2');
    expect(stored[0]).not.toContain('Ada');
    expect(stored[0]).not.toContain('owe');
  });
});
