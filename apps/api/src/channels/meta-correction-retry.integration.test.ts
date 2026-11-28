/**
 * CG5 while an earlier message of the same business is still retrying: a clear correction of an
 * expense still replaces it, and a yes retried after the correction books nothing; a nameless
 * correction of a customer's sale withdraws that sale (OD-60, owner review of #437 at 49f2586).
 * Each retried job is checked to have finished before the books are read, so an empty book is the
 * retry's answer, never a job still waiting (CodeRabbit on #437 at 156621f). Moved from
 * `meta-correction-kind.integration.test.ts`, which is at the layout limit.
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

/** A job's state, read in its own business. */
const jobState = (businessId: string, jobId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string }>(sql`
      SELECT state FROM jobs WHERE business_id = ${businessId}::uuid AND id = ${jobId}::uuid`),
  ).then((rows) => rows[0]?.state ?? null);

describe('CG5: a correction while an earlier message is retrying', () => {
  it('an earlier question still retrying does not stop the correction', async () => {
    const { business } = await seedOwner();
    await send('fuel 5k cash', 'wamid.K7-EXP', expense(5_000));
    await queueOnly('wamid.K7-Q', 'how much did I sell this month?');
    await failOnceAndBackOff(business.id);

    await send('no, 6k not 5k', 'wamid.K7-FIX', expense(6_000));
    expect(stubSender.lastText).toContain(replies.correctionTaken().text);
    expect(await drafts(business.id)).toEqual([
      'RecordExpense:superseded',
      'RecordExpense:pending',
    ]);
  });

  it('a yes retried after the correction books nothing; the corrected expense is booked once', async () => {
    const { business } = await seedOwner();
    await send('fuel 5k cash', 'wamid.K8-EXP', expense(5_000));
    await queueOnly('wamid.K8-YES', 'yes');
    const retried = await failOnceAndBackOff(business.id);

    await send('no, 6k not 5k', 'wamid.K8-FIX', expense(6_000));
    expect(await drafts(business.id)).toEqual([
      'RecordExpense:superseded',
      'RecordExpense:pending',
    ]);
    await bringDue(business.id);
    await run();
    /* The retried yes ran to the end, so the empty books are its answer (CodeRabbit on #437 at
     * 156621f). */
    expect(await jobState(business.id, retried)).toBe('done');
    expect((await books(business.id)).expenses).toEqual([]);

    await send('yes', 'wamid.K8-YES2');
    expect((await books(business.id)).expenses).toEqual([600_000]);
  });
});

describe("CG5: a nameless correction of a customer's sale while a yes retries", () => {
  it('withdraws the sale and asks; the retried yes books nothing', async () => {
    const { business } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.K13-SALE', SALE);
    await queueOnly('wamid.K13-YES', 'yes');
    const retried = await failOnceAndBackOff(business.id);

    await send('No, 4 not 3', 'wamid.K13-FIX', {
      ...SALE,
      customer: { kind: 'none' },
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toBe(replies.correctionWithdrawn().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:superseded']);
    await bringDue(business.id);
    await run();
    expect(await jobState(business.id, retried)).toBe('done');
    expect(await books(business.id)).toEqual({ invoices: [], expenses: [] });
  });
});
