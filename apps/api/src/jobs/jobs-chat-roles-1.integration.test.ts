/**
 * The runner, against a real PostgreSQL (MASTER-PLAN 4.4 #3).
 *
 * `packages/db/src/ops/jobs.integration.test.ts` proves the queue's SQL. These suites
 * prove the thing built on top of it: that a handler runs pinned to its job's
 * tenant, that its writes and its completion are one transaction, and that a
 * handler which throws leaves nothing behind.
 *
 * The runner is built with `buildRunner` — the same function `main.ts` calls —
 * so a handler that exists in the deploy and not in the test registry is not a
 * thing that can happen.
 */
// The job queue and its handlers, end to end. Split by concern across jobs*.integration.test.ts; the shared setup is in
// jobs.fixtures.ts.
import { describe, expect, it } from 'vitest';
import { createDb, sql, usageRepo, withBusiness } from '@rekoda/db';
import { allowanceFor, replies, usagePeriod } from '@rekoda/core';
import { storedEventId, setPlanForTest, settlementDb } from '@rekoda/db/testing';
import { buildRunner } from './jobs.module.js';
import { sealPayload } from '../privacy/payload-vault.js';
import {
  appDb,
  config,
  deps,
  enqueue,
  recordPinned,
  seedBusiness,
  stubSender,
  stubTransport,
  urls,
  workerDb,
  useJobsHarness,
} from './jobs.fixtures.js';
import {
  memberOf,
  saysOverChat,
  ZERO,
  A_SALE,
  A_SALES_QUESTION,
} from './jobs-chat-roles.fixtures.js';

useJobsHarness();

describe('the chat surface enforces roles', () => {
  it("processes THIS job's message out of a multi-event body, not the first", async () => {
    // One webhook body, two text messages from two different numbers - the
    // shape a batched Meta delivery has. The stored payload is the whole
    // body, and this job is for the SECOND message. Before the fix the
    // handler read events[0] and answered the FIRST sender; now it selects
    // by wamid and answers the one this job is for.
    const businessId = await seedBusiness('Batch Ltd', '+2348140019001');
    const first = { waId: '2348140019011', wamid: 'wamid.batchA' };
    const second = { waId: '2348140019012', wamid: 'wamid.batchB' };
    const message = (m: { waId: string; wamid: string }) => ({
      id: m.wamid,
      from: m.waId,
      timestamp: '1700000000',
      type: 'text' as const,
      text: { body: 'who owes me' },
    });
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001', phone_number_id: 'PNID' },
                contacts: [
                  { profile: { name: 'A' }, wa_id: first.waId },
                  { profile: { name: 'B' }, wa_id: second.waId },
                ],
                messages: [message(first), message(second)],
              },
            },
          ],
        },
      ],
    };
    const recorded = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: second.wamid,
      payload: sealPayload(body, config.vaultKey, 'meta', second.wamid),
      businessId,
    });
    await enqueue(businessId, 'inbound.message', { eventId: storedEventId(recorded) });
    await buildRunner(workerDb, appDb, deps).runOnce();

    const last = stubSender.sent[stubSender.sent.length - 1];
    expect(last?.to).toBe(second.waId);
  });

  it('refuses a write command from an accountant, after the model names it one', async () => {
    const businessId = await seedBusiness('Role Gate Ltd', '+2348140010001');
    await memberOf(businessId, '+2348140010002', 'accountant');
    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'fuel',
      amount: 5_000,
      category: 'transport',
      paymentMethod: 'cash',
    });

    const answer = await saysOverChat(businessId, '+2348140010002', 'spent 5k on fuel today');
    expect(answer).toContain('view only');
  });

  /**
   * What a refused message must leave untouched (G-57).
   *
   * Kept identical to the copy in jobs-chat-roles-2.integration.test.ts,
   * jobs-chat-roles-3.integration.test.ts. It uses the owner connection, which stays out of
   * shared fixture modules. Change them together.
   */
  async function footprint(businessId: string): Promise<Record<string, number>> {
    const [row] = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<Record<string, string>>(sql`
        SELECT
          (SELECT COALESCE(sum(used), 0) FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS') AS ai_actions,
          /* Every usage and provider-cost row but the reply's own send. */
          (SELECT count(*) FROM usage_events WHERE business_id = ${businessId}::uuid
            AND usage_type <> 'SERVICE_MESSAGE') AS usage_events,
          (SELECT count(*) FROM command_drafts WHERE business_id = ${businessId}::uuid) AS drafts,
          (SELECT count(*) FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
          (SELECT count(*) FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
          (SELECT count(*) FROM ledger_transactions
            WHERE business_id = ${businessId}::uuid) AS postings,
          (SELECT count(*) FROM inventory_movements
            WHERE business_id = ${businessId}::uuid) AS stock_moves`),
    );
    /* Provider cost is platform data the app role cannot read: as the owner. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      const [cost] = await ownerDb.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM platform_cost_events WHERE business_id = ${businessId}::uuid`);
      return {
        ...Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)])),
        cost_events: Number(cost!.n),
      };
    } finally {
      await close();
    }
  }

  /* G-57: a view-only member asking to CHANGE the books is refused before
   * anything is paid for. The canonical rule (spec §4.3, rules 2 to 4): a
   * refused request consumes no allowance and calls no provider. The model
   * fixture would name it a sale; it must never be asked. */
  it('refuses an accountant`s free-form sale before metering or calling the model', async () => {
    const businessId = await seedBusiness('Role Gate Meter Ltd', '+2348140010011');
    await memberOf(businessId, '+2348140010012', 'accountant');
    stubTransport.replyWith({
      intent: 'RecordSale',
      customer: { kind: 'none' },
      items: [{ name: 'rice', quantity: 1, unitPrice: 50_000 }],
      statedTotal: 50_000,
      reportedPayment: 50_000,
      paymentMethod: 'cash',
      discount: null,
      deliveryFee: null,
      dueDescription: null,
    });

    const answer = await saysOverChat(businessId, '+2348140010012', 'record a sale of 50k cash');
    expect(answer).toContain('view only');
    expect({
      modelCalls: stubTransport.requests.length,
      ...(await footprint(businessId)),
    }).toEqual({
      modelCalls: 0,
      ai_actions: 0,
      usage_events: 0,
      cost_events: 0,
      drafts: 0,
      invoices: 0,
      payments: 0,
      postings: 0,
      stock_moves: 0,
    });
  });

  // Kept identical to the copy in jobs-chat-roles-2.integration.test.ts. It calls footprint, which uses
  // the owner connection, so it stays beside it. Change them together.
  const seen = async (businessId: string) => ({
    modelCalls: stubTransport.requests.length,
    ...(await footprint(businessId)),
  });

  /* D, E, F (C is above): each kind of record, plainly asked for. */
  it.each([
    ['a purchase', 'bought 10 cartons for 180k'],
    ['an expense', 'I spent 20k on fuel'],
    ['a payment', 'Ada paid me 20k'],
    ['a sale', 'sold rice 5k'],
  ])('refuses %s from an accountant before the meter or the model (G-57)', async (_, text) => {
    const businessId = await seedBusiness('Role Gate Kinds Ltd', '+2348140010021');
    await memberOf(businessId, '+2348140010022', 'accountant');
    stubTransport.replyWith(A_SALE);

    expect(await saysOverChat(businessId, '+2348140010022', text)).toBe(
      replies.viewOnlyRole().text,
    );
    expect(await seen(businessId)).toEqual(ZERO);
  });

  /* O (OWN-25): could be either, so it is never sent to the model, never
   * metered, and never called a record: the member is asked for a question. */
  it('asks an accountant for a question when the message could be either (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Unknown Ltd', '+2348140010023');
    await memberOf(businessId, '+2348140010024', 'accountant');
    stubTransport.replyWith(A_SALE);

    for (const text of ['Ada 20k', 'rice and beans for Chidi']) {
      expect(await saysOverChat(businessId, '+2348140010024', text)).toBe(
        replies.viewOnlyAskAQuestion().text,
      );
    }
    expect(await seen(businessId)).toEqual(ZERO);
  });

  /* G: a question is still theirs, through the model, metered as any read. */
  it('answers an accountant free-form question through the model, metered once (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Question Ltd', '+2348140010025');
    await memberOf(businessId, '+2348140010026', 'accountant');
    stubTransport.replyWith(A_SALES_QUESTION);

    const answer = await saysOverChat(
      businessId,
      '+2348140010026',
      'how much did we sell this month?',
    );
    expect(answer).not.toBe(replies.viewOnlyRole().text);
    expect(answer).not.toBe(replies.viewOnlyAskAQuestion().text);
    expect(stubTransport.requests).toHaveLength(1);
    expect((await footprint(businessId)).ai_actions).toBe(1);
  });

  /* Defence in depth: the early check is not the boundary. A question the
   * model reads as a sale is still refused after the model, and nothing is
   * drafted or booked. The call is spent; the unit goes back (spec §4.3
   * rule 4: a refused request consumes nothing). */
  it('still refuses after the model when a question turns out to be a record (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Depth Ltd', '+2348140010027');
    await memberOf(businessId, '+2348140010028', 'accountant');
    /* The owner's own message first, so the counter is not at zero and a
     * second refund would show (refundUnit never goes below zero). */
    stubTransport.replyWith(A_SALES_QUESTION);
    await saysOverChat(businessId, '+2348140010027', 'how much did we sell this month?');
    const before = await footprint(businessId);
    expect(before.ai_actions).toBe(1);
    stubTransport.replyWith(A_SALE);

    expect(
      await saysOverChat(businessId, '+2348140010028', 'how much did we sell this month?'),
    ).toBe(replies.viewOnlyRole().text);
    /* One call spent, the unit back, and nothing drafted or booked. */
    expect(stubTransport.requests).toHaveLength(1);
    const after = await footprint(businessId);
    for (const key of ['ai_actions', 'drafts', 'invoices', 'payments', 'postings', 'stock_moves']) {
      expect(after[key], key).toBe(before[key]);
    }
  });

  /* A, B, and the control OWN-25 insists on: a member who may record is never
   * put through the early check, so "Ada 20k" reaches the model as before. */
  it.each([
    ['the owner', null],
    ['a delegate', 'delegate'],
  ] as const)('sends free-form text from %s to the model as before (G-57)', async (_, role) => {
    const businessId = await seedBusiness('Role Gate Writers Ltd', '+2348140010031');
    const phone = role ? '+2348140010032' : '+2348140010031';
    if (role) await memberOf(businessId, phone, role);
    stubTransport.replyWith(A_SALE);

    const preview = await saysOverChat(businessId, phone, 'sold rice 20k');
    expect(preview).toContain('Reply *yes*');
    expect(stubTransport.requests).toHaveLength(1);
    expect((await footprint(businessId)).ai_actions).toBe(1);

    stubTransport.replyWith(A_SALE);
    await saysOverChat(businessId, phone, 'Ada 20k');
    expect(stubTransport.requests).toHaveLength(1);
    expect((await footprint(businessId)).ai_actions).toBe(2);
  });

  /* I, J: the plan is refused first, exactly as before, and costs nothing. */
  it('refuses an Integrate-only or lapsed accountant on the plan first, costing nothing (G-57)', async () => {
    const integrate = await seedBusiness('Role Gate Integrate Ltd', '+2348140010033');
    await memberOf(integrate, '+2348140010034', 'accountant');
    await setPlanForTest(appDb, {
      businessId: integrate,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test-plan',
    });
    stubTransport.replyWith(A_SALE);
    expect(await saysOverChat(integrate, '+2348140010034', 'sold rice 5k')).toBe(
      replies.chatNotInPlan().text,
    );
    expect(await seen(integrate)).toEqual(ZERO);

    const lapsed = await seedBusiness('Role Gate Lapsed Ltd', '+2348140010035');
    await memberOf(lapsed, '+2348140010036', 'accountant');
    await setPlanForTest(appDb, {
      businessId: lapsed,
      plan: 'trial',
      expiresAt: new Date(Date.now() - 1_000),
      actor: 'operator:test-clock',
    });
    stubTransport.replyWith(A_SALES_QUESTION);
    const answer = await saysOverChat(lapsed, '+2348140010036', 'how much did we sell?');
    expect(answer).not.toBe(replies.viewOnlyRole().text);
    expect(await seen(lapsed)).toEqual(ZERO);
  });

  /* G-107: the refusal quotes what the merchant actually had, a bought pack
   * included, not the bare plan allowance. */
  it('quotes the plan allowance plus a bought pack when it refuses at the meter (G-107)', async () => {
    const businessId = await seedBusiness('Pack Quote Ltd', '+2348140010047');
    await memberOf(businessId, '+2348140010048', 'accountant');
    const allowance = allowanceFor('trial', 'AI_ACTIONS');
    const bought = 100;
    // The pack is settlement's credit; spending it is the application's (0209, 0211).
    await withBusiness(settlementDb(), businessId, (tx) =>
      usageRepo.creditBonus(tx, businessId, usagePeriod(new Date()), 'AI_ACTIONS', bought),
    );
    await withBusiness(appDb, businessId, async (tx) => {
      await usageRepo.consumeUnit(
        tx,
        businessId,
        usagePeriod(new Date()),
        'AI_ACTIONS',
        allowance,
        allowance + bought,
      );
    });
    stubTransport.replyWith(A_SALES_QUESTION);

    expect(
      await saysOverChat(businessId, '+2348140010048', 'how much did we sell this month?'),
    ).toBe(replies.allowanceExhausted(allowance + bought).text);
    expect(stubTransport.requests).toHaveLength(0);
  });

  /* K: an accountant's question with the allowance gone is refused at the
   * meter, before the model, and takes nothing more. */
  it('refuses an accountant question at an exhausted allowance before the model (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Exhausted Ltd', '+2348140010037');
    await memberOf(businessId, '+2348140010038', 'accountant');
    const allowance = allowanceFor('trial', 'AI_ACTIONS');
    await withBusiness(appDb, businessId, (tx) =>
      usageRepo.consumeUnit(
        tx,
        businessId,
        usagePeriod(new Date()),
        'AI_ACTIONS',
        allowance,
        allowance,
      ),
    );
    stubTransport.replyWith(A_SALES_QUESTION);

    expect(
      await saysOverChat(businessId, '+2348140010038', 'how much did we sell this month?'),
    ).toBe(replies.allowanceExhausted(allowance).text);
    expect(stubTransport.requests).toHaveLength(0);
    expect((await footprint(businessId)).ai_actions).toBe(allowance);
  });
});
