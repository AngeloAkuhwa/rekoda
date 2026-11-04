/**
 * Shared helpers for the meta-continuations suites, split from meta.integration.test.ts.
 * The helpers that hold state or write the plan stay in each suite.
 */
import { createDb, identity, withBusiness, sql } from '@rekoda/db';
import { replies, resolvePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { issueRepo, settleRepo } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  post,
  stubTransport,
  urls,
  workerDb,
} from './meta-webhook.fixtures.js';

export const OWNER = '2348031234567';

export const DELEGATE = '2348039990002';

export const WHICH_PERIOD = replies.whichPeriod('sales').text;

export const NOT_COUNTABLE = replies.periodNotCountable('sales').text;

export const STRAY = replies.strayNumber().text;

export const HOW_MUCH_DID_I_SELL = {
  intent: 'Query',
  topic: 'sales_summary',
  customer: null,
  period: null,
  periodText: null,
  format: 'chat',
};

export const HOW_MUCH_DID_I_SPEND = { ...HOW_MUCH_DID_I_SELL, topic: 'expenses_summary' };

/* What the model says when it is (wrongly) handed a bare answer. */
export const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };

export const POS_PURCHASE = {
  intent: 'RecordPurchase',
  supplierMention: 'Emeka',
  description: '10 cartons',
  amount: 100_000,
  reportedPayment: 100_000,
  paymentMethod: 'pos',
  productMention: 'cartons',
  quantity: 10,
};

export const A_SALE = {
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

export async function seedMerchant(phone = `+${OWNER}`) {
  const user = await identity.upsertUserByPhone(db, phone);
  return identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
}

export async function drain() {
  /* A fresh runner every time: the state must survive the worker being
   * rebuilt between the question and the answer (durable, not memory). */
  const runner = buildRunner(workerDb, db, deps);
  let worked = await runner.runOnce();
  while (worked) worked = await runner.runOnce();
}

export async function say(
  wamid: string,
  command: Record<string, unknown>,
  text: string,
  from = OWNER,
) {
  stubTransport.replyWith(command);
  await post(messagePayload(from, wamid, text));
  await drain();
}

/** A message the model would read as unclear, if it ever reached it. */
export async function reply(wamid: string, text: string, from = OWNER) {
  stubTransport.replyWith(UNCLEAR);
  await post(messagePayload(from, wamid, text));
  await drain();
}

export const modelCalls = () => stubTransport.requests.length;

/** One sale of ₦150,000 last month (₦60,000 paid), one of ₦40,000 this month. */
export async function seedTwoMonths(businessId: string) {
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

export async function continuations(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{
      user_id: string;
      kind: string;
      expects: string | null;
      topic: string | null;
      period: string | null;
      state: string;
    }>(sql`
        SELECT user_id, kind, expects, topic, period, state FROM conversation_continuations
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
  );
  return [...rows];
}

/** Every row a write could leave, counted. */
export async function footprint(businessId: string) {
  const [row] = [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS expenses,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*)::int FROM command_drafts WHERE business_id = ${businessId}::uuid) AS drafts
        `),
    )),
  ];
  return row!;
}

export async function draftStates(businessId: string): Promise<string[]> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string; intent: string }>(sql`
        SELECT state, intent FROM command_drafts WHERE business_id = ${businessId}::uuid
         ORDER BY insertion_seq`),
  );
  return [...rows].map((r) => `${r.intent}:${r.state}`);
}

export const BEHIND = replies.previewBehindQuestion().text;

export const THIS_MONTH = { ...HOW_MUCH_DID_I_SELL, period: 'month' };

/* ---- Build 6 final-head round 3 ---- */

export async function addDelegate(businessId: string) {
  const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
  await identity.addMembership(db, businessId, delegate.id, 'delegate');
}

/** An inbound message of another kind, on the same envelope as a text. */
export function mediaMessage(wamid: string, fields: Record<string, unknown>, from = OWNER) {
  const payload = messagePayload(from, wamid, '');
  const sent = payload.entry[0]!.changes[0]!.value.messages[0]! as Record<string, unknown>;
  delete sent['text'];
  Object.assign(sent, fields);
  return payload;
}
