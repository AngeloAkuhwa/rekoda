/**
 * Shared helpers for the customer-token suites (G-135, G-137; owner review of #437): one merchant,
 * a message with the model's answer scripted, and the database footprint and plaintext search the
 * suites assert after every message.
 */
import { identity, sql, withBusiness } from '@rekoda/db';
import { db, messagePayload, post, stubTransport } from './meta-webhook.fixtures.js';
import { drain } from './meta-voice-note.fixtures.js';

export const OWNER = '2348031234567';
export const DELEGATE = '2348035550000';

export async function seedMerchant() {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  return identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
}

export async function say(wamid: string, command: unknown, text: string) {
  stubTransport.replyWith(command);
  await post(messagePayload(OWNER, wamid, text));
  await drain();
}

export async function plain(wamid: string, text: string) {
  await post(messagePayload(OWNER, wamid, text));
  await drain();
}

export const footprint = (businessId: string) =>
  withBusiness(db, businessId, async (tx) => {
    const [row] = [
      ...(await tx.execute<{
        customers: number;
        drafts: number;
        invoices: number;
        payments: number;
      }>(sql`
        SELECT (SELECT count(*)::int FROM customers WHERE business_id = ${businessId}::uuid) AS customers,
               (SELECT count(*)::int FROM command_drafts
                 WHERE business_id = ${businessId}::uuid AND intent NOT IN ('Query', 'Unclear')) AS drafts,
               (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
               (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}::uuid) AS payments`)),
    ];
    return row!;
  });

export const sale = (customer: Record<string, unknown>) => ({
  intent: 'RecordSale',
  customer,
  items: [{ name: 'wig', quantity: 2, unitPrice: 50_000 }],
  statedTotal: 100_000,
  reportedPayment: 0,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
});

export const payment = (customer: Record<string, unknown>) => ({
  intent: 'RecordPayment',
  customer,
  amount: 20_000,
  relativeAmount: null,
  documentRef: null,
  paymentMethod: 'cash',
});

export const balanceOf = (customer: Record<string, unknown> | null) => ({
  intent: 'Query',
  topic: 'customer_balance',
  customer,
  period: 'month',
  periodText: null,
  format: 'chat',
});

export const lastModelText = () => stubTransport.requests.at(-1)?.userText ?? '';

/** Every phone or email identity this business holds, by facet. */
export const identitiesOf = (businessId: string) =>
  withBusiness(db, businessId, async (tx) =>
    [
      ...(await tx.execute<{ facet: string }>(sql`
        SELECT facet FROM customer_identities
         WHERE business_id = ${businessId}::uuid AND facet IN ('phone', 'email')
         ORDER BY facet`)),
    ].map((r) => r.facet),
  );

/**
 * The tables a record's words reach, each searched as text for every needle: the
 * books (expenses, invoices, their items, payments, the ledger), the drafts, the
 * conversation history, orders and suppliers. Names the tables holding a needle.
 */
export async function plaintextIn(
  businessId: string,
  needles: readonly string[],
): Promise<string[]> {
  const tables = [
    'expenses',
    'invoices',
    'invoice_items',
    'payments',
    'ledger_transactions',
    'ledger_entries',
    'command_drafts',
    'conversation_messages',
    'orders',
    'suppliers',
  ];
  const found: string[] = [];
  await withBusiness(db, businessId, async (tx) => {
    for (const table of tables) {
      for (const needle of needles) {
        const [row] = [
          ...(await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} t
                 WHERE t.business_id = ${businessId}::uuid
                   AND t::text LIKE ${'%' + needle + '%'}`,
          )),
        ];
        if ((row?.n ?? 0) > 0) found.push(`${table}:${needle}`);
      }
    }
  });
  return found;
}
