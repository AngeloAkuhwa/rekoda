/**
 * Shared helpers for the meta-voice-note suites, split from meta.integration.test.ts.
 * The helpers that hold state or write the plan stay in each suite.
 */
import { identity, usageRepo, withBusiness, sql } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { db, deps, stubSender, workerDb } from './meta-webhook.fixtures.js';

export const A_SPOKEN_SALE = {
  intent: 'RecordSale',
  customer: { kind: 'token', token: 'CUSTOMER_7K2' },
  items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
  statedTotal: 150_000,
  reportedPayment: 0,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
};

export function voicePayload(waId: string, wamid: string, mediaId = 'media-1') {
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
              messages: [
                {
                  id: wamid,
                  from: waId,
                  timestamp: '1700000000',
                  type: 'audio',
                  audio: { id: mediaId, mime_type: 'audio/ogg', voice: true },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

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

/**
 * Audio the provider will hand back for `media-1`, of a REAL length.
 *
 * A single Ogg page whose granule position says how many samples it holds,
 * at Opus's 48 kHz. It has to be measurable now: the handler reads the
 * duration out of these bytes before it calls anything, so a placeholder
 * buffer is no longer a voice note, it is an unreadable file.
 */
export function arrangeAudio(seconds = 5) {
  stubSender.media.set('media-1', { bytes: oggOf(seconds), mimeType: 'audio/ogg' });
}

export function oggOf(seconds: number): Buffer {
  const page = Buffer.alloc(28);
  page.write('OggS', 0, 'ascii');
  page.writeBigUInt64LE(BigInt(seconds * 48_000), 6);
  page.writeUInt32LE(1, 14);
  page.writeUInt8(1, 26);
  return page;
}

export const voiceUsed = async (businessId: string) => {
  const rows = await withBusiness(db, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return rows.find((row) => row.unit === 'VOICE_MINUTES')?.used ?? 0;
};

export const unitUsed = async (businessId: string, unit: string) => {
  const rows = await withBusiness(db, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return rows.find((row) => row.unit === unit)?.used ?? 0;
};

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

export async function accountantOn(businessId: string) {
  const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
  await identity.addMembership(db, businessId, accountant.id, 'accountant');
}
