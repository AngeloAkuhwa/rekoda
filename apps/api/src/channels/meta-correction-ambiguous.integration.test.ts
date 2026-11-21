/**
 * CG5 inherits a customer only when the correction is unambiguous (OWN-100). Beside
 * `meta-correction-customer.integration.test.ts`, which is at the layout limit.
 *
 * A message that came between the preview and the correction but is still retrying after a
 * failure has no conversation row yet, so `hasInboundBetween` cannot see it; the queue can.
 * While an earlier inbound message of the same business is pending or running, the correction
 * is asked about and changes nothing. Another business's queue never counts, a message that
 * died retires the preview (OWN-74), and a correction mixed with a new sale is asked about
 * (owner review of #437 at 49f2586).
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
import {
  asTenant,
  failOnceAndBackOff,
  killInboundJob,
  queueOnly,
} from './meta-lost-message.fixtures.js';

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

async function send(text: string, wamid: string, from = OWNER) {
  await post(messagePayload(from, wamid, text));
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

async function seedOwner(phone = OWNER, name = 'Ada Fashion') {
  const user = await identity.upsertUserByPhone(db, `+${phone}`);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return { business, ada: await knownCustomer(business.id) };
}

/** Ada's preview is waiting, untouched, and still names her. */
async function expectAdaUntouched(businessId: string, adaToken: string) {
  const rows = await sales(businessId);
  expect(rows.map((r) => r.state)).toEqual(['pending']);
  expect(rows[0]?.customer).toEqual({ kind: 'token', token: adaToken });
}

describe('CG5: a correction sent while an earlier message is still live', () => {
  it('is asked about while the earlier message backs off, and the preview keeps its customer', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.R1-SALE');

    /* A question after the preview fails once and backs off: it has no conversation row yet. */
    await queueOnly('wamid.R1-Q', 'how much did I sell this month?');
    await failOnceAndBackOff(business.id);

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.R1-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    await expectAdaUntouched(business.id, ada.token);
  });

  it('waits while the earlier message is running in another lane, and changes nothing', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.R2-SALE');
    await queueOnly('wamid.R2-Q', 'how much did I sell this month?');
    /* Claimed by a lane that has not committed anything yet (as the owner: the worker's column). */
    await asTenant(
      business.id,
      sql`UPDATE jobs SET state = 'running', attempts = 1, locked_by = 'other-lane',
                          locked_at = now()
           WHERE business_id = ${business.id}::uuid AND state = 'pending'`,
    );

    stubTransport.replyWith(FOUR);
    const asked = stubTransport.requests.length;
    await send('No, 4 not 3', 'wamid.R2-FIX');
    /* The queue orders it first (`hasEarlierLiveJob`): the correction steps back, unread. */
    expect(stubTransport.requests).toHaveLength(asked);
    await expectAdaUntouched(business.id, ada.token);
    const waiting = await asTenant(
      business.id,
      sql`SELECT count(*)::int AS n FROM jobs
           WHERE business_id = ${business.id}::uuid AND kind = 'inbound.message' AND state = 'pending'`,
    );
    expect([...waiting][0]).toEqual({ n: 1 });
  });

  it("another business's retrying message never blocks this one's correction", async () => {
    const { business, ada } = await seedOwner();
    const other = await seedOwner('2348035550000', 'Other Shop');
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.R3-SALE');
    await queueOnly('wamid.R3-Q', 'how much did I sell this month?', '2348035550000');
    await failOnceAndBackOff(other.business.id);

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.R3-FIX');
    expect(stubSender.lastText).toContain('The same customer as before');
    const rows = await sales(business.id);
    expect(rows.map((r) => r.state)).toEqual(['superseded', 'pending']);
    expect(rows[1]?.customer).toEqual({ kind: 'token', token: ada.token });
  });

  it('a message that died in between retires the preview, so nothing is inherited', async () => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.R4-SALE');
    await queueOnly('wamid.R4-Q', 'cancel');
    await killInboundJob(business.id, 'markFailed');

    stubTransport.replyWith(FOUR);
    await send('No, 4 not 3', 'wamid.R4-FIX');
    /* OWN-74: the preview pending when the lost message arrived is withdrawn, never confirmable,
     * and no draft of this business names Ada any more except that withdrawn one. */
    const rows = await sales(business.id);
    expect(rows[0]?.state).not.toBe('pending');
    const live = rows.filter((r) => r.state === 'pending');
    expect(
      live.every(
        (r) => JSON.stringify(r.customer) !== JSON.stringify({ kind: 'token', token: ada.token }),
      ),
    ).toBe(true);
  });
});

describe('CG5: a correction mixed with another instruction', () => {
  it.each([
    'No, 4 not 3, and I also sold 2 bags for 20k',
    'No, 4 not 3. Sold 2 bags at 10k to someone else',
  ])('%j is asked about and the preview keeps its customer', async (text) => {
    const { business, ada } = await seedOwner();
    stubTransport.replyWith(SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.M-SALE');
    stubTransport.replyWith(FOUR);
    await send(text, 'wamid.M-FIX');
    expect(stubSender.lastText).toContain('I could not tell which customer');
    await expectAdaUntouched(business.id, ada.token);
  });
});
