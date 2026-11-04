/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a preview has a time limit (G-23) (part 2 of 3). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { createDb, events, jobsRepo, stockRepo, withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
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
  AN_EXPENSE,
  EXPIRED,
  seedMerchant,
  drain,
  say,
  plain,
  lapse,
  states,
  footprint,
  used,
  runRetriesNow,
  previewFlags,
  lastWamid,
  receipt,
  draftStates,
  receiptProcessed,
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
  it('a yes that arrived after the window, retried, gives back nothing it never took', async () => {
    const business = await seedMerchant();
    /* One real sale first, so the counter has a unit a wrong refund would show. */
    await say('wamid.G23-nr-0', A_SALE, 'sold Ada 3 wigs for 300k');
    await plain('wamid.G23-nr-0-yes', 'yes');
    expect((await used(business.id)).documents).toBe(1);

    await say('wamid.G23-nr-1', A_SALE, 'sold Ada 3 more wigs for 300k');
    await lapse(business.id);

    /* The answer to the late yes fails to be recorded once, so the job is
     * retried: attempt 1 metered nothing (the window had closed before the
     * yes arrived), and the retry must not refund a unit it never took. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_out_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_out_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_out_once') = 1 THEN RAISE EXCEPTION 'g23: first answer fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_out_once BEFORE INSERT ON conversation_messages
          FOR EACH ROW WHEN (NEW.direction = 'outbound') EXECUTE FUNCTION g23_fail_out_once()`);

      await post(messagePayload('2348031234567', 'wamid.G23-nr-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      await runRetriesNow(ownerDb, business.id);
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_out_once ON conversation_messages`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_out_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_out_once`);
      await close();
    }

    expect(stubSender.lastText).toBe(EXPIRED);
    expect((await footprint(business.id)).invoices).toBe(1);
    /* Still the one unit the real sale cost: no free unit from the retry. */
    expect((await used(business.id)).documents).toBe(1);
  });

  it('a yes that reached Rekoda before the preview existed confirms nothing (CG2)', async () => {
    const business = await seedMerchant();
    /* Both arrive before either is handled: the yes was typed before the
     * merchant could have read any preview, so it is not their consent. */
    stubTransport.replyWith(AN_EXPENSE);
    await post(messagePayload('2348031234567', 'wamid.G23-pre', 'bought fuel 20k cash'));
    await post(messagePayload('2348031234567', 'wamid.G23-pre-yes', 'yes'));
    await drain();

    /* Never "nothing is waiting": a preview is. It just is not this yes's. */
    expect(stubSender.lastText).toBe(replies.previewAwaitingYes().text);
    expect((await footprint(business.id)).expenses).toBe(0);
    /* The preview stands, for a yes sent after reading it. */
    expect(await states(business.id)).toEqual(['pending']);
    await plain('wamid.G23-pre-yes-2', 'yes');
    expect((await footprint(business.id)).expenses).toBe(1);
  });

  it('a lapsed question stored with a financial intent is never called an expired request', async () => {
    const business = await seedMerchant();
    const previewedOf = async () => {
      const rows = await withBusiness(db, business.id, (tx) =>
        tx.execute<{ intent: string; previewed: boolean }>(sql`
          SELECT intent, previewed FROM command_drafts
           WHERE business_id = ${business.id}::uuid ORDER BY insertion_seq`),
      );
      return [...rows];
    };

    /* A sale whose total disagrees with its items: a CG1 question, stored
     * as a RecordSale draft, never a preview. */
    await say('wamid.G23-cg1', { ...A_SALE, statedTotal: 350_000 }, 'sold Ada 3 wigs for 350k');
    expect(stubSender.lastText).toContain('Tell me the right one');
    /* A payment with no open invoice to place it on: a question too. */
    await say(
      'wamid.G23-noinv',
      {
        intent: 'RecordPayment',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
        amount: 50_000,
        relativeAmount: null,
        documentRef: null,
        paymentMethod: 'cash',
      },
      'Ada paid 50k',
    );
    /* And a real preview, for contrast. */
    await say('wamid.G23-real', AN_EXPENSE, 'bought fuel 20k cash');
    expect(await previewedOf()).toEqual([
      { intent: 'RecordSale', previewed: false },
      { intent: 'RecordPayment', previewed: false },
      { intent: 'RecordExpense', previewed: true },
    ]);

    /* The expense lapses: its yes is told it expired. */
    await lapse(business.id);
    await plain('wamid.G23-real-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);

    /* A business whose LAST thing was a question: never "expired". */
    const second = await seedMerchant('+2348031234568');
    stubTransport.replyWith({ ...A_SALE, statedTotal: 350_000 });
    await post(messagePayload('2348031234568', 'wamid.G23-cg1b', 'sold Ada 3 wigs for 350k'));
    await drain();
    await lapse(second.id);
    await post(messagePayload('2348031234568', 'wamid.G23-cg1b-yes', 'yes'));
    await drain();
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    await post(messagePayload('2348031234568', 'wamid.G23-cg1b-no', 'no'));
    await drain();
    expect(stubSender.lastText).not.toBe(replies.expiredNothingToCancel().text);
  });

  it('a preview whose send failed is not "previewed": its lapse is never called an expired request', async () => {
    const business = await seedMerchant();
    stubSender.failWith();
    await say('wamid.G23-unsent', AN_EXPENSE, 'bought fuel 20k cash');
    const flags = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ previewed: boolean }>(sql`
        SELECT previewed FROM command_drafts WHERE business_id = ${business.id}::uuid`),
    );
    expect([...flags].map((r) => r.previewed)).toEqual([false]);

    await lapse(business.id);
    await plain('wamid.G23-unsent-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    expect((await footprint(business.id)).expenses).toBe(0);
  });

  it('a preview accepted for delivery that then failed is not "previewed" (G-20)', async () => {
    const business = await seedMerchant();
    await say('wamid.G20-late', AN_EXPENSE, 'bought fuel 20k cash');
    expect(stubSender.lastText).toContain('Expense: fuel for generator');
    const wamid = lastWamid();
    expect(await previewFlags(business.id)).toEqual([{ previewed: true, linked: false }]);

    const first = await receipt('2348031234567', wamid, 'failed');
    expect(first.statusCode).toBe(200);
    await drain();
    expect(await previewFlags(business.id)).toEqual([{ previewed: false, linked: false }]);

    /* Read, then marked processed: never a stuck backlog on the ops surface. */
    const event = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ processed: boolean }>(sql`
        SELECT processed_at IS NOT NULL AS processed FROM external_events
         WHERE external_id = ${`${wamid}:failed`}`),
    );
    expect([...event]).toEqual([{ processed: true }]);
    expect((await events.eventHealth(db, 'meta')).unprocessed).toBe(0);

    /* Meta retries: a duplicate receipt queues nothing more and changes nothing. */
    const again = await receipt('2348031234567', wamid, 'failed');
    expect(again.statusCode).toBe(200);
    const jobs = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number; max_attempts: number }>(sql`
        SELECT count(*)::int AS n, max(max_attempts)::int AS max_attempts FROM jobs
         WHERE business_id = ${business.id}::uuid AND kind = 'delivery.status'`),
    );
    expect([...jobs][0]?.n).toBe(1);
    /* The job waits on the conversation lock, which an inbound job holds across
     * model calls; a few lock timeouts must not kill it and leave the unseen
     * preview confirmable (the default of 5 retries spans only ~15 s). */
    expect([...jobs][0]?.max_attempts).toBeGreaterThanOrEqual(12);
    await drain();

    /* Its lapse is never called an expired request: it was never seen. */
    await lapse(business.id);
    await plain('wamid.G20-late-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    expect((await footprint(business.id)).expenses).toBe(0);
  });

  it('a "yes" right after a late delivery failure posts neither a sale nor an expense (G-20, owner ruling)', async () => {
    const business = await seedMerchant();
    await say('wamid.G20-nb-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    const saleWamid = lastWamid();
    await receipt('2348031234567', saleWamid, 'failed');
    await drain();
    expect(await draftStates(business.id)).toEqual([
      { state: 'superseded', reason: 'preview_not_delivered' },
    ]);
    await plain('wamid.G20-nb-sale-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });

    await say('wamid.G20-nb-exp', AN_EXPENSE, 'bought fuel 20k cash');
    await receipt('2348031234567', lastWamid(), 'failed');
    await drain();
    await plain('wamid.G20-nb-exp-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    expect(await footprint(business.id)).toMatchObject({ expenses: 0, postings: 0 });
    expect((await used(business.id)).documents).toBe(0);
  });

  it('a "yes" after a preview whose send failed outright posts nothing (G-20, owner ruling)', async () => {
    const business = await seedMerchant();
    stubSender.failWith();
    await say('wamid.G20-st-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await plain('wamid.G20-st-sale-yes', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    stubSender.failWith();
    await say('wamid.G20-st-exp', AN_EXPENSE, 'bought fuel 20k cash');
    await plain('wamid.G20-st-exp-yes', 'yes');
    expect(await footprint(business.id)).toMatchObject({ expenses: 0, postings: 0 });
    expect((await used(business.id)).documents).toBe(0);
  });

  it('a preview Meta accepted without a message id can never be traced, so no yes confirms it (G-20)', async () => {
    const business = await seedMerchant();
    stubSender.omitNextMessageId();
    await say('wamid.G20-noid', AN_EXPENSE, 'bought fuel 20k cash');
    expect(await previewFlags(business.id)).toEqual([{ previewed: false, linked: false }]);
    await plain('wamid.G20-noid-yes', 'yes');
    expect((await footprint(business.id)).expenses).toBe(0);
    expect((await used(business.id)).documents).toBe(0);
  });

  it('a retry needs a NEW preview and a fresh yes after a failed one (G-20)', async () => {
    const business = await seedMerchant();
    await say('wamid.G20-rt-1', AN_EXPENSE, 'bought fuel 20k cash');
    await receipt('2348031234567', lastWamid(), 'failed');
    await drain();
    await plain('wamid.G20-rt-1-yes', 'yes');
    expect((await footprint(business.id)).expenses).toBe(0);

    await say('wamid.G20-rt-2', AN_EXPENSE, 'bought fuel 20k cash');
    expect(stubSender.lastText).toContain('Expense: fuel for generator');
    await plain('wamid.G20-rt-2-yes', 'yes');
    expect((await footprint(business.id)).expenses).toBe(1);
  });

  it('a receipt job that died after every lock attempt still blocks the yes, and is applied once (G-20)', async () => {
    const business = await seedMerchant();
    await say('wamid.G20-dead', AN_EXPENSE, 'bought fuel 20k cash');
    const wamid = lastWamid();
    await receipt('2348031234567', wamid, 'failed');
    /* All 12 attempts spent on lock timeouts: the job is dead, the receipt
     * never applied, the draft still previewed. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        UPDATE jobs SET state = 'dead', attempts = max_attempts, last_error = 'lock timeout'
         WHERE business_id = ${business.id}::uuid AND kind = 'delivery.status'`);
    } finally {
      await close();
    }
    expect(await previewFlags(business.id)).toEqual([{ previewed: true, linked: false }]);
    expect(await receiptProcessed(business.id)).toEqual([false]);

    await plain('wamid.G20-dead-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    expect((await footprint(business.id)).expenses).toBe(0);
    expect(await draftStates(business.id)).toEqual([
      { state: 'superseded', reason: 'preview_not_delivered' },
    ]);
    /* Applied exactly once: the receipt is now processed. */
    expect(await receiptProcessed(business.id)).toEqual([true]);
    await plain('wamid.G20-dead-yes-2', 'yes');
    expect((await footprint(business.id)).expenses).toBe(0);
    /* And the dead job stays visible to operational monitoring. */
    expect((await jobsRepo.queueHealth(workerDb)).deadRecent).toBeGreaterThanOrEqual(1);
  });

  it('a late failure closes the question that reply asked, and nothing else (G-20)', async () => {
    const business = await seedMerchant();
    const SPEND = {
      intent: 'Query',
      topic: 'expenses_summary',
      customer: null,
      period: null,
      periodText: null,
      format: 'chat',
    };
    const open = async () =>
      [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ expects: string | null }>(sql`
            SELECT expects FROM conversation_continuations
             WHERE business_id = ${business.id}::uuid AND state = 'open'`),
        )),
      ].map((r) => r.expects);
    await say('wamid.G20-co-q', SPEND, 'how much did I spend?');
    expect(stubSender.lastText).toContain('which period');
    const asked = lastWamid();
    expect(await open()).toEqual(['period']);

    /* An unrelated failed receipt leaves it. */
    await receipt('2348031234567', 'wamid.never-ours', 'failed');
    await drain();
    expect(await open()).toEqual(['period']);

    await receipt('2348031234567', asked, 'failed');
    await drain();
    expect(await open()).toEqual([]);
    /* A duplicate changes nothing. */
    await receipt('2348031234567', asked, 'failed');
    await drain();
    expect(await open()).toEqual([]);
  });

  it('a delivered or read receipt leaves a preview "previewed" (G-20)', async () => {
    const business = await seedMerchant();
    await say('wamid.G20-ok', AN_EXPENSE, 'bought fuel 20k cash');
    const wamid = lastWamid();
    await receipt('2348031234567', wamid, 'sent');
    await receipt('2348031234567', wamid, 'delivered');
    await receipt('2348031234567', wamid, 'read');
    await drain();
    expect(await previewFlags(business.id)).toEqual([{ previewed: true, linked: false }]);

    await lapse(business.id);
    await plain('wamid.G20-ok-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
  });

  it('a failed receipt for a reply that previewed nothing leaves the preview alone (G-20)', async () => {
    const business = await seedMerchant();
    await say('wamid.G20-p', AN_EXPENSE, 'bought fuel 20k cash');
    /* A later reply that is not a preview: a deterministic question. */
    await plain('wamid.G20-owes', 'who owes me');
    const notAPreview = lastWamid();
    await receipt('2348031234567', notAPreview, 'failed');
    await drain();
    expect(await previewFlags(business.id)).toEqual([{ previewed: true, linked: false }]);

    await lapse(business.id);
    await plain('wamid.G20-p-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
  });

  it("a failed receipt never reaches another business's preview (G-20)", async () => {
    const ada = await seedMerchant();
    await say('wamid.G20-ada', AN_EXPENSE, 'bought fuel 20k cash');
    const adaWamid = lastWamid();
    const bisi = await seedMerchant('+2348031234568');
    stubTransport.replyWith(AN_EXPENSE);
    await post(messagePayload('2348031234568', 'wamid.G20-bisi', 'bought fuel 20k cash'));
    await drain();
    const bisiWamid = lastWamid();

    /* Ada's wamid, filed under Bisi: looked up inside Bisi's books only. */
    await receipt('2348031234568', adaWamid, 'failed');
    await drain();
    expect(await previewFlags(ada.id)).toEqual([{ previewed: true, linked: false }]);
    expect(await previewFlags(bisi.id)).toEqual([{ previewed: true, linked: false }]);

    /* Bisi's own failure touches Bisi's preview and nobody else's. */
    await receipt('2348031234568', bisiWamid, 'failed');
    await drain();
    expect(await previewFlags(ada.id)).toEqual([{ previewed: true, linked: false }]);
    expect(await previewFlags(bisi.id)).toEqual([{ previewed: false, linked: false }]);
  });

  it('a preview re-sent after its job rolled back is pointed at, never confirmed by the earlier yes', async () => {
    const business = await seedMerchant();
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      /* The preview reaches the merchant, then a later statement in the same
       * job fails (recording that it was sent): the draft rolls back. */
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_sent_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_sent_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_sent_once') = 1 THEN RAISE EXCEPTION 'g23: after the send'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_sent_once BEFORE UPDATE ON conversation_messages
          FOR EACH ROW WHEN (NEW.direction = 'outbound') EXECUTE FUNCTION g23_fail_sent_once()`);

      stubTransport.replyWith(AN_EXPENSE);
      await post(messagePayload('2348031234567', 'wamid.G23-rb', 'bought fuel 20k cash'));
      await buildRunner(workerDb, db, deps).runOnce();
      expect(stubSender.lastText).toContain('Expense: fuel for generator');
      expect(await states(business.id)).toEqual([]);

      /* The merchant read it and said yes; the preview's retry runs first
       * and writes the draft again, after that yes had arrived. */
      await post(messagePayload('2348031234567', 'wamid.G23-rb-yes', 'yes'));
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() - interval '1 hour'
         WHERE business_id = ${business.id}::uuid AND state <> 'done' AND attempts > 0`);
      await drain();
    } finally {
      await ownerDb.execute(
        sql`DROP TRIGGER IF EXISTS g23_fail_sent_once ON conversation_messages`,
      );
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_sent_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_sent_once`);
      await close();
    }

    /* Pointed at, not "nothing waiting", and nothing saved by that yes. */
    expect(stubSender.lastText).toBe(replies.previewAwaitingYes().text);
    expect((await footprint(business.id)).expenses).toBe(0);
    expect(await states(business.id)).toEqual(['pending']);

    /* The next yes confirms it, once. */
    await plain('wamid.G23-rb-yes-2', 'yes');
    expect((await footprint(business.id)).expenses).toBe(1);
  });

  it('a write-off confirmed in time but run late applies, its HIGH_RISK confirmation judged at the same instant', async () => {
    const business = await seedMerchant();
    const adjust = (delta: number) => ({
      intent: 'AdjustInventory',
      productMention: 'bags of rice',
      quantityDelta: delta,
    });
    await say('wamid.G23-wo1', adjust(20), 'add 20 bags of rice');
    await plain('wamid.G23-wo1-yes', 'yes');
    await say('wamid.G23-wo2', adjust(-15), '15 bags got water damage');
    expect(stubSender.lastText).toContain('Removing 15 bags of rice');
    /* The HIGH_RISK confirmation opens from the draft's own database
     * timestamp, never this host's clock: the two windows close together. */
    const [windows] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<{ same: boolean }>(sql`
          SELECT (SELECT expires_at FROM command_drafts
                   WHERE business_id = ${business.id}::uuid AND state = 'pending')
               = (SELECT expires_at FROM pending_confirmations
                   WHERE business_id = ${business.id}::uuid AND claimed_at IS NULL) AS same`),
      )),
    ];
    expect(windows?.same).toBe(true);

    /* The yes arrives inside both windows; by the time it runs, both have
     * closed on the wall clock. */
    await post(messagePayload('2348031234567', 'wamid.G23-wo2-yes', 'yes'));
    await withBusiness(db, business.id, async (tx) => {
      const [arrived] = [
        ...(await tx.execute<{ at: string }>(sql`
          SELECT (created_at + interval '1 millisecond')::text AS at FROM external_events
           WHERE business_id = ${business.id}::uuid ORDER BY created_at DESC LIMIT 1`)),
      ];
      await tx.execute(sql`
        UPDATE command_drafts SET expires_at = ${arrived!.at}::timestamptz
         WHERE business_id = ${business.id}::uuid AND state = 'pending'`);
      await tx.execute(sql`
        UPDATE pending_confirmations SET expires_at = ${arrived!.at}::timestamptz
         WHERE business_id = ${business.id}::uuid AND claimed_at IS NULL`);
    });
    await drain();

    expect(stubSender.lastText).toContain('Removed 15 bags of rice');
    const rice = await withBusiness(db, business.id, (tx) =>
      stockRepo.productByName(tx, business.id, 'bags of rice'),
    );
    expect(rice?.onHand).toBe(5);
    const claimed = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ claimed: boolean }>(sql`
        SELECT claimed_at IS NOT NULL AS claimed FROM pending_confirmations
         WHERE business_id = ${business.id}::uuid`),
    );
    expect([...claimed].map((r) => r.claimed)).toEqual([true]);
  });
});
