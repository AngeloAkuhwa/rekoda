/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a preview has a time limit (G-23) (part 3 of 3). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { createDb, withBusiness, sql, type Db } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { customersRepo } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  urls,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import {
  A_SALE,
  seedMerchant,
  drain,
  say,
  plain,
  lapse,
  states,
  footprint,
  used,
} from './meta-preview-expiry.fixtures.js';

useMetaWebhookHarness();

/**
 * Attempt 1 of the next "yes" meters, claims, then fails issuing (a
 * fail-once trigger on invoices): the job rolls back and is retried later,
 * so other messages can be handled before it. Test-scoped, on the owner.
 */
async function withFirstInvoiceFailing(run: (owner: Db) => Promise<void>) {
  const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
  try {
    await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_once`);
    await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_once') = 1 THEN RAISE EXCEPTION 'g23: first attempt fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
    await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_once BEFORE INSERT ON invoices
          FOR EACH ROW EXECUTE FUNCTION g23_fail_once()`);
    await run(ownerDb);
  } finally {
    await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_once ON invoices`);
    await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_once()`);
    await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_once`);
    await close();
  }
}

/** Push every job still waiting for this business an hour out. */
const holdRetries = (owner: Db, businessId: string) =>
  owner.execute(sql`
      UPDATE jobs SET run_at = now() + interval '1 hour'
       WHERE business_id = ${businessId}::uuid AND state <> 'done'`);

/** Make every job still waiting for this business due now. */
const runRetriesNow = (owner: Db, businessId: string) =>
  owner.execute(sql`
      UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);

/**
 * A preview has a time limit (G-23, migration 0153).
 *
 * A "yes" executes a preview only inside its confirmation window. Monday's
 * preview answered on Thursday records nothing, costs nothing, and the
 * merchant is told it expired and to send it again. Time is moved by closing
 * the window in the database (`expires_at` set into the past), never by
 * sleeping; the boundary instant itself is pinned in draft-expiry.
 */
describe('a preview has a time limit (G-23)', () => {
  it('a retried yes whose draft a correction superseded while it waited gives the unit back', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-sup1', A_SALE, 'sold Ada 3 wigs for 300k');

    await withFirstInvoiceFailing(async (owner) => {
      await post(messagePayload('2348031234567', 'wamid.G23-sup1-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      expect((await used(business.id)).documents).toBe(1);
      await holdRetries(owner, business.id);

      /* The merchant corrects it before the retry runs. */
      await say(
        'wamid.G23-sup2',
        {
          ...A_SALE,
          items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
          statedTotal: 400_000,
        },
        'sorry, 4 wigs not 3',
      );
      expect(await states(business.id)).toEqual(['superseded', 'pending']);

      await runRetriesNow(owner, business.id);
      await drain();
    });

    /* Nothing issued for that yes, and the unit its first attempt took is back. */
    expect((await footprint(business.id)).invoices).toBe(0);
    expect((await used(business.id)).documents).toBe(0);
    expect(stubSender.lastText).toBe(replies.previewAwaitingYes().text);

    /* The corrected preview is confirmed by the next yes, charged once. */
    await plain('wamid.G23-sup2-yes', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);
    expect((await used(business.id)).documents).toBe(1);
  });

  it('a yes queued behind a correction, retried, refunds nothing it never reserved', async () => {
    const business = await seedMerchant();
    /* One real sale, so the counter holds a unit a wrong refund would take. */
    await say('wamid.G23-q0', A_SALE, 'sold Ada 3 wigs for 300k');
    await plain('wamid.G23-q0-yes', 'yes');
    expect((await used(business.id)).documents).toBe(1);
    await say('wamid.G23-q1', A_SALE, 'sold Ada 3 more wigs for 300k');

    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      /* The yes's answer fails to be recorded once, so its job is retried. */
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_ptr_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_ptr_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_ptr_once') = 1 THEN RAISE EXCEPTION 'g23: answer fails once'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_ptr_once BEFORE INSERT ON conversation_messages
          FOR EACH ROW WHEN (NEW.direction = 'outbound' AND NEW.body LIKE 'I sent you a preview%')
          EXECUTE FUNCTION g23_fail_ptr_once()`);

      /* The correction reaches Rekoda first, the yes after; both queue, and
       * the correction is handled (superseding the draft) after the yes had
       * already arrived. The yes meters nothing: there is nothing for it. */
      stubTransport.replyWith({
        ...A_SALE,
        items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
        statedTotal: 400_000,
      });
      await post(messagePayload('2348031234567', 'wamid.G23-q2', 'sorry, 4 wigs not 3'));
      await post(messagePayload('2348031234567', 'wamid.G23-q2-yes', 'yes'));
      await drain();
      await runRetriesNow(ownerDb, business.id);
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_ptr_once ON conversation_messages`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_ptr_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_ptr_once`);
      await close();
    }

    expect(stubSender.lastText).toBe(replies.previewAwaitingYes().text);
    /* Still the one unit the real sale cost: nothing reserved, nothing back. */
    expect((await used(business.id)).documents).toBe(1);
    expect((await footprint(business.id)).invoices).toBe(1);
  });

  it('a lapsed clarification was never a preview: a later yes or no is not told it expired', async () => {
    const business = await seedMerchant();
    await say(
      'wamid.G23-unclear',
      { intent: 'Unclear', clarification: 'How many wigs?' },
      'sold some wigs',
    );
    expect(stubSender.lastText).toContain('How many wigs?');
    await lapse(business.id);

    await plain('wamid.G23-unclear-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    const before = stubSender.sent.length;
    await plain('wamid.G23-unclear-no', 'no');
    expect(stubSender.sent.slice(before).map((m) => m.text)).not.toContain(
      replies.expiredNothingToCancel().text,
    );
  });

  it('an expired erasure ask answered yes or no says nothing was deleted, never "saved"', async () => {
    const business = await seedMerchant();
    await plain('wamid.G23-ex-del', 'delete my data');
    await lapse(business.id);
    await plain('wamid.G23-ex-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.erasureKept().text);
    await plain('wamid.G23-ex-no', 'no');
    expect(stubSender.lastText).toBe(replies.erasureKept().text);
    expect(await states(business.id)).toEqual(['expired']);
  });

  it('a second erasure ask after the first ask expired deletes nothing and asks again', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g23-erase' }],
    );
    const facets = () =>
      withBusiness(db, business.id, (tx) =>
        customersRepo.identityFacetsFor(tx, business.id, customer.id),
      );

    await plain('wamid.G23-del1', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    await lapse(business.id);

    /* Too late to be the confirmation: it is a new first ask. */
    await plain('wamid.G23-del2', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    expect(await facets()).toHaveLength(1);
    expect(await states(business.id)).toEqual(['expired', 'pending']);

    /* Inside the new window, the exact phrase erases, as it always has. */
    await plain('wamid.G23-del3', 'delete my data');
    expect(stubSender.lastText).toContain('deleted (1 record)');
    expect(await facets()).toEqual([]);
  });
});
