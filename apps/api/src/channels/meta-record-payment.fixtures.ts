/**
 * Shared helpers for the meta-record-payment suites, split from meta.integration.test.ts.
 * The helpers that hold state or write the plan stay in each suite.
 */
import { identity } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import { customersRepo } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  post,
  stubTransport,
  workerDb,
} from './meta-webhook.fixtures.js';

export const A_SALE_FOR_PAYMENT = {
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

export const paymentOf = (over: Record<string, unknown>) => ({
  intent: 'RecordPayment',
  customer: { kind: 'token', token: 'CUSTOMER_7K2' },
  amount: null,
  relativeAmount: null,
  documentRef: null,
  paymentMethod: 'cash',
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

/** Work the queue to empty, as a real worker does: issuing enqueues renders. */
export async function drain() {
  const runner = buildRunner(workerDb, db, deps);
  let worked = await runner.runOnce();
  while (worked) worked = await runner.runOnce();
}

/** Issue a ₦150,000 invoice with nothing paid, through the chat path. */
export async function issueUnpaidInvoice(wamid: string) {
  stubTransport.replyWith(A_SALE_FOR_PAYMENT);
  await post(messagePayload('2348031234567', `${wamid}-sale`, 'Ada bought 3 wigs for 150k'));
  await drain();
  await post(messagePayload('2348031234567', `${wamid}-yes`, 'yes'));
  await drain();
}

/** G-49: the chat invoice names a customer on file, so the excess is theirs. */
export async function issueUnpaidInvoiceToCustomer(businessId: string, wamid: string) {
  await customersRepo.createCustomerWithIdentities(db, businessId, 'CUSTOMER_7K2', [
    { facet: 'phone', ciphertext: 'sealed-phone', matchKey: `mk-${wamid}` },
  ]);
  await issueUnpaidInvoice(wamid);
}

/** Units used of one kind, or zero before the counter row exists. */
export const usedOf = (rows: Array<{ unit: string; used: number }>, unit: string) =>
  rows.find((r) => r.unit === unit)?.used ?? 0;
