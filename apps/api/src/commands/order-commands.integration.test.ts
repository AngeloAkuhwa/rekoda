/**
 * The order command (spec §25; PR-025), proved on what makes it Integrate's:
 * the bus refuses a business without REKODA_INTEGRATE before anything is
 * written; a replay returns the first order minting nothing; the order, the
 * invoice, the linkage, the jobs, the stock and the announcement are one
 * transaction; and both command names — the customer's own hand and the
 * merchant's forwarding — run the identical work.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { billingRepo, createDb, identity, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { CommandBus } from './command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import { placeOrderWork, type PlaceOrderCmdInput } from './order-commands.js';
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

async function seedBusiness(entitle = true, phone = '+2348160000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  /* A trial holds both halves; `chat` is the plan that does NOT sell
   * automatic order capture, which is what the refusal test needs. */
  await billingRepo.setPlan(appDb, {
    businessId: business.id,
    plan: entitle ? 'integrate' : 'chat',
    expiresAt: null,
    actor: 'operator:test',
  });
  return business.id;
}

async function count(businessId: string, table: string, where = ''): Promise<number> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}
          WHERE business_id = ${businessId}::uuid ${sql.raw(where)}`,
    ),
  );
  return Number([...rows][0]?.n ?? 0);
}

const orderInput = (businessId: string): PlaceOrderCmdInput => ({
  businessId,
  customerId: null,
  lines: [
    {
      productId: null,
      name: 'Ankara bale',
      quantity: 2,
      unitPriceK: 600_000,
      lineTotalK: 1_200_000,
    },
  ],
  totalK: 1_200_000,
  sourceType: 'storefront',
  sourceId: 'shop:ada',
  externalRef: 'shop:ref-1',
  saleSource: 'website',
  actor: 'customer:storefront',
});

describe('PlaceOrder through the bus', () => {
  it('places once — order, invoice, linkage, jobs, event — and the replay mints nothing', async () => {
    const businessId = await seedBusiness();
    const input = orderInput(businessId);
    const envelope = {
      businessId,
      command: 'PlaceOrder' as const,
      payload: input,
      actor: input.actor,
      ingress: 'STOREFRONT' as const,
      idempotencyKey: 'shop-order:ref-1',
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => placeOrderWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.result.orderNumber).toMatch(/^ORD-/);
    expect(first.result.invoiceNumber).toMatch(/^INV-/);

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => placeOrderWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    expect(await count(businessId, 'orders')).toBe(1);
    expect(await count(businessId, 'invoices')).toBe(1);
    /* Render AND payable link. */
    expect(await count(businessId, 'jobs')).toBe(2);
    expect(await count(businessId, 'outbox_events', "AND type = 'order.placed'")).toBe(1);

    /* The invoice is ATTACHED: the register never matches by eye. */
    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ status: string; invoice_id: string | null }>(
        sql`SELECT status, invoice_id FROM orders WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...rows][0]?.status).toBe('confirmed');
    expect([...rows][0]?.invoice_id).toBe(first.result.invoiceId);
  });

  it('refuses a business without REKODA_INTEGRATE before anything is written', async () => {
    const businessId = await seedBusiness(false);
    const input = orderInput(businessId);

    const run = await withBusiness(appDb, businessId, (tx) =>
      bus.run(
        tx,
        {
          businessId,
          command: 'PlaceOrder',
          payload: input,
          actor: input.actor,
          ingress: 'STOREFRONT',
          idempotencyKey: 'shop-order:ref-refused',
        },
        () => placeOrderWork(tx, input),
      ),
    );
    expect(run.outcome).toBe('not_entitled');

    /* Rule 1 of §4.3: a refused request consumes nothing — no order, no
     * invoice, no event, and no idempotency claim either, because the
     * refusal came before the key. */
    expect(await count(businessId, 'orders')).toBe(0);
    expect(await count(businessId, 'invoices')).toBe(0);
    expect(await count(businessId, 'outbox_events')).toBe(0);
    expect(await count(businessId, 'idempotency_records')).toBe(0);
  });

  it('RecordOrder — the merchant forwarding — runs the identical work', async () => {
    const businessId = await seedBusiness();
    const input: PlaceOrderCmdInput = {
      ...orderInput(businessId),
      sourceType: 'chat',
      sourceId: 'draft-ord-1',
      externalRef: null,
      saleSource: null,
      invoiceSourceId: 'draft-ord-1',
      actor: 'system',
    };

    const run = await withBusiness(appDb, businessId, (tx) =>
      bus.run(
        tx,
        {
          businessId,
          command: 'RecordOrder',
          payload: input,
          actor: 'system',
          ingress: 'CHAT',
          idempotencyKey: 'draft:draft-ord-1',
        },
        () => placeOrderWork(tx, input),
      ),
    );
    expect(run.outcome).toBe('done');
    if (run.outcome !== 'done') return;

    /* The invoice cites the confirmed draft, as chat always has. */
    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ source_type: string; source_id: string }>(
        sql`SELECT source_type, source_id FROM invoices WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...rows][0]).toEqual({ source_type: 'chat', source_id: 'draft-ord-1' });
  });

  it('the order, the invoice and the announcement roll back together', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(appDb, businessId, async (tx) => {
        await placeOrderWork(tx, orderInput(businessId));
        throw new Error('after the work, before the commit');
      }),
    ).rejects.toThrow('after the work');

    expect(await count(businessId, 'orders')).toBe(0);
    expect(await count(businessId, 'invoices')).toBe(0);
    expect(await count(businessId, 'outbox_events')).toBe(0);
  });
});

describe('the announcement reaches the production dispatcher', () => {
  it('order.placed is a type the dispatcher handles', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) => placeOrderWork(tx, orderInput(businessId)));

    const pass = await buildOutboxDispatcher().runOnce(workerDb);
    expect(pass.failed).toBe(0);
    expect(pass.delivered).toBe(1);
  });
});
