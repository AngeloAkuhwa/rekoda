/**
 * CG5: a correction mixed with another record is asked about, whether or not the waiting sale names
 * a customer (owner ruling OWN-102(2); CodeRabbit on #437 at 156621f). An anonymous waiting sale was
 * superseded before the mixed-instruction checks ran, so "No, 4 not 3. Sold 2 bags at 10k to
 * someone else" dropped the 2-bag sale and left a four-wig preview to confirm. Beside
 * `meta-correction-ambiguous.integration.test.ts`, which covers the same case for a named customer.
 */
import { describe, expect, it } from 'vitest';
import { identity, sql, withBusiness } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';

const SALE = {
  intent: 'RecordSale',
  customer: { kind: 'none' },
  items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
  statedTotal: 150_000,
  reportedPayment: 150_000,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
};
const FOUR = {
  ...SALE,
  items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
  statedTotal: 200_000,
  reportedPayment: 200_000,
};

async function send(text: string, wamid: string) {
  await post(messagePayload(OWNER, wamid, text));
  const runner = buildRunner(workerDb, db, deps);
  let worked = await runner.runOnce();
  expect(worked).toBe(true);
  while (worked) worked = await runner.runOnce();
}

const sales = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ id: string; state: string; command: unknown }>(
      sql`SELECT id, state, command FROM command_drafts
           WHERE business_id = ${businessId}::uuid AND intent = 'RecordSale'
           ORDER BY insertion_seq`,
    ),
  ).then((rows) => [...rows]);

const invoiceCount = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM invoices WHERE business_id = ${businessId}::uuid`,
    ),
  ).then((rows) => Number(rows[0]?.n ?? 0));

async function seedOwner() {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  return identity.createBusinessWithOwner(db, {
    name: 'Walk-in Wigs',
    businessType: null,
    ownerUserId: user.id,
  });
}

describe('CG5: an anonymous waiting sale and a correction mixed with another sale', () => {
  it('asks, and leaves the waiting sale exactly as it was', async () => {
    const business = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Sold 3 wigs for 150k, paid transfer', 'wamid.AM-SALE');
    const before = await sales(business.id);
    expect(before.map((r) => r.state)).toEqual(['pending']);

    stubTransport.replyWith(FOUR);
    const sent = stubSender.sent.length;
    await send('No, 4 not 3. Sold 2 bags at 10k to someone else', 'wamid.AM-FIX');
    expect(stubSender.sent.length).toBe(sent + 1);
    /* Nothing replaced: the same draft, the same command, and no second draft to confirm. */
    expect(await sales(business.id)).toEqual(before);
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('still lets a plain correction supersede it', async () => {
    const business = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Sold 3 wigs for 150k, paid transfer', 'wamid.AP-SALE');
    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.AP-FIX');
    const rows = await sales(business.id);
    expect(rows.map((r) => r.state)).toEqual(['superseded', 'pending']);
    expect((rows[1]?.command as { items: { quantity: number }[] }).items[0]?.quantity).toBe(4);
  });
});
