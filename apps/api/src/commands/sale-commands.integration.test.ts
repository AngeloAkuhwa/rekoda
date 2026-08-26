/**
 * The first two commands (spec §25; PR-021), proved on the properties the
 * slice exists for:
 *
 *   - replaying a command with the same idempotency key returns the FIRST
 *     response and writes nothing — no second invoice, no second event, no
 *     second job;
 *   - the outbox event and the state change commit or roll back TOGETHER;
 *   - the convert race mints one invoice however many hands convert;
 *   - the events the commands emit are types the production dispatcher
 *     handles, so nothing a command announces can go dead.
 *
 * Everything runs through the same `CommandBus` production wires and the
 * same work functions both flag positions share, because what the flag
 * changes is which gates run — never what a sale is.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, ordersRepo, outboxRepo, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { CommandBus } from './command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import {
  issueInvoiceWork,
  recordSaleWork,
  QuoteAlreadyTaken,
  type IssueInvoiceInput,
  type RecordSaleInput,
} from './sale-commands.js';
import { buildOutboxDispatcher } from '../jobs/jobs.module.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
const bus = new CommandBus(new RiskPolicyService());

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 8 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348160000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

function saleInput(businessId: string): RecordSaleInput {
  return {
    businessId,
    customerId: null,
    customerToken: 'cus_tok_1',
    items: [{ name: 'Ankara bale', quantity: 2, unitPriceK: 500_000 }],
    subtotalK: 1_000_000,
    discountK: 0,
    deliveryFeeK: 0,
    vatK: 0,
    totalK: 1_000_000,
    paidK: 1_000_000,
    balanceDueK: 0,
    method: 'cash',
    sourceType: 'chat',
    sourceId: 'draft-sale-1',
    saleSource: null,
    dueDate: null,
    actor: 'system',
  };
}

async function count(businessId: string, table: string): Promise<number> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ${sql.raw(table)} WHERE business_id = ${businessId}::uuid`,
    ),
  );
  return Number([...rows][0]?.n ?? 0);
}

describe('RecordSale through the bus', () => {
  it('issues once, and the replay returns the first answer writing nothing', async () => {
    const businessId = await seedBusiness();
    const input = saleInput(businessId);
    const envelope = {
      businessId,
      command: 'RecordSale' as const,
      payload: input,
      actor: 'system',
      ingress: 'CHAT' as const,
      idempotencyKey: 'draft:draft-sale-1',
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordSaleWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.replayed).toBe(false);
    expect(first.result.invoiceNumber).toMatch(/^INV-/);
    expect(first.result.balanceDueK).toBe(0);

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordSaleWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    /* Writes nothing: one invoice, one outbox event, one render job. */
    expect(await count(businessId, 'invoices')).toBe(1);
    expect(await count(businessId, 'outbox_events')).toBe(1);
    expect(await count(businessId, 'jobs')).toBe(1);
  });

  it('the outbox event and the sale commit or roll back together', async () => {
    const businessId = await seedBusiness();
    const input = saleInput(businessId);

    await expect(
      withBusiness(appDb, businessId, async (tx) => {
        await recordSaleWork(tx, input);
        throw new Error('after the work, before the commit');
      }),
    ).rejects.toThrow('after the work');

    /* Neither the sale nor its announcement survived: an event describing a
     * sale that never happened is exactly what §26 makes impossible. */
    expect(await count(businessId, 'invoices')).toBe(0);
    expect(await count(businessId, 'outbox_events')).toBe(0);
    expect(await count(businessId, 'jobs')).toBe(0);
  });

  it('announces the sale with the invoice identity, never the customer', async () => {
    const businessId = await seedBusiness();
    const input = saleInput(businessId);
    await withBusiness(appDb, businessId, (tx) => recordSaleWork(tx, input));

    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ type: string; payload: Record<string, unknown> }>(
        sql`SELECT type, payload FROM outbox_events WHERE business_id = ${businessId}::uuid`,
      ),
    );
    const event = [...rows][0];
    expect(event?.type).toBe('sale.recorded');
    expect(event?.payload['invoiceNumber']).toMatch(/^INV-/);
    expect(event?.payload['totalK']).toBe(1_000_000);
    /* The pseudonymous token stays out of the event: a consumer that needs
     * the customer asks the record, not the announcement. */
    expect(JSON.stringify(event?.payload)).not.toContain('cus_tok_1');
  });
});

describe('IssueInvoice through the bus', () => {
  async function seedQuote(businessId: string): Promise<{ quoteId: string }> {
    const quote = await withBusiness(appDb, businessId, (tx) =>
      ordersRepo.createQuote(tx, {
        businessId,
        customerId: null,
        lines: [
          {
            productId: null,
            name: 'Ankara bale',
            quantity: 3,
            unitPriceK: 400_000,
            lineTotalK: 1_200_000,
          },
        ],
        totalK: 1_200_000,
        validUntil: null,
        clientRef: null,
        sourceId: 'user:test',
      }),
    );
    return { quoteId: quote.id };
  }

  function invoiceInput(businessId: string, quoteId: string): IssueInvoiceInput {
    return {
      businessId,
      quoteId,
      customerId: null,
      items: [{ name: 'Ankara bale', quantity: 3, unitPriceK: 400_000 }],
      totalK: 1_200_000,
      dueDate: null,
      actor: 'user:test',
    };
  }

  it('converts once, replays the answer, and never mints a second invoice', async () => {
    const businessId = await seedBusiness();
    const { quoteId } = await seedQuote(businessId);
    const input = invoiceInput(businessId, quoteId);
    const envelope = {
      businessId,
      command: 'IssueInvoice' as const,
      payload: input,
      actor: 'user:test',
      ingress: 'DASHBOARD' as const,
      idempotencyKey: `quote-convert:${quoteId}`,
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => issueInvoiceWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.result.invoiceNumber).toMatch(/^INV-/);

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => issueInvoiceWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    expect(await count(businessId, 'invoices')).toBe(1);
    /* Render AND payable link, exactly one of each. */
    expect(await count(businessId, 'jobs')).toBe(2);
  });

  it('a convert race without the key loses whole: one invoice, one event', async () => {
    const businessId = await seedBusiness();
    const { quoteId } = await seedQuote(businessId);
    const input = invoiceInput(businessId, quoteId);

    await withBusiness(appDb, businessId, (tx) => issueInvoiceWork(tx, input));
    /* The second hand meets `quoted -> confirmed` already taken, and the
     * refusal rolls its invoice back — the winner's is the only one. */
    await expect(
      withBusiness(appDb, businessId, (tx) => issueInvoiceWork(tx, input)),
    ).rejects.toThrow(QuoteAlreadyTaken);

    expect(await count(businessId, 'invoices')).toBe(1);
    expect(await count(businessId, 'outbox_events')).toBe(1);
  });
});

describe('the announcements reach the production dispatcher', () => {
  it('every event a command emits is a type the dispatcher handles', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) => recordSaleWork(tx, saleInput(businessId)));

    const dispatcher = buildOutboxDispatcher();
    const pass = await dispatcher.runOnce(workerDb);
    expect(pass.failed).toBe(0);
    expect(pass.delivered).toBe(1);
    expect(await outboxRepo.deadEvents(workerDb)).toEqual([]);
  });
});
