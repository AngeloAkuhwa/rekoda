/**
 * A correction written by hand, against real PostgreSQL.
 *
 * The claims worth proving are the ones that make this safe to offer at all:
 * that it always balances, that it is marked as hand written so nothing
 * downstream mistakes it for a sale, that it takes a number an accountant can
 * quote, and that the close guard reaches it like any other posting.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { lagosNoon } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { closeRepo, identity, issueRepo, journalRepo } from './index.js';
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

const record = (
  businessId: string,
  over: Partial<Parameters<typeof journalRepo.recordJournal>[1]> = {},
) =>
  withBusiness(db, businessId, (tx) =>
    journalRepo.recordJournal(tx, {
      businessId,
      memo: "Took the day's takings to the bank",
      amountK: 5_000_000,
      intoAccount: 'BANK_PAYSTACK',
      outOfAccount: 'CASH',
      actor: 'user:1',
      ...over,
    }),
  );

describe('a correction written by hand', () => {
  it('writes both sides from one amount, and they agree', async () => {
    const businessId = await seedBusiness('+2348090000001');
    const recorded = await record(businessId);
    expect(recorded.journalNumber).toMatch(/^JNL-\d{4}-\d{6}$/);

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const debits = entries.reduce((n, e) => n + Number(e.debitK), 0);
    const credits = entries.reduce((n, e) => n + Number(e.creditK), 0);
    expect(debits).toBe(credits);
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'BANK_PAYSTACK', debitK: 5_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'CASH', creditK: 5_000_000 }),
    );
  });

  /**
   * The mark is what keeps everything downstream honest. The revenue
   * schedule, the expense schedule and the audit trail all read source type,
   * and a hand written entry that looked like a sale would be worse than no
   * entry at all: it would show up as income the business never earned.
   */
  it('is marked as hand written, not as a business event', async () => {
    const businessId = await seedBusiness('+2348090000002');
    const recorded = await record(businessId, {
      intoAccount: 'CASH',
      outOfAccount: 'SALES_REVENUE',
    });

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ source_type: string; source_id: string; memo: string }>(sql`
        SELECT source_type, source_id, memo FROM ledger_transactions
        WHERE business_id = ${businessId}::uuid
      `),
    );
    expect([...rows][0]).toMatchObject({
      source_type: 'journal',
      source_id: recorded.journalNumber,
    });
    /* The number is in the memo too, so a trial balance line can be traced
     * back without joining anything. */
    expect([...rows][0]!.memo).toContain(recorded.journalNumber);
  });

  it('numbers them in sequence, on their own counter', async () => {
    const businessId = await seedBusiness('+2348090000003');
    const first = await record(businessId);
    const second = await record(businessId, { memo: 'And the rest of it' });
    expect(first.journalNumber).toMatch(/-000001$/);
    expect(second.journalNumber).toMatch(/-000002$/);

    /* An invoice raised afterwards still starts at one: separate counters. */
    const invoiceNumber = await withBusiness(db, businessId, (tx) =>
      issueRepo.nextDocumentNumber(tx, businessId, 'invoice', 2026),
    );
    expect(invoiceNumber).toMatch(/^INV-2026-000001$/);
  });

  it('refuses an entry into and out of the same place, before writing anything', async () => {
    const businessId = await seedBusiness('+2348090000004');
    await expect(
      record(businessId, { intoAccount: 'CASH', outOfAccount: 'CASH' }),
    ).rejects.toBeInstanceOf(RangeError);

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries).toEqual([]);
  });

  it('refuses nothing, and refuses less than nothing', async () => {
    const businessId = await seedBusiness('+2348090000005');
    for (const amountK of [0, -100]) {
      await expect(record(businessId, { amountK })).rejects.toBeTruthy();
    }
    expect(
      await withBusiness(db, businessId, (tx) => issueRepo.ledgerEntriesFor(tx, businessId)),
    ).toEqual([]);
  });

  it('lands on the day it is given rather than the day it was typed', async () => {
    const businessId = await seedBusiness('+2348090000006');
    await record(businessId, { occurredAt: lagosNoon('2026-06-10') });

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ created_at: string }>(sql`
        SELECT created_at FROM ledger_transactions WHERE business_id = ${businessId}::uuid
      `),
    );
    expect(new Date([...rows][0]!.created_at).toISOString()).toBe('2026-06-10T11:00:00.000Z');
  });

  /**
   * The escape hatch is not an escape from the close. A correction aimed at a
   * month the merchant filed is refused by the same trigger as everything
   * else, which is the point of putting the guard on writePosting rather than
   * on each caller.
   */
  it('cannot reach into a month that has been closed', async () => {
    const businessId = await seedBusiness('+2348090000007');
    await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, { businessId, through: '2026-03', actor: 'user:1' }),
    );

    await expect(
      record(businessId, { occurredAt: lagosNoon('2026-03-15') }),
    ).rejects.toBeInstanceOf(closeRepo.PeriodClosed);
    expect(
      await withBusiness(db, businessId, (tx) => issueRepo.ledgerEntriesFor(tx, businessId)),
    ).toEqual([]);
  });

  it('records who wrote it, and what they said it was for', async () => {
    const businessId = await seedBusiness('+2348090000008');
    const recorded = await record(businessId);

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ action: string; actor: string; entity_id: string }>(sql`
        SELECT action, actor, entity_id FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'journal'
      `),
    );
    expect([...rows][0]).toMatchObject({
      action: 'recorded',
      actor: 'user:1',
      entity_id: recorded.journalNumber,
    });
  });

  it('is one business at a time', async () => {
    const ada = await seedBusiness('+2348090000009');
    const bola = await seedBusiness('+2348090000010');
    await record(ada);

    expect(await withBusiness(db, bola, (tx) => issueRepo.ledgerEntriesFor(tx, bola))).toEqual([]);
    /* And Bola's own numbering starts at one. */
    await expect(record(bola)).resolves.toMatchObject({
      journalNumber: expect.stringMatching(/-000001$/),
    });
  });
});
