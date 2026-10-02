/**
 * The spend commands (spec §25; PR-023), proved on the slice's promises:
 * a replayed command returns the first answer and writes nothing; the
 * announcement, the ledger posting and the stock movement commit or roll
 * back together; and the events are types the production dispatcher
 * handles. The recurring sweep's envelope is exercised here in the exact
 * AUTOMATION shape the sweep builds, because a standing order must not
 * have a cheaper path to the ledger than a sentence does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, stockRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { CommandBus } from './command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import {
  recordExpenseWork,
  recordPurchaseWork,
  type RecordExpenseCmdInput,
  type RecordPurchaseCmdInput,
} from './spend-commands.js';
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

async function count(businessId: string, table: string, where = ''): Promise<number> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}
          WHERE business_id = ${businessId}::uuid ${sql.raw(where)}`,
    ),
  );
  return Number([...rows][0]?.n ?? 0);
}

describe('RecordExpense through the bus', () => {
  const expenseInput = (businessId: string): RecordExpenseCmdInput => ({
    businessId,
    description: 'fuel for the generator',
    category: 'transport',
    amountK: 500_000,
    method: 'cash',
    sourceType: 'chat',
    sourceId: 'draft-exp-1',
  });

  it('records once, and the replay returns the first answer writing nothing', async () => {
    const businessId = await seedBusiness();
    const input = expenseInput(businessId);
    const envelope = {
      businessId,
      command: 'RecordExpense' as const,
      payload: input,
      actor: 'system',
      ingress: 'CHAT' as const,
      idempotencyKey: 'draft:draft-exp-1',
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordExpenseWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordExpenseWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    expect(await count(businessId, 'expenses')).toBe(1);
    expect(await count(businessId, 'outbox_events', "AND type = 'expense.recorded'")).toBe(1);
  });

  it('the AUTOMATION envelope the recurring sweep builds works the same gate', async () => {
    const businessId = await seedBusiness();
    const input: RecordExpenseCmdInput = {
      businessId,
      description: 'shop rent',
      category: 'rent',
      amountK: 20_000_000,
      method: 'transfer',
      sourceType: 'recurring',
      sourceId: 'sched-1:2026-08-01',
      recordedAt: new Date('2026-08-01T11:00:00Z'),
    };
    const envelope = {
      businessId,
      command: 'RecordExpense' as const,
      payload: input,
      actor: 'system:recurring',
      ingress: 'AUTOMATION' as const,
      idempotencyKey: 'recurring:sched-1:2026-08-01',
    };

    const run = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordExpenseWork(tx, input)),
    );
    expect(run.outcome).toBe('done');

    /* A catch-up that fires the same raise twice replays, raising nothing. */
    const again = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordExpenseWork(tx, input)),
    );
    expect(again.outcome).toBe('done');
    if (again.outcome !== 'done') return;
    expect(again.replayed).toBe(true);
    expect(await count(businessId, 'expenses')).toBe(1);
  });

  it('the announcement never carries the description', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      recordExpenseWork(tx, {
        ...expenseInput(businessId),
        description: 'paid CUSTOMER_7K2 back for the taxi',
      }),
    );
    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ payload: Record<string, unknown> }>(
        sql`SELECT payload FROM outbox_events WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect(JSON.stringify([...rows][0]?.payload)).not.toContain('taxi');
  });
});

describe('RecordPurchase through the bus', () => {
  const purchaseInput = (businessId: string): RecordPurchaseCmdInput => ({
    businessId,
    description: '50 cartons from the market',
    amountK: 1_400_000,
    paidK: 1_000_000,
    method: 'cash',
    sourceType: 'chat',
    sourceId: 'draft-pur-1',
    supplierId: null,
    arrivals: [{ product: 'carton of noodles', quantity: 50, costK: 1_400_000 }],
  });

  it('books the money, lands the goods and announces, exactly once', async () => {
    const businessId = await seedBusiness();
    const input = purchaseInput(businessId);
    const envelope = {
      businessId,
      command: 'RecordPurchase' as const,
      payload: input,
      actor: 'system',
      ingress: 'CHAT' as const,
      idempotencyKey: 'draft:draft-pur-1',
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordPurchaseWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.result.owedK).toBe(400_000);
    expect(first.result.arrived).toEqual([{ name: 'carton of noodles', onHand: 50 }]);

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordPurchaseWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    /* The replay moved NO stock: still fifty on the shelf, not a hundred. */
    const product = await withBusiness(appDb, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'carton of noodles'),
    );
    expect(product?.onHand).toBe(50);
    expect(await count(businessId, 'outbox_events', "AND type = 'purchase.recorded'")).toBe(1);
  });

  it('the money, the goods and the announcement roll back together', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(appDb, businessId, async (tx) => {
        await recordPurchaseWork(tx, purchaseInput(businessId));
        throw new Error('after the work, before the commit');
      }),
    ).rejects.toThrow('after the work');

    expect(await count(businessId, 'expenses')).toBe(0);
    expect(await count(businessId, 'outbox_events')).toBe(0);
    const product = await withBusiness(appDb, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'carton of noodles'),
    );
    expect(product?.onHand ?? 0).toBe(0);
  });
});

/**
 * G-61: one confirmed purchase, paid part by transfer, is one financial event
 * however it is retried or raced, and a failure inside it leaves nothing.
 */
describe('a part-paid transfer purchase, raced and failed (G-61)', () => {
  const input = (businessId: string): RecordPurchaseCmdInput => ({
    businessId,
    description: '10 cartons from Emeka',
    amountK: 18_000_000,
    paidK: 10_000_000,
    method: 'transfer',
    sourceType: 'chat',
    sourceId: 'draft-g61',
    supplierId: null,
    arrivals: [{ product: 'carton of noodles', quantity: 10, costK: 18_000_000 }],
  });

  async function nets(businessId: string): Promise<Record<string, number>> {
    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ code: string; net: string }>(sql`
        SELECT a.code, SUM(e.debit_k - e.credit_k)::text AS net
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid GROUP BY a.code`),
    );
    return Object.fromEntries([...rows].map((r) => [r.code, Number(r.net)]));
  }

  it('two confirmations at once make one purchase, one posting, one arrival, one bill', async () => {
    const businessId = await seedBusiness();
    const run = () =>
      withBusiness(appDb, businessId, (tx) =>
        bus.run(
          tx,
          {
            businessId,
            command: 'RecordPurchase',
            payload: input(businessId),
            actor: 'system',
            ingress: 'CHAT',
            idempotencyKey: 'draft:draft-g61',
          },
          () => recordPurchaseWork(tx, input(businessId)),
        ),
      );
    const raced = await Promise.allSettled([run(), run()]);
    expect(raced.some((r) => r.status === 'fulfilled')).toBe(true);

    expect(await count(businessId, 'expenses')).toBe(1);
    expect(await count(businessId, 'bills')).toBe(1);
    expect(await count(businessId, 'ledger_transactions')).toBe(1);
    expect(await count(businessId, 'outbox_events', "AND type = 'purchase.recorded'")).toBe(1);
    const product = await withBusiness(appDb, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'carton of noodles'),
    );
    expect(product?.onHand).toBe(10);
    /* Inventory 1000-series, Bank 1020 for the paid part, AP 2000 for the
     * rest, and Cash untouched. */
    const net = await nets(businessId);
    expect(net['1020']).toBe(-10_000_000);
    expect(net['1000'] ?? 0).toBe(0);
    expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('a failure at the last write takes the posting, the row, the bill and the stock down', async () => {
    const businessId = await seedBusiness();
    expect(businessId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const { db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 1 });
    await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g61_fail_purchase_outbox ON outbox_events`);
    await ownerDb.execute(sql`
      CREATE OR REPLACE FUNCTION g61_fail_purchase_outbox() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.business_id = '${sql.raw(businessId)}'::uuid AND NEW.type = 'purchase.recorded' THEN
          RAISE EXCEPTION 'g61: forced failure at the last write';
        END IF;
        RETURN NEW;
      END $$`);
    await ownerDb.execute(sql`
      CREATE TRIGGER g61_fail_purchase_outbox BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION g61_fail_purchase_outbox()`);
    try {
      const failed = await withBusiness(appDb, businessId, (tx) =>
        recordPurchaseWork(tx, input(businessId)),
      ).then(
        () => null,
        (error: unknown) => error as Error & { cause?: unknown },
      );
      expect(String(failed) + String(failed?.cause)).toContain('g61: forced failure');
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g61_fail_purchase_outbox ON outbox_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g61_fail_purchase_outbox()`);
      await closeOwner();
    }
    for (const table of [
      'expenses',
      'bills',
      'ledger_transactions',
      'ledger_entries',
      'inventory_movements',
      'outbox_events',
      'doc_counters',
    ]) {
      expect(await count(businessId, table), table).toBe(0);
    }
  });
});

describe('the announcements reach the production dispatcher', () => {
  it('spend events are types the dispatcher handles', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, async (tx) => {
      await recordExpenseWork(tx, {
        businessId,
        description: 'fuel',
        category: null,
        amountK: 100_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-d1',
      });
      await recordPurchaseWork(tx, {
        businessId,
        description: 'stock',
        amountK: 200_000,
        paidK: 200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-d2',
        arrivals: [],
      });
    });

    const pass = await buildOutboxDispatcher().runOnce(workerDb);
    expect(pass.failed).toBe(0);
    expect(pass.delivered).toBe(2);
  });
});

/**
 * G-81 (OD-23): the final net against one purchase becoming two financial
 * truths sits in the purchase WORK, not only in the chat flow. Two chat
 * purchases of one total that nothing proves separate, confirmed at the same
 * moment on separate connections, book once: the work serialises them on an
 * advisory lock keyed by business and total and re-reads what is booked
 * before any posting. The loser throws before it writes anything.
 */
describe('two chat purchases of one total, at the same moment (G-81)', () => {
  const purchase = (businessId: string, sourceId: string): RecordPurchaseCmdInput => ({
    businessId,
    description: '10 cartons of Milo',
    amountK: 10_000_000,
    paidK: 10_000_000,
    method: 'cash',
    sourceType: 'chat',
    sourceId,
    supplierId: null,
    arrivals: [{ product: 'Milo', quantity: 10, costK: 10_000_000 }],
  });

  async function settle(businessId: string, ways: number) {
    /* One pool per confirmation: each runs on its own connection, in its
     * own transaction, exactly as two jobs on two worker lanes do. */
    const pools = Array.from({ length: ways }, () => createDb(urls.app, { max: 1 }));
    try {
      return await Promise.allSettled(
        pools.map(({ db }, i) =>
          withBusiness(db, businessId, (tx) =>
            recordPurchaseWork(tx, purchase(businessId, `00000000-0000-4000-8000-00000000000${i}`)),
          ),
        ),
      );
    } finally {
      await Promise.all(pools.map(({ close }) => close()));
    }
  }

  it('two confirmations on two connections book ONE purchase; the other writes nothing', async () => {
    const businessId = await seedBusiness();
    const raced = await settle(businessId, 2);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = raced.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused?.reason?.name).toBe('PurchaseIdentityCollision');
    expect(await count(businessId, 'expenses')).toBe(1);
    expect(await count(businessId, 'ledger_transactions')).toBe(1);
    expect(await count(businessId, 'inventory_movements')).toBe(1);
    expect(await count(businessId, 'outbox_events', "AND type = 'purchase.recorded'")).toBe(1);
  });

  it('eight at once still book exactly one', async () => {
    const businessId = await seedBusiness();
    const raced = await settle(businessId, 8);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count(businessId, 'expenses')).toBe(1);
  });

  it('a different total is never blocked', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      recordPurchaseWork(tx, purchase(businessId, '00000000-0000-4000-8000-0000000000a1')),
    );
    await withBusiness(appDb, businessId, (tx) =>
      recordPurchaseWork(tx, {
        ...purchase(businessId, '00000000-0000-4000-8000-0000000000a2'),
        amountK: 10_000_100,
      }),
    );
    expect(await count(businessId, 'expenses')).toBe(2);
  });

  it('a received purchase order is not a chat purchase and is not compared', async () => {
    const businessId = await seedBusiness();
    for (const id of ['po-1', 'po-2']) {
      await withBusiness(appDb, businessId, (tx) =>
        recordPurchaseWork(tx, { ...purchase(businessId, id), sourceType: 'purchase_order' }),
      );
    }
    expect(await count(businessId, 'expenses')).toBe(2);
  });
});
