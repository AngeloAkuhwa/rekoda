/**
 * The order of the gates (spec §25, §26, §4.3, Appendix D).
 *
 * Each gate is tested where it lives. What this suite asserts is that they
 * run in one fixed order and that nothing can enter the sequence halfway,
 * because the order is the safety property: entitlement before anything is
 * taken, risk before a key is claimed, the key before the work, the answer
 * inside the same transaction as the work.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  billingRepo,
  createDb,
  identity,
  idempotencyRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { CommandBus, requestHash } from './command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;
const bus = new CommandBus(new RiskPolicyService());
const policy = new RiskPolicyService();

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedOn(plan: string): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481900${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await billingRepo.setPlan(db, {
    businessId: business.id,
    plan: plan as 'chat' | 'integrate' | 'complete',
    expiresAt: null,
    actor: 'operator:test',
  });
  return business.id;
}

describe('the order the gates run in', () => {
  /**
   * Entitlement first, and the work never runs. Spec §4.3 rule 1: a refused
   * request consumes nothing, which includes consuming an idempotency key
   * the merchant would then be unable to retry with.
   */
  it('refuses an unentitled command before it does anything', async () => {
    const businessId = await seedOn('chat');
    let ran = false;
    const outcome = await withBusiness(db, businessId, (tx) =>
      bus.run(
        tx,
        {
          businessId,
          command: 'PlaceOrder',
          payload: { total: 1 },
          actor: 'user:ada',
          ingress: 'STOREFRONT',
          idempotencyKey: 'idem-unentitled',
        },
        async () => {
          ran = true;
          return { ok: true };
        },
      ),
    );

    expect(outcome).toEqual({
      outcome: 'not_entitled',
      missing: 'REKODA_INTEGRATE',
      plan: 'chat',
    });
    expect(ran).toBe(false);

    /* And the key is untouched, so the merchant can use it on a plan that
     * carries the capability rather than being told it is spent. */
    const record = await withBusiness(db, businessId, (tx) =>
      idempotencyRepo.find(tx, businessId, 'idem-unentitled'),
    );
    expect(record).toBeNull();
  });

  /**
   * Risk before the key. A command the away assistant may never run must not
   * leave a record suggesting it once tried.
   */
  it('refuses the away assistant before it takes a key', async () => {
    const businessId = await seedOn('complete');
    let ran = false;
    const outcome = await withBusiness(db, businessId, (tx) =>
      bus.run(
        tx,
        {
          businessId,
          command: 'RefundPayment',
          payload: { paymentId: 'pay_1' },
          actor: 'assistant',
          ingress: 'AWAY_ASSISTANT',
          idempotencyKey: 'idem-assistant',
        },
        async () => {
          ran = true;
          return { ok: true };
        },
      ),
    );

    expect(outcome).toEqual({ outcome: 'refused', reason: 'away_assistant_forbidden' });
    expect(ran).toBe(false);
    expect(
      await withBusiness(db, businessId, (tx) =>
        idempotencyRepo.find(tx, businessId, 'idem-assistant'),
      ),
    ).toBeNull();
  });

  it('asks for a confirmation before it takes a key', async () => {
    const businessId = await seedOn('complete');
    let ran = false;
    const outcome = await withBusiness(db, businessId, (tx) =>
      bus.run(
        tx,
        {
          businessId,
          command: 'RefundPayment',
          payload: { paymentId: 'pay_1' },
          actor: 'user:ada',
          ingress: 'DASHBOARD',
          idempotencyKey: 'idem-unconfirmed',
        },
        async () => {
          ran = true;
          return { ok: true };
        },
      ),
    );
    expect(outcome).toEqual({ outcome: 'confirm_first', tier: 'HIGH_RISK' });
    expect(ran).toBe(false);
  });

  /** With the confirmation in hand it runs, once, and the key holds the answer. */
  it('runs a confirmed high-risk command and remembers the answer', async () => {
    const businessId = await seedOn('complete');
    const opened = await withBusiness(db, businessId, (tx) =>
      policy.ask(tx, {
        businessId,
        command: 'RefundPayment',
        subject: 'pay_1',
        actor: 'user:ada',
        ingress: 'DASHBOARD',
        consequence: 'Refund ₦20,000 to Ada. The money leaves your account.',
        reason: 'customer returned the wig unworn',
      }),
    );

    let runs = 0;
    const envelope = {
      businessId,
      command: 'RefundPayment' as const,
      payload: { paymentId: 'pay_1' },
      actor: 'user:ada',
      ingress: 'DASHBOARD' as const,
      subject: 'pay_1',
      confirmationId: opened.id,
      idempotencyKey: 'idem-refund',
    };
    const first = await withBusiness(db, businessId, (tx) =>
      bus.run(tx, envelope, async () => {
        runs += 1;
        return { refunded: 20_000 };
      }),
    );
    expect(first).toEqual({ outcome: 'done', result: { refunded: 20_000 }, replayed: false });
    expect(runs).toBe(1);
  });
});

describe('a key the caller offered', () => {
  const envelope = (businessId: string, over: Record<string, unknown> = {}) => ({
    businessId,
    command: 'RecordSale' as const,
    payload: { total: 45_000, customer: 'Ada' },
    actor: 'user:ada',
    ingress: 'DASHBOARD' as const,
    idempotencyKey: 'idem-sale',
    ...over,
  });

  it('runs the work once and replays the answer after that', async () => {
    const businessId = await seedOn('chat');
    let runs = 0;
    const work = async () => {
      runs += 1;
      return { invoice: 'INV-2026-000041' };
    };

    const first = await withBusiness(db, businessId, (tx) =>
      bus.run(tx, envelope(businessId), work),
    );
    const second = await withBusiness(db, businessId, (tx) =>
      bus.run(tx, envelope(businessId), work),
    );

    expect(first).toEqual({
      outcome: 'done',
      result: { invoice: 'INV-2026-000041' },
      replayed: false,
    });
    expect(second).toEqual({
      outcome: 'done',
      result: { invoice: 'INV-2026-000041' },
      replayed: true,
    });
    expect(runs).toBe(1);
  });

  /* The client bug, named rather than hidden behind a plausible answer. */
  it('refuses the same key for a different payload', async () => {
    const businessId = await seedOn('chat');
    await withBusiness(db, businessId, (tx) =>
      bus.run(tx, envelope(businessId), async () => ({ ok: true })),
    );
    const reused = await withBusiness(db, businessId, (tx) =>
      bus.run(tx, envelope(businessId, { payload: { total: 999_999 } }), async () => ({
        ok: true,
      })),
    );
    expect(reused).toEqual({ outcome: 'key_reused', commandName: 'RecordSale' });
  });

  /**
   * A caller with no key accepts that a retry runs again. Said out loud
   * because the alternative — inventing a key from the payload — would make
   * two genuinely separate identical sales into one.
   */
  it('runs every time when no key is offered', async () => {
    const businessId = await seedOn('chat');
    let runs = 0;
    const work = async () => {
      runs += 1;
      return { n: runs };
    };
    const bare = { ...envelope(businessId), idempotencyKey: null };
    await withBusiness(db, businessId, (tx) => bus.run(tx, bare, work));
    await withBusiness(db, businessId, (tx) => bus.run(tx, bare, work));
    expect(runs).toBe(2);
  });

  /**
   * The snapshot and the work share the caller's transaction. A command that
   * fails after answering leaves no record, so the retry is a first attempt
   * rather than a replay of something that never happened.
   */
  it('leaves no answer behind when the work fails', async () => {
    const businessId = await seedOn('chat');
    await expect(
      withBusiness(db, businessId, (tx) =>
        bus.run(tx, envelope(businessId), async () => {
          throw new Error('the sale did not post');
        }),
      ),
    ).rejects.toThrow('the sale did not post');

    const record = await withBusiness(db, businessId, (tx) =>
      idempotencyRepo.find(tx, businessId, 'idem-sale'),
    );
    expect(record).toBeNull();
  });
});

describe('the request fingerprint', () => {
  it('is the same however a client ordered the fields', () => {
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: { x: 1, y: 2 } })).toBe(requestHash({ a: { y: 2, x: 1 } }));
  });

  it('changes when the request does', () => {
    expect(requestHash({ total: 45_000 })).not.toBe(requestHash({ total: 45_001 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: '1' }));
  });

  /* Arrays are ordered data, so their order is part of the request: two
   * line items swapped is a different invoice, not the same one. */
  it('keeps array order significant', () => {
    expect(requestHash([1, 2])).not.toBe(requestHash([2, 1]));
  });
});
