/**
 * CG5 inherits a customer only when nothing came between the preview and the correction
 * (OWN-100). A message that came between them but is still retrying after a failure has no
 * conversation row yet, so `hasInboundBetween` cannot see it; the queue can. While an earlier
 * inbound message is still live, the correction is asked about and changes nothing: the safe
 * reading of an ambiguity the job cannot resolve (owner review of #437 at 49f2586).
 */
import { describe, expect, it } from 'vitest';
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
import { failOnceAndBackOff, queueOnly } from './meta-lost-message.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';

const SALE = {
  intent: 'RecordSale',
  customer: { kind: 'token', token: 'CUSTOMER_7K2' },
  items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
  statedTotal: 150_000,
  reportedPayment: 100_000,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
};
const FOUR = {
  ...SALE,
  customer: { kind: 'none' },
  items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
  statedTotal: 200_000,
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
    tx.execute<{ state: string; customer: unknown }>(
      sql`SELECT state, command->'customer' AS customer FROM command_drafts
           WHERE business_id = ${businessId}::uuid AND intent = 'RecordSale'
           ORDER BY insertion_seq`,
    ),
  ).then((rows) => [...rows]);

describe('CG5: a correction sent while an earlier message is still retrying', () => {
  it('is asked about, and the waiting preview keeps its customer', async () => {
    const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const ada = await knownCustomer(business.id);
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.R1-SALE');

    /* A question after the preview fails once and backs off: it has no conversation row yet. */
    await queueOnly('wamid.R1-Q', 'how much did I sell this month?');
    await failOnceAndBackOff(business.id);

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.R1-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    const rows = await sales(business.id);
    expect(rows.map((r) => r.state)).toEqual(['pending']);
    expect(rows[0]?.customer).toEqual({ kind: 'token', token: ada.token });
  });
});
