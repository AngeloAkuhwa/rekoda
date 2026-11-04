/**
 * Shared helpers for the meta-stock-purchase suites, split from meta.integration.test.ts.
 * The helpers that hold state or write the plan stay in each suite.
 */
import { identity, stockRepo, withBusiness, sql } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import { issueRepo, spendRepo } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  post,
  stubTransport,
  workerDb,
} from './meta-webhook.fixtures.js';

export const buy = (over: Record<string, unknown> = {}) => ({
  intent: 'RecordPurchase',
  supplierMention: 'Mama Nkechi',
  description: '10 crates of ankara',
  amount: 50_000,
  reportedPayment: 50_000,
  paymentMethod: 'cash',
  productMention: 'crates of ankara',
  quantity: 10,
  ...over,
});

export async function seedMerchant(phone: string) {
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

export const onHand = (businessId: string, name: string) =>
  withBusiness(db, businessId, (tx) => stockRepo.productByName(tx, businessId, name));

/* G-61: the paid part leaves the account the merchant named, the preview
 * says which before the yes, and an account nobody named is asked about. */
export const cartons = (over: Record<string, unknown>) =>
  buy({
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    productMention: 'cartons',
    quantity: 10,
    ...over,
  });

export async function nets(businessId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const entries = await withBusiness(db, businessId, (tx) =>
    issueRepo.ledgerEntriesFor(tx, businessId),
  );
  for (const e of entries) out[e.account] = (out[e.account] ?? 0) + e.debitK - e.creditK;
  return out;
}

export const purchaseRows = (businessId: string) =>
  withBusiness(db, businessId, (tx) => spendRepo.expensesFor(tx, businessId));

/** Everything one purchase writes, counted, plus the drafts' states. */
export async function purchaseFootprint(businessId: string) {
  const [row] = [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM ledger_transactions
              WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*)::int FROM inventory_movements
              WHERE business_id = ${businessId}::uuid) AS arrivals,
            (SELECT count(*)::int FROM bills WHERE business_id = ${businessId}::uuid) AS bills,
            (SELECT count(*)::int FROM outbox_events
              WHERE business_id = ${businessId}::uuid AND type = 'purchase.recorded') AS announced,
            (SELECT count(*)::int FROM command_drafts
              WHERE business_id = ${businessId}::uuid AND state = 'pending') AS pending,
            (SELECT count(*)::int FROM command_drafts
              WHERE business_id = ${businessId}::uuid AND state = 'abandoned') AS retired
        `),
    )),
  ];
  return row;
}
