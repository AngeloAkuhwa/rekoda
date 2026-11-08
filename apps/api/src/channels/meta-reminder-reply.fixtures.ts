/**
 * Shared helpers for the reminder-reply suites (OWN-83): a business on its own WhatsApp number with
 * one customer and one unpaid invoice, a WhatsApp reminder for it, and a customer reply driven
 * through the real webhook and job runner. Split from meta-reminder-reply.integration.test.ts so
 * the delivery-receipt suite can use them too.
 */
import { expect } from 'vitest';
import {
  billingRepo,
  conversationsRepo,
  customersRepo,
  identity,
  remindersRepo,
  sql,
  wabaRepo,
  withBusiness,
} from '@rekoda/db';
import type { issueRepo } from '@rekoda/db';
import { encryptFacet, matchKeyFor, normaliseFacet } from '@rekoda/core/vault';
import { buildRunner } from '../jobs/jobs.module.js';
import { db, deps, messagePayload, post, stubSender, workerDb } from './meta-webhook.fixtures.js';

export const CUSTOMER_WA = '2349097778888';
/** The blind index the privacy gateway stores on a customer phone. */
export const phoneKey = (businessId: string, phone: string) =>
  matchKeyFor(businessId, 'phone', normaliseFacet('phone', phone), deps.config.matchKey);
let seq = 0;
/** A fresh number for ids that must not collide between tests. */
export const nextSeq = () => (seq += 1);

export interface Shop {
  businessId: string;
  ownerPhone: string;
  ownerId: string;
  invoiceNumber: string;
  invoiceId: string;
  customerId: string;
}

/** The owner writes to Rekoda's number, which opens their 24-hour window for free-form notices. */
export const ownerWrites = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: 'who owes me',
      providerMessageId: `wamid.owner-${businessId.slice(0, 8)}-${(seq += 1)}`,
    }),
  );

/* Sales are issued through a writer the TEST FILE passes in: financial writers stay out of
 * fixtures (check-boundaries exempts only *.test.ts). */
let saleWriter: typeof issueRepo.issueSale | null = null;
/** Sets the sale writer `shop()` uses; each test file passes `issueRepo.issueSale`. */
export function useSaleWriter(writer: typeof issueRepo.issueSale): void {
  saleWriter = writer;
}

/**
 * A business on its own WhatsApp number, one customer on `CUSTOMER_WA`, one unpaid invoice. The
 * owner has written to Rekoda today unless `ownerWrote` is false.
 */
export async function shop(
  phoneNumberId: string,
  opts: { name?: string; assistant?: boolean; ownerWrote?: boolean } = {},
): Promise<Shop> {
  seq += 1;
  const ownerPhone = `+23480300033${String(seq).padStart(2, '0')}`;
  const owner = await identity.upsertUserByPhone(db, ownerPhone);
  const business = await identity.createBusinessWithOwner(db, {
    name: opts.name ?? 'Ada Fashion',
    businessType: null,
    ownerUserId: owner.id,
  });
  const businessId = business.id;
  await billingRepo.setPlan(db, { businessId, plan: 'complete', expiresAt: null, actor: 'test' });
  await withBusiness(db, businessId, async (tx) => {
    await wabaRepo.connectWaba(tx, {
      businessId,
      wabaId: `waba-${phoneNumberId}`,
      phoneNumberId,
      accessTokenCipher: encryptFacet(
        'EAAG-merchant-token',
        deps.config.connectionKey,
        `${businessId}:waba_token`,
      ),
      tokenTail: '4821',
    });
    await wabaRepo.setAssistantSettings(tx, businessId, {
      enabled: opts.assistant ?? false,
      dailyReplyLimit: 3,
    });
  });
  if (opts.ownerWrote ?? true) await ownerWrites(businessId);
  const customer = await customersRepo.createCustomerWithIdentities(db, businessId, `R${seq}`, [
    {
      facet: 'phone',
      ciphertext: encryptFacet(`+${CUSTOMER_WA}`, deps.config.vaultKey, `${businessId}:phone`),
      // Keyed as the privacy gateway keys every customer phone it stores.
      matchKey: phoneKey(businessId, `+${CUSTOMER_WA}`),
    },
  ]);
  const issueSale = saleWriter;
  if (!issueSale) throw new Error('call useSaleWriter(issueRepo.issueSale) in the test file');
  const sale = await withBusiness(db, businessId, (tx) =>
    issueSale(tx, {
      businessId,
      customerId: customer.id,
      customerToken: `CUSTOMER_R${seq}`,
      items: [{ name: 'gown', quantity: 1, unitPriceK: 4_500_000 }],
      subtotalK: 4_500_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 4_500_000,
      paidK: 0,
      balanceDueK: 4_500_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-reply-${seq}`,
      actor: 'system',
    }),
  );
  return {
    businessId,
    ownerPhone,
    ownerId: owner.id,
    invoiceNumber: sale.invoiceNumber,
    invoiceId: sale.invoiceId,
    customerId: customer.id,
  };
}

/** A WhatsApp reminder for the shop's invoice, recorded as the reminder service records one. */
export async function reminded(s: Shop, status: 'sent' | 'blocked' = 'sent'): Promise<string> {
  return withBusiness(db, s.businessId, async (tx) => {
    const id = await remindersRepo.startReminder(tx, {
      businessId: s.businessId,
      invoiceId: s.invoiceId,
      customerId: s.customerId,
      channel: 'whatsapp',
      idempotencyKey: `reply-test-${s.businessId.slice(0, 8)}-${(seq += 1)}`,
      balanceK: 4_500_000,
      attestationId: null,
      userId: s.ownerId,
    });
    await remindersRepo.finishReminder(
      tx,
      s.businessId,
      id!,
      status,
      status === 'sent' ? null : 'window_closed_no_template',
    );
    return id!;
  });
}

/** The customer on `CUSTOMER_WA` writes to the business's number; every job queued is run. */
export const reply = async (phoneNumberId: string, wamid: string, text: string) => {
  expect((await post(messagePayload(CUSTOMER_WA, wamid, text, phoneNumberId))).statusCode).toBe(
    200,
  );
  while (await buildRunner(workerDb, db, deps).runOnce()) {
    /* drain: every job this webhook queued */
  }
};

/** The reminder-reply notices the stub sender sent to `phone`. */
export const noticesTo = (phone: string) =>
  stubSender.sent.filter(
    (m) => m.to === phone && m.text.includes('has sent your business a WhatsApp'),
  );

/** The business's recorded reminder-reply notices. */
export const noticeRows = (businessId: string) =>
  withBusiness(db, businessId, async (tx) => [
    ...(await tx.execute<{ reminder_id: string }>(
      sql`SELECT reminder_id FROM reminder_reply_notices`,
    )),
  ]);
