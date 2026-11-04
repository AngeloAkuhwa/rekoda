/**
 * Shared helpers for the meta-purchase-truth suites, split from meta.integration.test.ts.
 * The helpers that hold state or write the plan stay in each suite.
 */
import { expect } from 'vitest';
import { identity, stockRepo, withBusiness, sql } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  workerDb,
} from './meta-webhook.fixtures.js';

export const OWNER = '2348031234567';

export const DELEGATE = '2348039990002';

export const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };

/* Sets a second preview's total equal to MILO's: two previews of one total
 * that nothing proves separate, built by hand because the chat flow no
 * longer makes them (since OWN-32 not even with different references). */
export const ALIGN = JSON.stringify({ amount: 100_000, reportedPayment: 100_000 });

export const MILO = {
  intent: 'RecordPurchase',
  supplierMention: 'Emeka',
  description: '10 cartons of Milo',
  amount: 100_000,
  reportedPayment: 100_000,
  paymentMethod: 'cash',
  productMention: 'Milo',
  quantity: 10,
};

export const QUESTION = 'Is this the same purchase?';

export const SAME_DONE = 'OK, nothing more was saved.';

export const SEPARATE_LEAD =
  'OK, this is a separate purchase.\n\nPlease check this before I save it:';

export const REASK = 'Please reply *same* or *separate*';

export const CLOSED = 'That question has closed, so nothing was saved.';

export const RACE = 'Nothing was saved from your yes.';

export async function seedMerchant(phone = `+${OWNER}`) {
  const user = await identity.upsertUserByPhone(db, phone);
  return identity.createBusinessWithOwner(db, {
    name: 'Ada Provisions',
    businessType: null,
    ownerUserId: user.id,
  });
}

export async function addDelegate(businessId: string) {
  const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
  await identity.addMembership(db, businessId, delegate.id, 'delegate');
  return delegate.id;
}

export async function drain() {
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

export async function reply(wamid: string, text: string, from = OWNER) {
  stubTransport.replyWith(UNCLEAR);
  await post(messagePayload(from, wamid, text));
  await drain();
}

export async function purchaseStates(businessId: string): Promise<string[]> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts
         WHERE business_id = ${businessId}::uuid AND intent = 'RecordPurchase'
         ORDER BY insertion_seq`),
  );
  return [...rows].map((r) => r.state);
}

/** Every row a purchase confirmation can write, counted (test 6). */
export async function footprint(businessId: string) {
  const [row] = [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM inventory_movements WHERE business_id = ${businessId}::uuid) AS arrivals,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*)::int FROM ledger_entries WHERE business_id = ${businessId}::uuid) AS entries,
            (SELECT count(*)::int FROM bills WHERE business_id = ${businessId}::uuid) AS bills,
            (SELECT coalesce(sum(last_seq), 0)::int FROM doc_counters WHERE business_id = ${businessId}::uuid) AS numbers,
            (SELECT count(*)::int FROM outbox_events WHERE business_id = ${businessId}::uuid AND type = 'purchase.recorded') AS events,
            (SELECT count(*)::int FROM idempotency_records WHERE business_id = ${businessId}::uuid) AS keys,
            (SELECT coalesce(sum(used), 0)::int FROM usage_counters WHERE business_id = ${businessId}::uuid) AS units,
            (SELECT count(*)::int FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
              WHERE e.business_id = ${businessId}::uuid AND a.code IN ('1000', '1010', '1020', '2000')) AS cash_bank_ap,
            (SELECT count(*)::int FROM documents WHERE business_id = ${businessId}::uuid) AS documents,
            (SELECT count(*)::int FROM audit_events WHERE business_id = ${businessId}::uuid) AS audit
        `),
    )),
  ];
  return row!;
}

export async function purchases(businessId: string): Promise<number> {
  return (await footprint(businessId)).purchases!;
}

/** Known identities, as a business that has traded before has them. */
export async function knownSupplier(businessId: string, name: string) {
  const known = await deps.gateway.resolveSupplierMention(businessId, name);
  await withBusiness(db, businessId, (tx) =>
    tx.execute(sql`
        UPDATE suppliers SET created_at = clock_timestamp() - interval '30 days'
         WHERE business_id = ${businessId}::uuid AND id = ${known!.supplierId}::uuid`),
  );
}

/** A TRUSTED product (owner ruling D3): linked to a catalogue item. */
export async function knownProduct(businessId: string, name: string) {
  await withBusiness(db, businessId, async (tx) => {
    const product = await stockRepo.findOrCreateProduct(tx, businessId, name);
    await tx.execute(sql`
        UPDATE products SET external_catalogue_id = ${`cat-${product.id}`}
         WHERE business_id = ${businessId}::uuid AND id = ${product.id}::uuid`);
  });
}

export async function bookMilo(businessId: string, tag: string, from = OWNER) {
  await say(`wamid.${tag}-buy`, MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash', from);
  expect(stubSender.lastText).toContain('Paid in full by cash');
  await reply(`wamid.${tag}-yes`, 'yes', from);
  expect(stubSender.lastText).toContain('Saved ✅ ₦100,000 stock purchase.');
}
