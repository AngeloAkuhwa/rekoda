/**
 * Closing a month, against real PostgreSQL.
 *
 * The claim worth proving is not that a repository function returns the right
 * shape. It is that the DATABASE refuses, because a check the writer is
 * trusted to make is exactly the weaker thing a close exists to replace. So
 * these tests go around the repository wherever they can, and post the way a
 * writer added next year would.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { lagosNoon, postPurchase } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { closeRepo, identity, issueRepo, spendRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Mama Chidi Stores',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** Far enough in the past that the current month never reaches it. */
const OLD = '2026-03';
const OLD_DAY = '2026-03-15';

const closeThrough = (businessId: string, through: string) =>
  withBusiness(db, businessId, (tx) =>
    closeRepo.closeBooks(tx, { businessId, through, actor: 'user:1' }),
  );

const reopenFrom = (businessId: string, from: string) =>
  withBusiness(db, businessId, (tx) =>
    closeRepo.reopenBooks(tx, { businessId, from, actor: 'user:1' }),
  );

/** A backdated posting through the ordinary writer. */
const postDated = (businessId: string, day: string, ref = 'p1') =>
  withBusiness(db, businessId, (tx) =>
    issueRepo.writePosting(
      tx,
      businessId,
      postPurchase({ memo: 'Restocked the shop', amountK: 5_000_000 }),
      'purchase',
      ref,
      { occurredAt: lagosNoon(day) },
    ),
  );

/**
 * The driver wraps a server error, so the refusal is on the cause chain
 * rather than on the message. Unwrapped here so a test asserts what
 * PostgreSQL actually said instead of what postgres.js wrote around it.
 */
function refusal(error: unknown): { code?: string; message?: string } {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const candidate = e as { code?: string; message?: string; cause?: unknown };
    if (candidate.code === '23514') return candidate;
    e = candidate.cause;
  }
  return {};
}

const ledgerCount = async (businessId: string): Promise<number> => {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ n: string }>(sql`
      SELECT COUNT(*)::bigint AS n FROM ledger_transactions
      WHERE business_id = ${businessId}::uuid
    `),
  );
  return Number([...rows][0]!.n);
};

describe('closing a month', () => {
  it('starts open, and says so with a null rather than a date', async () => {
    const businessId = await seedBusiness('+2348070000001');
    expect(
      await withBusiness(db, businessId, (tx) => closeRepo.booksClosedThroughFor(tx, businessId)),
    ).toBeNull();
  });

  it('refuses a month that has not ended', async () => {
    const businessId = await seedBusiness('+2348070000002');
    const current = closeRepo.periodOf(new Date());
    expect(await closeThrough(businessId, current)).toEqual({ outcome: 'not_ended' });
    expect(
      await withBusiness(db, businessId, (tx) => closeRepo.booksClosedThroughFor(tx, businessId)),
    ).toBeNull();
  });

  /**
   * The refusal that makes the whole thing worth having. The posting goes
   * through the ordinary writer with an ordinary backdate, which is exactly
   * what a caught-up recurring entry or a late expense looks like.
   */
  it('refuses a backdated posting once the month is closed', async () => {
    const businessId = await seedBusiness('+2348070000003');
    await expect(postDated(businessId, OLD_DAY)).resolves.toBeTruthy();
    expect(await ledgerCount(businessId)).toBe(1);

    expect(await closeThrough(businessId, OLD)).toEqual({ outcome: 'closed', through: OLD });

    await expect(postDated(businessId, OLD_DAY, 'p2')).rejects.toBeInstanceOf(
      closeRepo.PeriodClosed,
    );
    /* And nothing was written. A refusal that left half a posting behind
     * would be worse than no refusal at all. */
    expect(await ledgerCount(businessId)).toBe(1);
  });

  it('refuses every month before the watermark too, not only the named one', async () => {
    const businessId = await seedBusiness('+2348070000004');
    await closeThrough(businessId, '2026-05');
    await expect(postDated(businessId, '2026-02-10')).rejects.toBeInstanceOf(
      closeRepo.PeriodClosed,
    );
    await expect(postDated(businessId, '2026-05-31', 'p2')).rejects.toBeInstanceOf(
      closeRepo.PeriodClosed,
    );
  });

  it('lets the month after the watermark through', async () => {
    const businessId = await seedBusiness('+2348070000005');
    await closeThrough(businessId, '2026-03');
    await expect(postDated(businessId, '2026-04-01')).resolves.toBeTruthy();
    expect(await ledgerCount(businessId)).toBe(1);
  });

  /**
   * The blast radius, stated as a test. Every live posting is stamped now,
   * and only a month that has ENDED can be closed, so nothing a merchant does
   * today can ever meet the guard. If that stopped being true, this fails.
   */
  it('never touches a posting made today', async () => {
    const businessId = await seedBusiness('+2348070000006');
    await closeThrough(businessId, OLD);
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'diesel',
        category: null,
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd1',
      }),
    );
    expect(await ledgerCount(businessId)).toBe(1);
  });

  /**
   * The guarantee, reached the way a writer added next year would reach it:
   * straight at the table, with no repository in the path at all. If this
   * ever passes, the close has become a suggestion.
   */
  it('is the database that refuses, not the repository', async () => {
    const businessId = await seedBusiness('+2348070000007');
    await closeThrough(businessId, OLD);

    const refused = await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO ledger_transactions (business_id, memo, source_type, source_id, created_at)
        VALUES (${businessId}::uuid, 'straight at the table', 'manual', 'x',
                ${lagosNoon(OLD_DAY).toISOString()}::timestamptz)
      `),
    ).catch((error: unknown) => refusal(error));
    expect(refused).toMatchObject({
      code: '23514',
      message: expect.stringContaining('closed through 2026-03'),
    });
    expect(await ledgerCount(businessId)).toBe(0);
  });

  /**
   * The entries carry their own date, stamped from the same occurredAt. A
   * transaction inside an open month whose ENTRIES were dated into a closed
   * one would move exactly the figures a close protects.
   */
  it('refuses entries dated into a closed month, whatever their transaction says', async () => {
    const businessId = await seedBusiness('+2348070000008');
    await closeThrough(businessId, OLD);
    const txId = await postDated(businessId, '2026-06-10');

    const refused = await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO ledger_entries
          (business_id, transaction_id, account, debit_k, credit_k, created_at)
        VALUES (${businessId}::uuid, ${txId}::uuid, 'CASH', 100, 0,
                ${lagosNoon(OLD_DAY).toISOString()}::timestamptz)
      `),
    ).catch((error: unknown) => refusal(error));
    expect(refused).toMatchObject({ code: '23514' });
  });

  it('will not close earlier than it already has', async () => {
    const businessId = await seedBusiness('+2348070000009');
    await closeThrough(businessId, '2026-05');
    expect(await closeThrough(businessId, '2026-03')).toEqual({
      outcome: 'already_closed',
      through: '2026-05',
    });
    expect(await closeThrough(businessId, '2026-05')).toEqual({
      outcome: 'already_closed',
      through: '2026-05',
    });
  });

  it('is one business at a time', async () => {
    const ada = await seedBusiness('+2348070000010');
    const bola = await seedBusiness('+2348070000011');
    await closeThrough(ada, OLD);

    expect(
      await withBusiness(db, bola, (tx) => closeRepo.booksClosedThroughFor(tx, bola)),
    ).toBeNull();
    await expect(postDated(bola, OLD_DAY)).resolves.toBeTruthy();
  });
});

describe('opening a closed month back up', () => {
  it('moves the watermark back one month and lets the entry through', async () => {
    const businessId = await seedBusiness('+2348070000020');
    await closeThrough(businessId, OLD);
    await expect(postDated(businessId, OLD_DAY)).rejects.toBeInstanceOf(closeRepo.PeriodClosed);

    expect(await reopenFrom(businessId, OLD)).toEqual({
      outcome: 'reopened',
      from: OLD,
      wasClosedThrough: OLD,
    });
    await expect(postDated(businessId, OLD_DAY, 'p2')).resolves.toBeTruthy();
  });

  /**
   * One watermark cannot hold "July open, August closed", so reopening the
   * earlier month necessarily opens the later one. Pinned rather than left
   * implicit, because a merchant who is told otherwise would call it a bug.
   */
  it('opens every month after the one it is given', async () => {
    const businessId = await seedBusiness('+2348070000021');
    await closeThrough(businessId, '2026-05');

    expect(await reopenFrom(businessId, '2026-03')).toEqual({
      outcome: 'reopened',
      from: '2026-03',
      wasClosedThrough: '2026-05',
    });
    await expect(postDated(businessId, '2026-05-20')).resolves.toBeTruthy();
  });

  it('crosses a year boundary without inventing a month', async () => {
    const businessId = await seedBusiness('+2348070000022');
    await closeThrough(businessId, '2026-01');
    await reopenFrom(businessId, '2026-01');
    expect(
      await withBusiness(db, businessId, (tx) => closeRepo.booksClosedThroughFor(tx, businessId)),
    ).toBe('2025-12');
  });

  it('says so plainly when the month was never closed', async () => {
    const businessId = await seedBusiness('+2348070000023');
    expect(await reopenFrom(businessId, OLD)).toEqual({ outcome: 'already_open' });
    await closeThrough(businessId, '2026-03');
    expect(await reopenFrom(businessId, '2026-06')).toEqual({ outcome: 'already_open' });
  });

  it('records both the close and the reopening, with who did each', async () => {
    const businessId = await seedBusiness('+2348070000024');
    await closeThrough(businessId, OLD);
    await reopenFrom(businessId, OLD);

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ action: string; actor: string; entity_id: string }>(sql`
        SELECT action, actor, entity_id FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'books'
        ORDER BY created_at
      `),
    );
    expect([...rows].map((r) => r.action)).toEqual(['closed', 'reopened']);
    expect([...rows].every((r) => r.actor === 'user:1')).toBe(true);
  });
});
