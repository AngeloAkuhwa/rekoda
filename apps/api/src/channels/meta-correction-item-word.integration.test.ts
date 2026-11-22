/**
 * CG5, an item word in a correction (OD-63(a) Option B, owner ruling OWN-102(3), 22 Nov 2026). Split
 * from `meta-correction-kind.integration.test.ts` by concern; the same fixtures.
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { identity, sql, withBusiness } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  knownCustomer,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import { bringDue, failOnceAndBackOff, queueOnly } from './meta-lost-message.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';
const MEMBER = '2348035550000';

const SALE = {
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
const expense = (amount: number) => ({
  intent: 'RecordExpense',
  description: 'fuel for generator',
  amount,
  category: 'utilities',
  paymentMethod: 'cash',
});
const purchase = (amount: number) => ({
  intent: 'RecordPurchase',
  supplierMention: 'Mama Nkechi',
  description: 'ankara fabric',
  amount,
  reportedPayment: amount,
  paymentMethod: 'cash',
  productMention: null,
  quantity: null,
});

async function run() {
  const runner = buildRunner(workerDb, db, deps);
  while (await runner.runOnce()) {
    /* keep going */
  }
}

async function send(text: string, wamid: string, reading?: unknown, from = OWNER) {
  if (reading) stubTransport.replyWith(reading);
  await post(messagePayload(from, wamid, text));
  await run();
}

async function seedOwner() {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return { business, ada: await knownCustomer(business.id) };
}

/** Every record draft, oldest first, as "<intent>:<state>". */
const drafts = async (businessId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{ intent: string; state: string }>(sql`
        SELECT intent, state FROM command_drafts
         WHERE business_id = ${businessId}::uuid AND intent NOT IN ('Query', 'Unclear')
         ORDER BY insertion_seq`),
    )),
  ].map((r) => `${r.intent}:${r.state}`);

/** What the books hold: invoices with their customer, and expenses by amount. */
const books = (businessId: string) =>
  withBusiness(db, businessId, async (tx) => ({
    invoices: [
      ...(await tx.execute<{ customer_id: string | null; total_k: number }>(sql`
        SELECT customer_id, total_k::int AS total_k FROM invoices
         WHERE business_id = ${businessId}::uuid ORDER BY created_at`)),
    ],
    expenses: [
      ...(await tx.execute<{ amount_k: number }>(sql`
        SELECT amount_k::int AS amount_k FROM expenses
         WHERE business_id = ${businessId}::uuid ORDER BY created_at`)),
    ].map((r) => r.amount_k),
  }));

/**
 * OD-63(a) Option B (owner ruling 22 Nov 2026): the bare item word never explains a correction,
 * because an item may be named like a person nobody recorded. "4 Tunde not 3" for a Tunde item is
 * asked about and never keeps Ada; a plural ("make it 4 wigs") still does. Every confirmed invoice's
 * own customer is checked.
 */
describe('CG5: an item word in a correction (OD-63(a) Option B)', () => {
  const TUNDE_ITEM = { ...SALE, items: [{ name: 'Tunde', quantity: 3, unitPrice: 50_000 }] };

  it('"4 Tunde not 3" with nobody recorded as Tunde is asked about; Ada keeps only her sale', async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 Tunde for 150k', 'wamid.TB1-SALE', TUNDE_ITEM);

    await send('4 Tunde not 3', 'wamid.TB1-FIX', {
      ...TUNDE_ITEM,
      customer: { kind: 'none' },
      items: [{ name: 'Tunde', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toBe(replies.correctionCustomerNotClear().text);
    expect(stubSender.lastText).not.toContain('The same customer as before');
    expect(await drafts(business.id)).toEqual(['RecordSale:pending']);

    await send('yes', 'wamid.TB1-YES1');
    /* The first yes answers the refusal and books nothing (CodeRabbit on #437 at 88258dc). */
    expect((await books(business.id)).invoices).toEqual([]);
    await send('yes', 'wamid.TB1-YES2');
    expect(await books(business.id)).toEqual({
      invoices: [{ customer_id: ada.id, total_k: 15_000_000 }],
      expenses: [],
    });
  });

  it('"make it 4 wig" names only the bare item word, so it is asked about', async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.TB2-SALE', SALE);

    await send('make it 4 wig', 'wamid.TB2-FIX', {
      ...SALE,
      customer: { kind: 'none' },
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toBe(replies.correctionCustomerNotClear().text);
    await send('yes', 'wamid.TB2-YES1');
    /* The first yes answers the refusal and books nothing (CodeRabbit on #437 at 88258dc). */
    expect((await books(business.id)).invoices).toEqual([]);
    await send('yes', 'wamid.TB2-YES2');
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: ada.id, total_k: 15_000_000 },
    ]);
  });

  it('"make it 4 wigs" keeps Ada, and the corrected invoice is hers', async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.TB3-SALE', SALE);

    await send('make it 4 wigs', 'wamid.TB3-FIX', {
      ...SALE,
      customer: { kind: 'none' },
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toContain('The same customer as before');
    await send('yes', 'wamid.TB3-YES');
    await send('yes', 'wamid.TB3-YES2');
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: ada.id, total_k: 20_000_000 },
    ]);
  });

  it("a correction carrying another customer's token is refused and books nothing new", async () => {
    const { business, ada } = await seedOwner();
    await knownCustomer(business.id, 'Bola', 'CUSTOMER_9BL');
    await send('Ada bought 3 wigs for 150k', 'wamid.TB4-SALE', SALE);

    await send('make it 4 wigs', 'wamid.TB4-FIX', {
      ...SALE,
      customer: { kind: 'token', token: 'CUSTOMER_9BL' },
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toContain('could not tell which customer');
    await send('yes', 'wamid.TB4-YES1');
    /* The first yes answers the refusal and books nothing (CodeRabbit on #437 at 88258dc). */
    expect((await books(business.id)).invoices).toEqual([]);
    await send('yes', 'wamid.TB4-YES2');
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: ada.id, total_k: 15_000_000 },
    ]);
  });
});

/* A figure in seconds is a time, never a correction of the waiting expense (CodeRabbit on #437 at
 * cf96697): the preview stays, and nothing is booked. */
describe('a seconds-only message beside a waiting expense', () => {
  it('never replaces the shown preview', async () => {
    const { business } = await seedOwner();
    await send('fuel 6k', 'wamid.SEC-EXP', expense(6_000));

    await send('make it 5 seconds', 'wamid.SEC-FIX', expense(5_000));
    expect(stubSender.lastText).not.toContain(replies.correctionTaken().text);
    expect((await drafts(business.id))[0]).toBe('RecordExpense:pending');
  });
});
