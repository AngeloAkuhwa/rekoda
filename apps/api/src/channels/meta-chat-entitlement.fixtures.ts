/**
 * Shared helpers for the meta-chat-entitlement suites, split from meta.integration.test.ts.
 * The helpers that hold state or write the plan stay in each suite.
 */
import { expect } from 'vitest';
import { identity, withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { db, deps, intentsProvider, stubSender, workerDb } from './meta-webhook.fixtures.js';

export const OWNER = '2348031234567';

export const REFUSED = replies.chatCommandNotInPlan().text;

/* The model path's refusal, unchanged by G-65. */
export const FREE_FORM_REFUSED = replies.chatNotInPlan().text;

/* A refused yes says first that nothing was saved. */
export const YES_REFUSED = replies.notSavedNotInPlan().text;

export const LAPSED = replies.trialEnded().text;

export const YES_LAPSED = replies.notSavedPlanEnded('trial').text;

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

export const AN_EXPENSE = {
  intent: 'RecordExpense',
  description: 'fuel for generator',
  amount: 20_000,
  category: 'utilities',
  paymentMethod: 'cash',
};

export const DEBTORS_QUESTION = {
  intent: 'Query',
  topic: 'debtors',
  customer: null,
  period: null,
  periodText: null,
  format: 'chat',
};

export const HOW_MUCH_DID_I_SELL = { ...DEBTORS_QUESTION, topic: 'sales_summary' };

export async function seedMerchant() {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  return identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
}

export async function drain() {
  const runner = buildRunner(workerDb, db, deps);
  let worked = await runner.runOnce();
  while (worked) worked = await runner.runOnce();
}

/**
 * No inbound message may be left failing. A job that answers and then
 * rolls back leaves every counted table as it was, so without this a
 * refusal that crashed after replying would pass as "nothing happened".
 * (A `document.deliver` of a fixture document with no stored bytes fails
 * by design and is not this check's business.)
 */
export async function expectNoFailedJob() {
  const [row] = [
    ...(await workerDb.execute<{ failed: string }>(sql`
        SELECT count(*) AS failed FROM jobs
         WHERE kind = 'inbound.message' AND state <> 'done' AND last_error IS NOT NULL`)),
  ];
  expect(row?.failed).toBe('0');
}

/** Every row a Chat command or a yes could write, counted. */
export async function footprint(businessId: string) {
  const [row] = [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<Record<string, string>>(sql`
          SELECT
            (SELECT count(*) FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*) FROM receipts WHERE business_id = ${businessId}::uuid) AS receipts,
            (SELECT count(*) FROM documents WHERE business_id = ${businessId}::uuid) AS documents,
            (SELECT count(*) FROM orders WHERE business_id = ${businessId}::uuid) AS orders,
            (SELECT count(*) FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
            (SELECT count(*) FROM expenses WHERE business_id = ${businessId}::uuid) AS expenses,
            (SELECT count(*) FROM inventory_movements
              WHERE business_id = ${businessId}::uuid) AS stock_moves,
            (SELECT count(*) FROM ledger_transactions
              WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*) FROM payment_intents
              WHERE business_id = ${businessId}::uuid) AS intents,
            (SELECT count(*) FROM jobs WHERE business_id = ${businessId}::uuid
              AND kind = 'document.deliver') AS deliveries,
            (SELECT count(*) FROM command_drafts WHERE business_id = ${businessId}::uuid
              AND state = 'confirmed') AS confirmed,
            (SELECT COALESCE(sum(used), 0) FROM usage_counters
              WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS') AS ai_actions,
            (SELECT COALESCE(sum(used), 0) FROM usage_counters
              WHERE business_id = ${businessId}::uuid
                AND unit = 'DOCUMENT_GENERATION') AS document_credits,
            /* Every meter, so one added later is covered without editing this. */
            (SELECT COALESCE(string_agg(unit || '=' || used, ',' ORDER BY unit), '')
               FROM usage_counters WHERE business_id = ${businessId}::uuid) AS meters,
            /* Every usage event but the replies' own: each message Rekoda
             * sends records one SERVICE_MESSAGE, the refusal included. */
            (SELECT count(*) FROM usage_events WHERE business_id = ${businessId}::uuid
              AND usage_type <> 'SERVICE_MESSAGE') AS usage_events,
            (SELECT count(*) FROM usage_events WHERE business_id = ${businessId}::uuid
              AND usage_type = 'SERVICE_MESSAGE') AS service_messages`),
    )),
  ];
  return { ...row };
}

/**
 * Nothing moved but the replies: `sent` messages to the merchant, each
 * recording its own SERVICE_MESSAGE, and every other row and meter as it was.
 */
export async function expectOnlyReplies(
  businessId: string,
  before: Awaited<ReturnType<typeof footprint>>,
  sent: number,
) {
  expect(await footprint(businessId)).toEqual({
    ...before,
    service_messages: String(Number(before['service_messages']) + sent),
  });
}

export async function draftStates(businessId: string): Promise<string[]> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts WHERE business_id = ${businessId}::uuid
         ORDER BY insertion_seq`),
  );
  return [...rows].map((r) => r.state);
}

/**
 * Where the stubs stand now. Snapshotted rather than reset: resetting the
 * sender mid-test restarts its provider message ids, and the next reply
 * then collides with an earlier one on `messages_provider_ux`.
 */
export function sendMark() {
  return {
    sent: stubSender.sent.length,
    documents: stubSender.documents.length,
    customerTexts: stubSender.connectionTexts.length,
    templates: stubSender.templates.length,
    mints: intentsProvider.initialized.length,
  };
}

export const NO_MARK = { sent: 0, documents: 0, customerTexts: 0, templates: 0, mints: 0 };

/** What went anywhere but back to the merchant's own chat since `mark`. */
export function beyondTheMerchant(mark = NO_MARK) {
  return {
    elsewhere: stubSender.sent.slice(mark.sent).filter((m) => m.to !== OWNER).length,
    documents: stubSender.documents.length - mark.documents,
    customerTexts: stubSender.connectionTexts.length - mark.customerTexts,
    templates: stubSender.templates.length - mark.templates,
    mints: intentsProvider.initialized.length - mark.mints,
  };
}

export const NOTHING_BEYOND = {
  elsewhere: 0,
  documents: 0,
  customerTexts: 0,
  templates: 0,
  mints: 0,
};

/* English and Pidgin side by side: the router maps both to one intent. */
export const CHAT_COMMANDS = [
  'who owes me',
  'who dey owe me',
  'records',
  'stock',
  'wetin remain',
  'payment details',
  'remind {INV}',
] as const;

/** A voice note or a photograph, as Meta delivers it. */
export function mediaPayload(kind: 'audio' | 'image', wamid: string) {
  const media =
    kind === 'audio'
      ? { type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg', voice: true } }
      : { type: 'image', image: { id: 'photo-1', mime_type: 'image/jpeg' } };
  return {
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
              messages: [{ id: wamid, from: OWNER, timestamp: '1700000000', ...media }],
            },
          },
        ],
      },
    ],
  };
}

/* ── Build 7 (G-68, G-24) surfaces, after the rebase ───────────────────── */

export const A_POS_PURCHASE = {
  intent: 'RecordPurchase',
  supplierMention: 'Emeka',
  description: '10 cartons',
  amount: 180_000,
  reportedPayment: 180_000,
  paymentMethod: 'pos',
  productMention: 'cartons',
  quantity: 10,
};

export const POS_QUESTION = 'did it come from your bank account or from physical cash?';

export async function continuationRows(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ expects: string | null; state: string }>(sql`
        SELECT expects, state FROM conversation_continuations
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
  );
  return [...rows].map((r) => `${r.expects}:${r.state}`);
}

/* ── expired drafts on a plan without Chat (post-rebase review) ────────── */

/** Days pass: every pending draft's window closes. */
export const expireDrafts = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 days'
         WHERE business_id = ${businessId}::uuid AND state = 'pending'`),
  );
