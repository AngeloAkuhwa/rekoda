/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a preview has a time limit (G-23) (part 1 of 3). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { createDb, catalogueRepo, stockRepo, withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { customersRepo, reportsRepo } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  urls,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import {
  A_SALE,
  AN_EXPENSE,
  A_PURCHASE,
  EXPIRED,
  seedMerchant,
  drain,
  say,
  plain,
  lapse,
  states,
  footprint,
  used,
  withFirstInvoiceFailing,
  holdRetries,
  runRetriesNow,
} from './meta-preview-expiry.fixtures.js';

useMetaWebhookHarness();

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
  it('a yes inside the window records the sale, as it always has', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-fresh', A_SALE, 'sold Ada 3 wigs for 300k');
    expect(stubSender.lastText).toContain('Please check this before I save it');
    await plain('wamid.G23-fresh-yes', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);
    expect(await states(business.id)).toEqual(['confirmed']);
  });

  it("Monday's preview and Thursday's yes: nothing recorded, nothing charged, and it says why", async () => {
    const business = await seedMerchant();
    await say('wamid.G23-mon', A_SALE, 'sold Ada 3 wigs for 300k');
    const before = await footprint(business.id);
    const documentsBefore = stubSender.documents.length;

    await lapse(business.id);
    await plain('wamid.G23-thu', 'yes');

    expect(stubSender.lastText).toBe(EXPIRED);
    expect(stubSender.lastText).not.toBe(replies.nothingToConfirm().text);
    expect(await footprint(business.id)).toEqual(before);
    expect(before.invoices).toBe(0);
    expect(await used(business.id)).toEqual({ documents: 0, orders: 0 });
    expect(stubSender.documents.length).toBe(documentsBefore);
    /* Kept for the record, never deleted, never confirmable. */
    expect(await states(business.id)).toEqual(['expired']);

    /* Another yes is still about that request, and still records nothing. */
    await plain('wamid.G23-thu-2', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toEqual(before);
  });

  it('an expired preview never lets a yes reach an older preview behind it', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-older', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.G23-newer', AN_EXPENSE, 'bought fuel 20k cash');
    /* Only the newest, the one on the merchant's screen, has lapsed. */
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordExpense'`),
    );

    await plain('wamid.G23-older-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, expenses: 0, postings: 0 });
    /* The older sale was not touched by that yes. */
    expect(await states(business.id)).toEqual(['pending', 'expired']);
  });

  it('a new request after an expired one is confirmed alone, never the old one', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-a', A_SALE, 'sold Ada rice 300k');
    await lapse(business.id);
    await say('wamid.G23-b', AN_EXPENSE, 'bought fuel 20k cash');
    expect(stubSender.lastText).toContain('Expense: fuel for generator');

    await plain('wamid.G23-b-yes', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, expenses: 1 });
    expect(await states(business.id)).toEqual(['expired', 'confirmed']);

    /* And a stray yes afterwards resurrects nothing. */
    await plain('wamid.G23-b-yes-2', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, expenses: 1 });
  });

  it('a correction inside the window supersedes the first preview and gets its own window', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-c1', A_SALE, 'sold Ada 3 wigs for 300k');
    await say(
      'wamid.G23-c2',
      {
        ...A_SALE,
        items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
        statedTotal: 400_000,
      },
      'sorry, 4 wigs not 3',
    );
    expect(await states(business.id)).toEqual(['superseded', 'pending']);
    const windows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ fresh: boolean }>(sql`
        SELECT expires_at > clock_timestamp() AS fresh FROM command_drafts
         WHERE business_id = ${business.id}::uuid ORDER BY insertion_seq`),
    );
    expect([...windows].map((w) => w.fresh)).toEqual([true, true]);

    /* The correction lapses too: the superseded first preview never revives. */
    await lapse(business.id);
    await plain('wamid.G23-c-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await states(business.id)).toEqual(['superseded', 'expired']);
    expect((await footprint(business.id)).invoices).toBe(0);
  });

  it('a "sorry, 4 not 3" after the preview expired is a new request with a fresh window', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-e1', A_SALE, 'sold Ada 3 wigs for 300k');
    await lapse(business.id);
    await say(
      'wamid.G23-e2',
      {
        ...A_SALE,
        items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
        statedTotal: 400_000,
      },
      'sorry, 4 wigs not 3',
    );
    /* The expired one was expired, not "corrected". */
    expect(await states(business.id)).toEqual(['expired', 'pending']);
    await plain('wamid.G23-e-yes', 'yes');
    const invoices = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(invoices.rows).toHaveLength(1);
    expect(invoices.rows[0]?.totalK).toBe(40_000_000);
  });

  it('two yes messages inside the window: one invoice, one document unit', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-r1', A_SALE, 'sold Ada 3 wigs for 300k');
    await post(messagePayload('2348031234567', 'wamid.G23-r1-yes-a', 'yes'));
    await post(messagePayload('2348031234567', 'wamid.G23-r1-yes-b', 'yes'));
    /* Delivered together; one business's messages are handled one at a time
     * (the per-business lock), so they are worked in turn. The parallel
     * race on the claim itself is pinned in draft-expiry.integration. */
    await drain();
    expect((await footprint(business.id)).invoices).toBe(1);
    expect((await used(business.id)).documents).toBe(1);
  });

  it('two yes messages after the window: nothing executes, nothing is charged', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-r2', A_SALE, 'sold Ada 3 wigs for 300k');
    await lapse(business.id);
    const before = stubSender.sent.length;
    await post(messagePayload('2348031234567', 'wamid.G23-r2-yes-a', 'yes'));
    await post(messagePayload('2348031234567', 'wamid.G23-r2-yes-b', 'yes'));
    /* Delivered together; one business's messages are handled one at a time
     * (the per-business lock), so they are worked in turn. The parallel
     * race on the claim itself is pinned in draft-expiry.integration. */
    await drain();
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    expect(await used(business.id)).toEqual({ documents: 0, orders: 0 });
    expect(await states(business.id)).toEqual(['expired']);
    const answers = stubSender.sent.slice(before).map((m) => m.text);
    expect(answers).toEqual([EXPIRED, EXPIRED]);
  });

  it('a window that closes between the metering and the claim refunds the unit and records nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-edge', A_SALE, 'sold Ada 3 wigs for 300k');
    /* Deterministic: the moment this business's document unit is consumed,
     * its open preview's window closes, exactly the race the claim's own
     * predicate exists for. Test-scoped, on the owner connection. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_close_window() RETURNS trigger AS $$
        BEGIN
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 day'
           WHERE business_id = NEW.business_id AND state = 'pending';
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_close_window AFTER INSERT OR UPDATE ON usage_counters
          FOR EACH ROW WHEN (NEW.unit = 'DOCUMENT_GENERATION' AND NEW.used > 0)
          EXECUTE FUNCTION g23_close_window()`);

      await plain('wamid.G23-edge-yes', 'yes');
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_close_window ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_close_window()`);
      await close();
    }

    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    /* Taken, then given back: the merchant paid nothing for expired work. */
    expect((await used(business.id)).documents).toBe(0);
    expect(await states(business.id)).toEqual(['expired']);
  });

  it('a yes sent inside the window is honoured by a retry that runs after it, charged once', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-retry', A_SALE, 'sold Ada 3 wigs for 300k');

    /* Attempt 1 meters the unit (its own committed transaction), claims the
     * draft, then fails issuing: the job rolls back, the unit stays spent. */
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

      await post(messagePayload('2348031234567', 'wamid.G23-retry-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      expect((await footprint(business.id)).invoices).toBe(0);
      expect(await states(business.id)).toEqual(['pending']);
      expect((await used(business.id)).documents).toBe(1);

      /* The window closes AFTER the yes arrived and BEFORE the retry runs,
       * as a backoff can make it. */
      await ownerDb.execute(sql`
        UPDATE command_drafts SET expires_at = (
          SELECT created_at + interval '1 millisecond' FROM external_events
           WHERE business_id = ${business.id}::uuid ORDER BY created_at DESC LIMIT 1)
         WHERE business_id = ${business.id}::uuid`);
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${business.id}::uuid
           AND state <> 'done'`);
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_once ON invoices`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_once`);
      await close();
    }

    /* The merchant said yes in time: the sale is recorded once, the unit
     * attempt 1 took is the one it cost, and nobody is told it expired. */
    expect(stubSender.lastText).not.toBe(EXPIRED);
    expect((await footprint(business.id)).invoices).toBe(1);
    expect((await used(business.id)).documents).toBe(1);
    expect(await states(business.id)).toEqual(['confirmed']);
  });

  it('an expired overpayment preview writes no payment, credit, reconciliation or posting (G-49)', async () => {
    const business = await seedMerchant();
    await customersRepo.createCustomerWithIdentities(db, business.id, 'CUSTOMER_7K2', [
      { facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g23-over' },
    ]);
    await say('wamid.G23-o-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await plain('wamid.G23-o-sale-yes', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);

    await say(
      'wamid.G23-o-pay',
      {
        intent: 'RecordPayment',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
        amount: 400_000,
        relativeAmount: null,
        documentRef: null,
        paymentMethod: 'cash',
      },
      'Ada paid 400k',
    );
    expect(stubSender.lastText).toContain('Customer credit: ₦100,000');
    const before = await footprint(business.id);
    const documentsUsed = (await used(business.id)).documents;

    await lapse(business.id);
    await plain('wamid.G23-o-yes', 'yes');

    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toEqual(before);
    expect(before).toMatchObject({
      payments: 0,
      allocations: 0,
      receipts: 0,
      credits: 0,
      reconciliations: 0,
    });
    expect((await used(business.id)).documents).toBe(documentsUsed);
    /* The figures the merchant was shown stay on the record, unexecutable. */
    const kept = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string; kind: string | null }>(sql`
        SELECT state, confirmation_context->>'kind' AS kind FROM command_drafts
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordPayment'`),
    );
    expect([...kept]).toEqual([{ state: 'expired', kind: 'payment_overpayment' }]);
  });

  it('an expired purchase preview is an expiry, never mistaken for a retired question (G-61)', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-p', A_PURCHASE, 'I bought 10 cartons for 180k from Emeka, paid transfer');
    expect(stubSender.lastText).toContain('Paid in full by transfer');
    await lapse(business.id);
    await plain('wamid.G23-p-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    expect(stubSender.lastText).not.toContain('cash or transfer');
    expect(await states(business.id)).toEqual(['expired']);
    expect((await footprint(business.id)).expenses).toBe(0);
  });

  it('a retired purchase question is still re-asked by a yes, however old (G-61)', async () => {
    const business = await seedMerchant();
    await say(
      'wamid.G23-q',
      { ...A_PURCHASE, paymentMethod: 'pos' },
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    expect(await states(business.id)).toEqual(['abandoned']);
    /* Its window is long past: the question is still a question, not an expiry. */
    await lapse(business.id, sql`state = 'abandoned'`);
    await plain('wamid.G23-q-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    expect(await states(business.id)).toEqual(['abandoned']);

    /* The resend is a fresh preview with its own window, recorded once. */
    await say(
      'wamid.G23-q-bank',
      A_PURCHASE,
      'I bought 10 cartons for 180k from Emeka, paid by POS from my bank account',
    );
    await plain('wamid.G23-q-bank-yes', 'yes');
    await plain('wamid.G23-q-bank-yes-2', 'yes');
    expect((await footprint(business.id)).expenses).toBe(1);
    expect(await states(business.id)).toEqual(['superseded', 'confirmed']);
  });

  it('a "no" after an expired preview cancels nothing, not even an older preview', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-n1', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.G23-n2', AN_EXPENSE, 'bought fuel 20k cash');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordExpense'`),
    );
    await plain('wamid.G23-n-no', 'no');
    expect(stubSender.lastText).toBe(replies.expiredNothingToCancel().text);
    /* The sale behind it is exactly as it was. */
    expect(await states(business.id)).toEqual(['pending', 'expired']);
  });

  it('an expired order quote raises no order, no invoice, and takes no order or document unit', async () => {
    const business = await seedMerchant();
    await withBusiness(db, business.id, async (tx) => {
      const bale = await stockRepo.findOrCreateProduct(tx, business.id, 'Ankara bale');
      await stockRepo.recordMovement(tx, {
        businessId: business.id,
        productId: bale.id,
        delta: 10,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: 'seed',
      });
      await catalogueRepo.editProduct(tx, business.id, bale.id, { unitPriceK: 850_000 });
    });
    await say(
      'wamid.G23-ord',
      {
        intent: 'RecordOrder',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
        items: [{ name: 'Ankara bale', quantity: 2 }],
        note: null,
      },
      'please I want 2 ankara bale',
    );
    expect(stubSender.lastText).toContain('Total: ₦17,000');
    await lapse(business.id);
    await plain('wamid.G23-ord-yes', 'yes');

    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toMatchObject({ orders: 0, invoices: 0, postings: 0 });
    expect(await used(business.id)).toEqual({ documents: 0, orders: 0 });
    const stock = await withBusiness(db, business.id, (tx) => stockRepo.stockList(tx, business.id));
    expect(stock.rows.find((p) => p.name === 'Ankara bale')?.onHand).toBe(10);
  });

  it('an expired stock write-off removes nothing', async () => {
    const business = await seedMerchant();
    const adjust = (delta: number) => ({
      intent: 'AdjustInventory',
      productMention: 'bags of rice',
      quantityDelta: delta,
    });
    await say('wamid.G23-s1', adjust(20), 'add 20 bags of rice');
    await plain('wamid.G23-s1-yes', 'yes');
    await say('wamid.G23-s2', adjust(-15), '15 bags got water damage');
    expect(stubSender.lastText).toContain('Removing 15 bags of rice');
    await lapse(business.id);
    await plain('wamid.G23-s2-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    const rice = await withBusiness(db, business.id, (tx) =>
      stockRepo.productByName(tx, business.id, 'bags of rice'),
    );
    expect(rice?.onHand).toBe(20);
  });

  it('an expired expense preview records no expense', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-x', AN_EXPENSE, 'bought fuel 20k cash');
    await lapse(business.id);
    await plain('wamid.G23-x-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toMatchObject({ expenses: 0, postings: 0 });
  });

  it('a retried yes overtaken by a newer request confirms what it was sent for, never the newer preview', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-ot1', A_SALE, 'sold Ada 3 wigs for 300k');

    await withFirstInvoiceFailing(async (owner) => {
      await post(messagePayload('2348031234567', 'wamid.G23-ot1-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      /* Hold the retry back until the test releases it, so the newer message
       * is handled first however slow the runner is. */
      await holdRetries(owner, business.id);
      expect((await footprint(business.id)).invoices).toBe(0);

      /* A newer request is previewed while the yes waits to be retried. */
      await say(
        'wamid.G23-ot2',
        {
          ...A_SALE,
          customer: { kind: 'none' },
          items: [{ name: 'shoes', quantity: 2, unitPrice: 25_000 }],
          statedTotal: 50_000,
        },
        'sold Bayo 2 shoes',
      );
      expect(stubSender.lastText).toContain('Total: ₦50,000');
      await runRetriesNow(owner, business.id);
      await drain();
    });

    /* The yes confirmed the 300k sale it answered, once; the shoes, which
     * did not exist when it was sent, are still only a preview. */
    const invoices = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(invoices.rows.map((i) => i.totalK)).toEqual([30_000_000]);
    expect(await states(business.id)).toEqual(['confirmed', 'pending']);
    expect((await used(business.id)).documents).toBe(1);
  });

  it('a retried yes whose window a later message closed records nothing and gives the unit back', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-cl1', A_SALE, 'sold Ada 3 wigs for 300k');

    await withFirstInvoiceFailing(async (owner) => {
      await post(messagePayload('2348031234567', 'wamid.G23-cl1-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      /* Hold the retry back until the test releases it, so the newer message
       * is handled first however slow the runner is. */
      await holdRetries(owner, business.id);
      expect((await used(business.id)).documents).toBe(1);

      /* The window closes just after the yes arrived, and a later request
       * (handled before the retry) closes it for good. */
      await owner.execute(sql`
        UPDATE command_drafts SET expires_at = (
          SELECT created_at + interval '1 millisecond' FROM external_events
           WHERE business_id = ${business.id}::uuid ORDER BY created_at DESC LIMIT 1)
         WHERE business_id = ${business.id}::uuid`);
      await say('wamid.G23-cl2', AN_EXPENSE, 'bought fuel 20k cash');
      expect(await states(business.id)).toEqual(['expired', 'pending']);

      await runRetriesNow(owner, business.id);
      await drain();
    });

    expect((await footprint(business.id)).invoices).toBe(0);
    /* Attempt 1's unit is back: nothing was charged for work that never ran. */
    expect((await used(business.id)).documents).toBe(0);
    expect(stubSender.sent.map((m) => m.text)).toContain(EXPIRED);
  });
});
