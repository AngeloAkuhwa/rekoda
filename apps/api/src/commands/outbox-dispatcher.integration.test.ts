/**
 * The dispatcher end of the outbox (spec §26; PR-020), driven exactly the way
 * production drives it: `buildOutboxDispatcher()` plus `runOnce(workerDb)`.
 *
 * The table-level guarantees (atomicity with the business write, arrival
 * order, no double claim across dispatchers, dead after max attempts) are
 * proved in packages/db against the repo. What belongs HERE is the seam the
 * repo cannot see: a registered handler receives the event exactly once, a
 * throwing handler leaves the event to be retried, an event nobody handles
 * fails loudly instead of vanishing, and a second registration for one type
 * is refused at wiring time rather than fought over at delivery time.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, outboxRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { buildOutboxDispatcher } from '../jobs/jobs.module.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
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

async function appendEvent(
  businessId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const { id } = await withBusiness(appDb, businessId, (tx) =>
    outboxRepo.append(tx, { businessId, type, payload }),
  );
  return id;
}

describe('the production wiring', () => {
  it('builds the dispatcher production runs, with every command event handled', () => {
    /* The registry IS the contract: each command PR that adds an event type
     * adds its type here, and a type emitted anywhere but registered nowhere
     * would go dead in production — this list is what keeps that impossible. */
    const dispatcher = buildOutboxDispatcher();
    expect(dispatcher).toBeInstanceOf(OutboxDispatcher);
    expect(dispatcher.types().sort()).toEqual([
      'expense.recorded',
      'financial_transactions.ingested',
      'invoice.issued',
      'journal.posted',
      'order.placed',
      'payment.confirmed',
      'payment.recorded',
      'period.closed',
      'purchase.recorded',
      'reconciliation.confirmed',
      'sale.recorded',
    ]);
  });

  it('refuses a second handler for the same type at wiring time', () => {
    const dispatcher = new OutboxDispatcher();
    dispatcher.register('sale.recorded', async () => {});
    expect(() => dispatcher.register('sale.recorded', async () => {})).toThrow(
      /already has a handler/,
    );
  });
});

describe('delivery', () => {
  it('hands a committed event to its handler exactly once', async () => {
    const businessId = await seedBusiness();
    const seen: outboxRepo.ClaimedEvent[] = [];
    const dispatcher = new OutboxDispatcher();
    dispatcher.register('sale.recorded', async (event) => {
      seen.push(event);
    });

    await appendEvent(businessId, 'sale.recorded', { saleId: 'sale-1' });

    const first = await dispatcher.runOnce(workerDb);
    expect(first).toEqual({ delivered: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.businessId).toBe(businessId);
    expect(seen[0]?.payload).toEqual({ saleId: 'sale-1' });

    /* The second pass finds nothing: dispatched means done, not eligible. */
    const second = await dispatcher.runOnce(workerDb);
    expect(second).toEqual({ delivered: 0, failed: 0 });
    expect(seen).toHaveLength(1);
  });

  it('delivers a batch in arrival order', async () => {
    const businessId = await seedBusiness();
    const order: string[] = [];
    const dispatcher = new OutboxDispatcher();
    dispatcher.register('sale.recorded', async (event) => {
      order.push(String(event.payload['n']));
    });

    for (const n of ['1', '2', '3']) {
      await appendEvent(businessId, 'sale.recorded', { n });
    }

    const pass = await dispatcher.runOnce(workerDb);
    expect(pass.delivered).toBe(3);
    expect(order).toEqual(['1', '2', '3']);
  });

  it('one poisoned event does not dam the queue behind it', async () => {
    const businessId = await seedBusiness();
    const delivered: string[] = [];
    const dispatcher = new OutboxDispatcher();
    dispatcher.register('sale.recorded', async (event) => {
      if (event.payload['n'] === 'poison') throw new Error('handler exploded');
      delivered.push(String(event.payload['n']));
    });

    await appendEvent(businessId, 'sale.recorded', { n: '1' });
    await appendEvent(businessId, 'sale.recorded', { n: 'poison' });
    await appendEvent(businessId, 'sale.recorded', { n: '3' });

    const pass = await dispatcher.runOnce(workerDb);
    expect(pass).toEqual({ delivered: 2, failed: 1 });
    expect(delivered).toEqual(['1', '3']);
  });

  it('a throwing handler leaves the event to be retried, and a fix collects it', async () => {
    const businessId = await seedBusiness();
    let healthy = false;
    const attempts: number[] = [];
    const dispatcher = new OutboxDispatcher();
    dispatcher.register('sale.recorded', async (event) => {
      attempts.push(event.attempts);
      if (!healthy) throw new Error('downstream is down');
    });

    await appendEvent(businessId, 'sale.recorded');

    const failing = await dispatcher.runOnce(workerDb);
    expect(failing).toEqual({ delivered: 0, failed: 1 });

    /* markFailed released the lease, so the very next pass may retry. */
    healthy = true;
    const recovered = await dispatcher.runOnce(workerDb);
    expect(recovered).toEqual({ delivered: 1, failed: 0 });
    /* The retry carries the incremented attempt count: the handler can see
     * it is not the first try, which is what makes backoff decisions possible. */
    expect(attempts).toEqual([0, 1]);
  });

  it('an event nobody handles fails and retries rather than vanishing', async () => {
    const businessId = await seedBusiness();
    const dispatcher = new OutboxDispatcher();

    await appendEvent(businessId, 'type.from.a.newer.deploy');

    const pass = await dispatcher.runOnce(workerDb);
    expect(pass).toEqual({ delivered: 0, failed: 1 });

    /* A newer worker that DOES know the type collects it on its next pass —
     * the rolling-deploy story the empty-registry failure mode exists for. */
    const newer = new OutboxDispatcher();
    const seen: string[] = [];
    newer.register('type.from.a.newer.deploy', async (event) => {
      seen.push(event.id);
    });
    const collected = await newer.runOnce(workerDb);
    expect(collected).toEqual({ delivered: 1, failed: 0 });
    expect(seen).toHaveLength(1);
  });

  it('an unhandled event exhausts its attempts and goes visibly dead', async () => {
    const businessId = await seedBusiness();
    const dispatcher = new OutboxDispatcher();

    const id = await appendEvent(businessId, 'type.nobody.ever.handles');

    for (let i = 0; i < 8; i += 1) {
      const pass = await dispatcher.runOnce(workerDb);
      expect(pass.failed).toBe(1);
    }
    /* Attempt nine never happens: the event is dead, not eligible... */
    const after = await dispatcher.runOnce(workerDb);
    expect(after).toEqual({ delivered: 0, failed: 0 });

    /* ...and dead means VISIBLE, because a silent loss is the one outcome
     * the outbox exists to make impossible. */
    const dead = await outboxRepo.deadEvents(workerDb);
    expect(dead.map((event) => event.id)).toContain(id);
  });
});
