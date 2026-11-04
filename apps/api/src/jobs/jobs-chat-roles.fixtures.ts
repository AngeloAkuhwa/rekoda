/**
 * Shared helpers for the chat-role suites (jobs-chat-roles-*.integration.test.ts), split from
 * jobs.integration.test.ts: adding a member, sending a message over chat and the commands the
 * tests send. Helpers that use the owner connection stay in each suite that uses them.
 */
import { randomBytes } from 'node:crypto';
import { identity } from '@rekoda/db';
import { storedEventId } from '@rekoda/db/testing';
import { buildRunner } from './jobs.module.js';
import { sealPayload } from '../privacy/payload-vault.js';
import {
  appDb,
  config,
  deps,
  enqueue,
  recordPinned,
  stubSender,
  workerDb,
} from './jobs.fixtures.js';

/**
 * The dashboard has RolesGuard; chat has only this handler. An accountant
 * is inside the tenant, so RLS passes every row — the refusal below is the
 * only thing standing between a view-only member and the books.
 */
export async function memberOf(
  businessId: string,
  phone: string,
  role: 'accountant' | 'delegate',
): Promise<void> {
  await identity.inviteMember(appDb, businessId, phone, role, 3, 'user:test-owner');
}

export async function saysOverChat(
  businessId: string,
  phone: string,
  text: string,
): Promise<string> {
  const externalId = `wamid.${randomBytes(8).toString('hex')}`;
  const waId = phone.replace('+', '');
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
              contacts: [{ profile: { name: 'X' }, wa_id: waId }],
              messages: [
                {
                  id: externalId,
                  from: waId,
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const recorded = await recordPinned({
    provider: 'meta',
    eventType: 'message.text',
    externalId,
    payload: sealPayload(body, config.vaultKey, 'meta', externalId),
    businessId,
  });
  await enqueue(businessId, 'inbound.message', { eventId: storedEventId(recorded) });
  const runner = buildRunner(workerDb, appDb, deps);
  await runner.runOnce();
  return stubSender.sent[stubSender.sent.length - 1]?.text ?? '';
}

export const ZERO = {
  modelCalls: 0,
  ai_actions: 0,
  usage_events: 0,
  cost_events: 0,
  drafts: 0,
  invoices: 0,
  payments: 0,
  postings: 0,
  stock_moves: 0,
};

export const A_SALE = {
  intent: 'RecordSale',
  customer: { kind: 'none' },
  items: [{ name: 'rice', quantity: 1, unitPrice: 20_000 }],
  statedTotal: 20_000,
  reportedPayment: 20_000,
  paymentMethod: 'cash',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
};

export const A_SALES_QUESTION = {
  intent: 'Query',
  topic: 'sales_summary',
  customer: null,
  period: 'month',
  periodText: null,
  format: 'chat',
};
