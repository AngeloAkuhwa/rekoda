/**
 * Shared helpers for the meta-preview-expiry suites, split from meta.integration.test.ts.
 * The helpers that hold state or write the plan stay in each suite.
 */
import { createDb, identity, usageRepo, withBusiness, sql, type Db } from '@rekoda/db';
import { replies, usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  messagePayload,
  post,
  statusPayload,
  stubSender,
  stubTransport,
  urls,
  workerDb,
} from './meta-webhook.fixtures.js';
import type { InjectedResponse } from './meta-webhook.fixtures.js';

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

export const A_PURCHASE = {
  intent: 'RecordPurchase',
  supplierMention: 'Emeka',
  description: '10 cartons',
  amount: 180_000,
  reportedPayment: 180_000,
  paymentMethod: 'transfer',
  productMention: 'cartons',
  quantity: 10,
};

export const EXPIRED = replies.draftExpired().text;

export async function seedMerchant(phone = '+2348031234567') {
  const user = await identity.upsertUserByPhone(db, phone);
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

export async function say(wamid: string, command: Record<string, unknown>, text: string) {
  stubTransport.replyWith(command);
  await post(messagePayload('2348031234567', wamid, text));
  await drain();
}

export async function plain(wamid: string, text: string) {
  await post(messagePayload('2348031234567', wamid, text));
  await drain();
}

/** Days pass: every open window of this business closes. */
export const lapse = (businessId: string, where = sql`state = 'pending'`) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 days'
         WHERE business_id = ${businessId}::uuid AND ${where}`),
  );

export async function states(businessId: string): Promise<string[]> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts WHERE business_id = ${businessId}::uuid
         ORDER BY insertion_seq`),
  );
  return [...rows].map((r) => r.state);
}

/** Every row a confirmation can write, counted. */
export async function footprint(businessId: string) {
  const [row] = [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
            (SELECT count(*)::int FROM payment_allocations WHERE business_id = ${businessId}::uuid) AS allocations,
            (SELECT count(*)::int FROM receipts WHERE business_id = ${businessId}::uuid) AS receipts,
            (SELECT count(*)::int FROM customer_credits WHERE business_id = ${businessId}::uuid) AS credits,
            (SELECT count(*)::int FROM reconciliations WHERE business_id = ${businessId}::uuid) AS reconciliations,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS expenses,
            (SELECT count(*)::int FROM orders WHERE business_id = ${businessId}::uuid) AS orders,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings
        `),
    )),
  ];
  return row!;
}

export async function used(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return {
    documents: rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0,
    orders: rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0,
  };
}

/**
 * Attempt 1 of the next "yes" meters, claims, then fails issuing (a
 * fail-once trigger on invoices): the job rolls back and is retried later,
 * so other messages can be handled before it. Test-scoped, on the owner.
 */
export async function withFirstInvoiceFailing(run: (owner: Db) => Promise<void>) {
  const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
  try {
    await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_once`);
    await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_once') = 1 THEN RAISE EXCEPTION 'g23: first attempt fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
    await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_once BEFORE INSERT ON invoices
          FOR EACH ROW EXECUTE FUNCTION g23_fail_once()`);
    await run(ownerDb);
  } finally {
    await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_once ON invoices`);
    await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_once()`);
    await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_once`);
    await close();
  }
}

/** Push every job still waiting for this business an hour out. */
export const holdRetries = (owner: Db, businessId: string) =>
  owner.execute(sql`
      UPDATE jobs SET run_at = now() + interval '1 hour'
       WHERE business_id = ${businessId}::uuid AND state <> 'done'`);

/** Make every job still waiting for this business due now. */
export const runRetriesNow = (owner: Db, businessId: string) =>
  owner.execute(sql`
      UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);

/* G-20: WhatsApp ACCEPTING a preview is not the merchant receiving it. A
 * delivery that fails after acceptance comes back as a `failed` status
 * webhook, and that preview is then exactly as unseen as one whose send
 * failed outright. */
export const previewFlags = async (businessId: string) => {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ previewed: boolean; linked: boolean }>(sql`
        SELECT previewed, identity_link IS NOT NULL AS linked FROM command_drafts
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
  );
  return [...rows];
};

/** The wamid the stub handed back for the last text it sent. */
export const lastWamid = () => `wamid.STUB${stubSender.sent.length}`;

export const receipt = (
  recipient: string,
  wamid: string,
  status: string,
): Promise<InjectedResponse> => post(statusPayload(recipient, wamid, status));

export const draftStates = async (businessId: string) => [
  ...(await withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string; reason: string | null }>(sql`
          SELECT state, retired_reason AS reason FROM command_drafts
           WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
  )),
];

export const receiptProcessed = async (businessId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{ processed: boolean }>(sql`
          SELECT processed_at IS NOT NULL AS processed FROM external_events
           WHERE business_id = ${businessId}::uuid AND event_type = 'status.failed'`),
    )),
  ].map((r) => r.processed);
