/**
 * Shared helpers for the meta-receipt-photo suites, split from meta.integration.test.ts.
 * The helpers that hold state or write the plan stay in each suite.
 */
import { identity, usageRepo, withBusiness, sql } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { db, deps, stubSender, workerDb } from './meta-webhook.fixtures.js';

export const A_PHOTOGRAPHED_EXPENSE = {
  intent: 'RecordExpense',
  description: 'diesel',
  amount: 12_000,
  category: 'utilities',
  paymentMethod: 'cash',
};

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

export function arrangePhoto(bytes = Buffer.from('JFIF-fake-photo')) {
  stubSender.media.set('photo-1', { bytes, mimeType: 'image/jpeg' });
}

export const readsUsed = async (businessId: string) => {
  const rows = await withBusiness(db, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return rows.find((row) => row.unit === 'DOCUMENTS_UNDERSTOOD')?.used ?? 0;
};

/** The same jobs, run under a tighter daily document ceiling. */
export async function drainWithDailyLimit(limit: number) {
  const runner = buildRunner(workerDb, db, {
    ...deps,
    config: { ...deps.config, aiDocExtractionsPerBusinessPerDay: limit },
  });
  let worked = await runner.runOnce();
  while (worked) worked = await runner.runOnce();
}

/** What a view-only member's message must leave untouched (G-57). */
export async function g57Footprint(businessId: string) {
  const [row] = await withBusiness(db, businessId, (tx) =>
    tx.execute<Record<string, string>>(sql`
        SELECT
          (SELECT COALESCE(sum(used), 0) FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS') AS ai_actions,
          (SELECT COALESCE(sum(used), 0) FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND unit = 'DOCUMENTS_UNDERSTOOD') AS documents,
          (SELECT count(*) FROM command_drafts WHERE business_id = ${businessId}::uuid) AS drafts,
          (SELECT count(*) FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
          (SELECT count(*) FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
          (SELECT count(*) FROM ledger_transactions
            WHERE business_id = ${businessId}::uuid) AS postings`),
  );
  return Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)]));
}

export const NOTHING_TOUCHED = {
  ai_actions: 0,
  documents: 0,
  drafts: 0,
  invoices: 0,
  payments: 0,
  postings: 0,
};
