/**
 * The runner, against a real PostgreSQL (MASTER-PLAN 4.4 #3).
 *
 * `packages/db/src/ops/jobs.integration.test.ts` proves the queue's SQL. These suites
 * prove the thing built on top of it: that a handler runs pinned to its job's
 * tenant, that its writes and its completion are one transaction, and that a
 * handler which throws leaves nothing behind.
 *
 * The runner is built with `buildRunner` — the same function `main.ts` calls —
 * so a handler that exists in the deploy and not in the test registry is not a
 * thing that can happen.
 */
// The job queue and its handlers, end to end. Split by concern across jobs*.integration.test.ts; the shared setup is in
// jobs.fixtures.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueRepo, ordersRepo, sql, withBusiness } from '@rekoda/db';
import { buildRunner } from './jobs.module.js';
import { SendFailed } from '../channels/sender.js';
import {
  appDb,
  deliveryJob,
  deps,
  enqueue,
  ownerWroteHoursAgo,
  renderedQuote,
  seedBusiness,
  stubSender,
  workerDb,
  useJobsHarness,
} from './jobs.fixtures.js';

useJobsHarness();

describe('a document sent outside the 24-hour service window (G-67)', () => {
  beforeEach(() => stubSender.reset());

  it('sends the PDF while the owner wrote within the last 24 hours', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000601');
    await ownerWroteHoursAgo(businessId, 23);
    const { quote, runner } = await renderedQuote(businessId);
    expect(await runner.runOnce()).toBe(true); // deliver
    expect(stubSender.documents.map((d) => d.filename)).toEqual([`${quote.orderNumber}.pdf`]);
    expect(stubSender.documentNotices).toHaveLength(0);
    expect(await deliveryJob(businessId)).toMatchObject({ state: 'done' });
  });

  it('sends the template notice instead of the PDF when the owner last wrote 25 hours ago', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000602');
    await ownerWroteHoursAgo(businessId, 25);
    const { quote, runner } = await renderedQuote(businessId);
    expect(await runner.runOnce()).toBe(true); // deliver
    expect(stubSender.documents).toHaveLength(0);
    expect(stubSender.documentNotices).toEqual([
      { to: '+2348177000602', documentLabel: 'quote', reference: quote.orderNumber },
    ]);
    /* Finished, not failed: the owner has been told, and "resend" delivers it. */
    expect(await deliveryJob(businessId)).toMatchObject({ state: 'done', attempts: 1 });
    /* It is the conversation history, and a utility template Rekoda pays for. */
    const [recorded] = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ body: string; sent: number }>(sql`
        SELECT body, (SELECT count(*) FROM usage_events
                       WHERE business_id = ${businessId}::uuid AND usage_type = 'UTILITY_TEMPLATE')::int AS sent
          FROM conversation_messages
         WHERE business_id = ${businessId}::uuid AND direction = 'outbound'`),
    );
    expect(recorded?.body).toContain(quote.orderNumber);
    expect(recorded?.body).toMatch(/resend/i);
    expect(recorded?.sent).toBe(1);
  });

  it('judges the window on the database clock, so a lagging application clock cannot close it', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000610');
    await ownerWroteHoursAgo(businessId, 0);
    const { quote, runner } = await renderedQuote(businessId);
    /* The application host's clock runs ten minutes behind the database's: the
     * message just recorded is then "from the future" by the app's reckoning. */
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 10 * 60_000 });
    try {
      expect(await runner.runOnce()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(stubSender.documents.map((d) => d.filename)).toEqual([`${quote.orderNumber}.pdf`]);
    expect(stubSender.documentNotices).toHaveLength(0);
  });

  it('treats an owner who never wrote as outside the window', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000603');
    const { runner } = await renderedQuote(businessId);
    expect(await runner.runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(0);
    expect(stubSender.documentNotices).toHaveLength(1);
  });

  it('falls back to the notice when Meta rejects a send the clock thought was open (131047)', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000604');
    await ownerWroteHoursAgo(businessId, 1);
    stubSender.failDocumentsWith(new SendFailed('outside the window', 131047));
    const { runner } = await renderedQuote(businessId);
    expect(await runner.runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(0);
    expect(stubSender.documentNotices).toHaveLength(1);
    expect(await deliveryJob(businessId)).toMatchObject({ state: 'done' });
  });

  it('keeps retrying any other send failure inside the window, with no notice', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000605');
    await ownerWroteHoursAgo(businessId, 1);
    stubSender.failDocumentsWith(new SendFailed('meta outage'));
    const { runner } = await renderedQuote(businessId);
    expect(await runner.runOnce()).toBe(true);
    expect(stubSender.documentNotices).toHaveLength(0);
    expect(await deliveryJob(businessId)).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('stays retryable, and visible, when the notice itself cannot be sent', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000606');
    await ownerWroteHoursAgo(businessId, 30);
    stubSender.failWith(new SendFailed('no document template configured'));
    const { runner } = await renderedQuote(businessId);
    expect(await runner.runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(0);
    expect(await deliveryJob(businessId)).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('attempts a resend the owner asked for even when the clock says the window is closed', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000608');
    const { runner } = await renderedQuote(businessId);
    expect(await runner.runOnce()).toBe(true); // the automatic delivery: a notice
    stubSender.reset();
    const [doc] = await withBusiness(appDb, businessId, (tx) =>
      issueRepo.documentsFor(tx, businessId),
    );
    await enqueue(businessId, 'document.deliver', {
      documentId: doc!.id,
      requestedByMerchant: true,
    });
    expect(await runner.runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(1);
    expect(stubSender.documentNotices).toHaveLength(0);
  });

  it('never answers a requested resend with another notice when Meta still says closed', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000609');
    const { runner } = await renderedQuote(businessId);
    expect(await runner.runOnce()).toBe(true); // the automatic delivery: a notice
    stubSender.reset();
    const [doc] = await withBusiness(appDb, businessId, (tx) =>
      issueRepo.documentsFor(tx, businessId),
    );
    stubSender.failDocumentsWith(new SendFailed('outside the window', 131047));
    await enqueue(businessId, 'document.deliver', {
      documentId: doc!.id,
      requestedByMerchant: true,
    });
    expect(await runner.runOnce()).toBe(true);
    expect(stubSender.documentNotices).toHaveLength(0);
    expect(await deliveryJob(businessId)).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('delivers the PDF to an owner who replied resend, even past 24 hours since their earlier message', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000607');
    await ownerWroteHoursAgo(businessId, 40);
    const { runner } = await renderedQuote(businessId);
    expect(await runner.runOnce()).toBe(true); // notice, window closed
    expect(stubSender.documentNotices).toHaveLength(1);
    await ownerWroteHoursAgo(businessId, 0); // "resend" opens a fresh window
    const [doc] = await withBusiness(appDb, businessId, (tx) =>
      issueRepo.documentsFor(tx, businessId),
    );
    await enqueue(businessId, 'document.deliver', {
      documentId: doc!.id,
      requestedByMerchant: true,
    });
    expect(await runner.runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(1);
  });
});

describe('a quote becomes paper', () => {
  beforeEach(() => stubSender.reset());

  /**
   * The gap this closes: invoices and receipts rendered from the day they
   * shipped, quotes never did — the one document whose whole job is being
   * forwarded to somebody deciding whether to buy.
   */
  it('renders the quote PDF, records the document, and delivers it', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000501');
    const quote = await withBusiness(appDb, businessId, (tx) =>
      ordersRepo.createQuote(tx, {
        businessId,
        customerId: null,
        lines: [
          {
            productId: null,
            name: 'Ankara bale',
            quantity: 2,
            unitPriceK: 850_000,
            lineTotalK: 1_700_000,
          },
        ],
        totalK: 1_700_000,
        validUntil: '2026-09-30',
        clientRef: null,
        sourceId: 'test',
      }),
    );
    /* The merchant asked for this quote a moment ago, so the window is open. */
    await ownerWroteHoursAgo(businessId, 0);
    /* The payload the controller enqueues: the id, and the label the PDF
     * prints — a token, never a name, exactly like the invoice's snapshot. */
    await enqueue(businessId, 'document.render', {
      quoteId: quote.id,
      customerToken: 'CUSTOMER_7K2',
    });

    const runner = buildRunner(workerDb, appDb, deps);
    expect(await runner.runOnce()).toBe(true); // render

    const docs = await withBusiness(appDb, businessId, (tx) =>
      issueRepo.documentsFor(tx, businessId),
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: 'quote_pdf', refNumber: quote.orderNumber });

    expect(await runner.runOnce()).toBe(true); // deliver
    const delivered = stubSender.documents[stubSender.documents.length - 1];
    expect(delivered?.filename).toBe(`${quote.orderNumber}.pdf`);
    /* Real bytes, really a PDF — not a row pointing at nothing. */
    expect(delivered?.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('an unknown quote id retires quietly instead of poisoning the queue', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000502');
    await enqueue(businessId, 'document.render', {
      quoteId: '00000000-0000-4000-8000-000000000000',
    });
    const runner = buildRunner(workerDb, appDb, deps);
    expect(await runner.runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(0);
  });
});
