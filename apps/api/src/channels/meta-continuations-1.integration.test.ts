/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a short reply continues what Rekoda just asked (Build 6) (part 1 of 2).
 * Split by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are
 * in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { createDb, identity, withBusiness, sql } from '@rekoda/db';
import { replies, resolvePeriod } from '@rekoda/core';
import { issueRepo, settleRepo, spendRepo } from '@rekoda/db';
import { db, stubSender, urls, useMetaWebhookHarness } from './meta-webhook.fixtures.js';
import {
  OWNER,
  DELEGATE,
  WHICH_PERIOD,
  NOT_COUNTABLE,
  STRAY,
  HOW_MUCH_DID_I_SELL,
  HOW_MUCH_DID_I_SPEND,
  UNCLEAR,
  POS_PURCHASE,
  A_SALE,
  seedMerchant,
  say,
  reply,
  modelCalls,
  continuations,
  footprint,
  draftStates,
  BEHIND,
  THIS_MONTH,
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
  /** One sale of ₦150,000 last month (₦60,000 paid), one of ₦40,000 this month. */
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

  it('"How much did I sell?", "Which period?", "Last month." answers for last month, with no model', async () => {
    const business = await seedMerchant();
    const { lastMonthLabel } = await seedTwoMonths(business.id);

    await say('wamid.B6-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    await reply('wamid.B6-answer', 'Last month.');
    /* The original question resumed over the window the merchant named. */
    expect(stubSender.lastText).toContain(`${lastMonthLabel}: ₦150,000 invoiced across one sale`);
    expect(stubSender.lastText).toContain('₦60,000 of that has actually come in');
    /* Not this month's ₦40,000, and not a guess by the model. */
    expect(stubSender.lastText).not.toContain('₦40,000');
    expect(modelCalls()).toBe(0);

    /* One-shot: the question is consumed, and the read it resumed is now
     * what a follow-up continues. */
    expect((await continuations(business.id)).map((c) => `${c.kind}:${c.state}`)).toEqual([
      'clarification:consumed',
      'query:open',
    ]);
  });

  it('a follow-up continues the read just answered: "what about this month"', async () => {
    const business = await seedMerchant();
    const { thisMonthLabel } = await seedTwoMonths(business.id);

    await say('wamid.B6-f-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await reply('wamid.B6-f-answer', 'last month');
    await reply('wamid.B6-f-follow', 'what about this month');

    expect(stubSender.lastText).toContain(`${thisMonthLabel}: ₦40,000 invoiced across one sale`);
    expect(modelCalls()).toBe(0);
  });

  it("one member's answer never lands on another member's question", async () => {
    const business = await seedMerchant();
    const { lastMonthLabel } = await seedTwoMonths(business.id);
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');

    await say('wamid.B6-a-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?', OWNER);
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    /* The delegate's "last month" is not an answer to the owner's question:
     * it goes to the model like any message with nothing open for them. */
    await reply('wamid.B6-a-other', 'last month', DELEGATE);
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);

    /* The owner's question is still open, and still theirs. */
    await reply('wamid.B6-a-own', 'last month', OWNER);
    expect(stubSender.lastText).toContain(`${lastMonthLabel}: ₦150,000`);
    expect(modelCalls()).toBe(0);
  });

  it("one business's answer never lands on another business's question", async () => {
    const first = await seedMerchant(`+${OWNER}`);
    await seedMerchant('+2348035550000');

    await say('wamid.B6-b-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?', OWNER);
    await reply('wamid.B6-b-other', 'last month', '2348035550000');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);

    await reply('wamid.B6-b-own', 'last month', OWNER);
    expect(stubSender.lastText).toContain('sales');
    expect(modelCalls()).toBe(0);
    expect((await continuations(first.id)).map((c) => c.state)).toEqual(['consumed', 'open']);
  });

  it('a new purchase after "Which period?" is a purchase, and the question is gone', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-n-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');

    await say(
      'wamid.B6-n-buy',
      { ...POS_PURCHASE, paymentMethod: 'cash' },
      'I bought 10 cartons for 100k cash',
    );
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toContain('Paid in full by cash');
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);

    /* A later "last month" answers nothing: the question was replaced. */
    await reply('wamid.B6-n-late', 'last month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
  });

  it('an expired question behaves as if it was never asked', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-e-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid`),
    );

    await reply('wamid.B6-e-late', 'last month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['expired']);
  });

  it('the newest question wins: an answer goes to the question asked last', async () => {
    const business = await seedMerchant();
    await withBusiness(db, business.id, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId: business.id,
        description: 'fuel for generator',
        category: 'utilities',
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'b6-fuel',
      }),
    );

    await say('wamid.B6-r-sell', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await say('wamid.B6-r-spend', HOW_MUCH_DID_I_SPEND, 'How much did I spend?');
    expect(stubSender.lastText).toBe(replies.whichPeriod('spending').text);

    await reply('wamid.B6-r-answer', 'this month');
    expect(stubSender.lastText).toContain('₦12,000 spent across one entry');
    expect(
      (await continuations(business.id)).map((c) => `${c.topic}:${c.kind}:${c.state}`),
    ).toEqual([
      'sales_summary:clarification:superseded',
      'expenses_summary:clarification:consumed',
      'expenses_summary:query:open',
    ]);
  });

  it('a bare number while a period is expected is not guessed at', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-2-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');

    await reply('wamid.B6-2', '2');
    expect(stubSender.lastText).toBe(STRAY);
    expect(modelCalls()).toBe(0);
    /* And the question did not survive being answered with the wrong thing. */
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
  });

  it('a bare number with nothing open stays a stray number', async () => {
    await seedMerchant();
    await reply('wamid.B6-2-alone', '2');
    expect(stubSender.lastText).toBe(STRAY);
  });

  it('a continuation never writes a record, and a yes after it confirms nothing new', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-w-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    const before = await footprint(business.id);

    await reply('wamid.B6-w-answer', 'last month');
    /* Only the footprint the same message left before Build 6: one
     * read-only question draft, which nothing can confirm. */
    expect(await footprint(business.id)).toEqual({ ...before, drafts: (before.drafts ?? 0) + 1 });
    expect(await draftStates(business.id)).toEqual(['Query:pending', 'Query:pending']);
    const stored = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ command: Record<string, unknown>; model: string | null }>(sql`
        SELECT command, model FROM command_drafts WHERE business_id = ${business.id}::uuid
         ORDER BY insertion_seq DESC LIMIT 1`),
    );
    expect([...stored][0]).toEqual({
      command: {
        intent: 'Query',
        topic: 'sales_summary',
        customer: null,
        period: 'custom',
        periodText: null,
        format: null,
      },
      model: null,
    });

    await reply('wamid.B6-w-yes', 'yes');
    expect(await footprint(business.id)).toMatchObject({
      invoices: before.invoices,
      payments: before.payments,
      expenses: before.expenses,
      postings: before.postings,
    });
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
  });

  it('a G-23 expired preview stays expired through a question, its answer and a yes', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-g23-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 days'
         WHERE business_id = ${business.id}::uuid`),
    );

    await say('wamid.B6-g23-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await reply('wamid.B6-g23-answer', 'last month');
    expect(stubSender.lastText).toContain('sales');

    /* The yes is about the expired preview, the last thing it could be
     * about: never revived, never "saved", and the question in between is
     * not something a yes confirms. */
    await reply('wamid.B6-g23-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.draftExpired().text);
    await reply('wamid.B6-g23-no', 'no');
    expect(stubSender.lastText).toBe(replies.expiredNothingToCancel().text);

    expect((await draftStates(business.id))[0]).toBe('RecordSale:expired');
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
  });

  it('a live preview behind a question and its answer takes three yeses, as on base', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-live-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.B6-live-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);
    await reply('wamid.B6-live-answer', 'Last month');
    expect(modelCalls()).toBe(0);

    /* Two questions since the preview ("Which period?" and the resumed
     * read): each yes retires the newest one, exactly the draft that yes
     * claimed before Build 6, and saves nothing. */
    await reply('wamid.B6-live-yes1', 'yes');
    expect(stubSender.lastText).toBe(BEHIND);
    expect(await draftStates(business.id)).toEqual([
      'RecordSale:pending',
      'Query:pending',
      'Query:superseded',
    ]);
    await reply('wamid.B6-live-yes2', 'yes');
    expect(stubSender.lastText).toBe(BEHIND);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0 });

    /* The third, as on base, confirms it through the ordinary claim. */
    await reply('wamid.B6-live-yes3', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 1 });
    expect((await draftStates(business.id))[0]).toBe('RecordSale:confirmed');
  });

  it('two model-answered questions after a preview take a yes each before the yes that saves', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-two-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.B6-two-q1', THIS_MONTH, 'How much did I sell this month?');
    await say(
      'wamid.B6-two-q2',
      { ...THIS_MONTH, topic: 'expenses_summary' },
      'How much did I spend this month?',
    );

    await reply('wamid.B6-two-yes1', 'yes');
    expect(stubSender.lastText).toBe(BEHIND);
    await reply('wamid.B6-two-yes2', 'yes');
    expect(stubSender.lastText).toBe(BEHIND);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    expect(await draftStates(business.id)).toEqual([
      'RecordSale:pending',
      'Query:superseded',
      'Query:superseded',
    ]);

    await reply('wamid.B6-two-yes3', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 1 });
    await reply('wamid.B6-two-yes4', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 1 });
  });

  it('a yes behind [live preview, expired preview, question] reports the expiry and leaves the live one alone', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-m7-p1', A_SALE, 'sold Ada 3 wigs for 300k');
    await say(
      'wamid.B6-m7-p2',
      { ...A_SALE, items: [{ name: 'bag', quantity: 1, unitPrice: 50_000 }], statedTotal: 50_000 },
      'sold Ada 1 bag for 50k',
    );
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid
           AND insertion_seq = (SELECT max(insertion_seq) FROM command_drafts
                                 WHERE business_id = ${business.id}::uuid)`),
    );
    await say('wamid.B6-m7-ask', THIS_MONTH, 'How much did I sell this month?');

    await reply('wamid.B6-m7-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.draftExpired().text);
    expect(await draftStates(business.id)).toEqual([
      'RecordSale:pending',
      'RecordSale:expired',
      'Query:pending',
    ]);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
  });

  it('"correct" after reading a figure never saves the older preview', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-ack-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.B6-ack-ask', THIS_MONTH, 'How much did I sell this month?');
    expect(stubSender.lastText).toContain('sales');

    await reply('wamid.B6-ack-correct', 'correct');
    expect(stubSender.lastText).toBe(BEHIND);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    /* The preview is untouched and still waiting; the question is retired. */
    expect(await draftStates(business.id)).toEqual(['RecordSale:pending', 'Query:superseded']);

    await reply('wamid.B6-ack-yes', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 1 });
    /* Exactly one: a further yes finds nothing. */
    await reply('wamid.B6-ack-yes-again', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 1 });
  });

  it('a preview that expires after the pointer is reported expired, never saved', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-exp-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.B6-exp-ask', THIS_MONTH, 'How much did I sell this month?');
    await reply('wamid.B6-exp-yes1', 'yes');
    expect(stubSender.lastText).toBe(BEHIND);

    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'`),
    );
    await reply('wamid.B6-exp-yes2', 'yes');
    expect(stubSender.lastText).toBe(replies.draftExpired().text);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
  });

  it('a yes after a retired G-61 question and a question still re-asks it, executing nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-g61q-pos', POS_PURCHASE, 'I bought 10 cartons for 100k, paid by POS');
    await say('wamid.B6-g61q-ask', THIS_MONTH, 'How much did I sell this month?');
    await reply('wamid.B6-g61q-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    expect(await footprint(business.id)).toMatchObject({ expenses: 0, postings: 0 });
  });

  it('a named period whose words disagree with it is asked about, never guessed', async () => {
    const business = await seedMerchant();
    await seedTwoMonths(business.id);
    await say(
      'wamid.B6-disagree',
      { ...HOW_MUCH_DID_I_SELL, period: 'month', periodText: 'last month' },
      'How much did I sell last month?',
    );
    expect(stubSender.lastText).toBe(WHICH_PERIOD);
  });

  it('a window named but not countable here says what can be counted, and stays open', async () => {
    const business = await seedMerchant();
    const { lastMonthLabel } = await seedTwoMonths(business.id);

    await say(
      'wamid.B6-y-ask',
      { ...HOW_MUCH_DID_I_SELL, period: 'custom', periodText: 'yesterday' },
      'how much did I sell yesterday',
    );
    expect(stubSender.lastText).toBe(NOT_COUNTABLE);
    expect(stubSender.lastText).not.toBe(WHICH_PERIOD);

    await reply('wamid.B6-y-answer', 'last month');
    expect(stubSender.lastText).toContain(`${lastMonthLabel}: ₦150,000`);
    expect(modelCalls()).toBe(0);
  });

  it('a custom window the merchant named in one message is answered at once', async () => {
    const business = await seedMerchant();
    const { lastMonthLabel } = await seedTwoMonths(business.id);

    await say(
      'wamid.B6-c-ask',
      { ...HOW_MUCH_DID_I_SELL, period: 'custom', periodText: 'last month' },
      'How much did I sell last month?',
    );
    expect(stubSender.lastText).toContain(`${lastMonthLabel}: ₦150,000`);
    /* No question was asked; the read is what a follow-up continues. */
    expect(
      (await continuations(business.id)).map((c) => `${c.kind}:${c.period}:${c.state}`),
    ).toEqual(['query:last_month:open']);
  });

  it('a G-61 retired question is still closed by "no" while a continuation is open', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-g61no-pos', POS_PURCHASE, 'I bought 10 cartons for 100k, paid by POS');
    await say('wamid.B6-g61no-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    await reply('wamid.B6-g61no-no', 'no');
    expect(stubSender.lastText).toBe(replies.cancelled().text);
    expect((await draftStates(business.id))[0]).toBe('RecordPurchase:superseded');
    /* Closed for good: a later yes does not ask it again. */
    await reply('wamid.B6-g61no-yes', 'yes');
    expect(stubSender.lastText).not.toContain('did it come from your bank account');
    expect(await footprint(business.id)).toMatchObject({ expenses: 0, postings: 0 });
  });
});
