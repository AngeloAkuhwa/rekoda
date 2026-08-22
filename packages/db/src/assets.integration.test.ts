/**
 * Things the business keeps and uses (ADR 0026), against real PostgreSQL.
 *
 * The claim that matters is not the shape of the row. It is that a generator
 * lands on the BALANCE SHEET and not in this month's profit, because the
 * whole reason this exists is that recording it as an expense reports a loss
 * the business did not make.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  isAccountKey,
  type AccountSums,
} from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { assetsRepo, identity, issueRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 6 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348130000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const buy = (businessId: string, over = {}) =>
  withBusiness(db, businessId, (tx) =>
    assetsRepo.recordAsset(tx, {
      businessId,
      description: 'Generator, 5.5kVA',
      costK: 45_000_000,
      paidK: 45_000_000,
      usefulLifeMonths: 60,
      method: 'transfer',
      actor: 'user:1',
      ...over,
    }),
  );

/**
 * The ledger, in the shape the statements read.
 *
 * Built from the entries the database actually holds rather than from what
 * the posting builder returned, so the assertions below describe what a
 * merchant's balance sheet says and not what core intended it to say.
 */
async function sumsOf(businessId: string): Promise<AccountSums[]> {
  const entries = await withBusiness(db, businessId, (tx) =>
    issueRepo.ledgerEntriesFor(tx, businessId),
  );
  const byAccount = new Map<string, { d: number; c: number }>();
  for (const e of entries) {
    const at = byAccount.get(e.account) ?? { d: 0, c: 0 };
    byAccount.set(e.account, { d: at.d + e.debitK, c: at.c + e.creditK });
  }
  return [...byAccount]
    .filter(([account]) => isAccountKey(account))
    .map(([account, n]) => ({
      account: account as AccountSums['account'],
      periodDebitK: n.d,
      periodCreditK: n.c,
      cumulativeDebitK: n.d,
      cumulativeCreditK: n.c,
    }));
}

describe('buying something the business keeps', () => {
  /**
   * The whole reason ADR 0026 exists, asserted through the statements a
   * merchant actually reads rather than through the row that was written.
   */
  it('lands on the balance sheet, and nowhere near this month`s profit', async () => {
    const businessId = await seedBusiness();
    await buy(businessId);

    const sums = await sumsOf(businessId);
    const sheet = buildBalanceSheet(sums);
    const pnl = buildProfitAndLoss(sums);

    const equipment = sheet.assets.find((l) => l.account === 'EQUIPMENT');
    expect(equipment?.amountK).toBe(45_000_000);
    /* Money left the bank; the value did not leave the business. */
    expect(sheet.assets.find((l) => l.account === 'BANK')?.amountK).toBe(-45_000_000);
    expect(sheet.totalAssetsK).toBe(0);

    /* Not a naira of it reaches the profit and loss. */
    expect(pnl.totalExpensesK).toBe(0);
    expect(pnl.netProfitK).toBe(0);
  });

  it('carries what is still owed to the supplier', async () => {
    const businessId = await seedBusiness();
    const recorded = await buy(businessId, { costK: 30_000_000, paidK: 10_000_000 });
    expect(recorded.owedK).toBe(20_000_000);

    const sheet = buildBalanceSheet(await sumsOf(businessId));
    expect(sheet.liabilities.find((l) => l.account === 'ACCOUNTS_PAYABLE')?.amountK).toBe(
      20_000_000,
    );
  });

  it('refuses figures that make no sense, before anything is written', async () => {
    const businessId = await seedBusiness();
    await expect(buy(businessId, { costK: 0 })).rejects.toBeTruthy();
    await expect(buy(businessId, { costK: 100, paidK: 101 })).rejects.toBeTruthy();
    /* And the books are untouched. */
    expect(await sumsOf(businessId)).toEqual([]);
  });

  it('reads back what the business owns, with nothing charged yet', async () => {
    const businessId = await seedBusiness();
    await buy(businessId);

    const [asset] = await withBusiness(db, businessId, (tx) =>
      assetsRepo.assetsFor(tx, businessId),
    );
    expect(asset).toMatchObject({
      description: 'Generator, 5.5kVA',
      costK: 45_000_000,
      usefulLifeMonths: 60,
      monthsCharged: 0,
      chargedK: 0,
      /* Nothing used up yet, so it is worth what it cost. */
      bookValueK: 45_000_000,
      status: 'recorded',
    });
  });

  it('is one business at a time', async () => {
    const ada = await seedBusiness('+2348130000001');
    const bola = await seedBusiness('+2348130000002');
    await buy(ada);

    expect(await withBusiness(db, bola, (tx) => assetsRepo.assetsFor(tx, bola))).toEqual([]);
  });
});

describe('taking one back out', () => {
  it('mirrors the posting, so the balance sheet returns to where it was', async () => {
    const businessId = await seedBusiness();
    const recorded = await buy(businessId);

    expect(
      await withBusiness(db, businessId, (tx) =>
        assetsRepo.withdrawAsset(tx, {
          businessId,
          assetId: recorded.assetId,
          reason: 'recorded twice',
          actor: 'user:1',
        }),
      ),
    ).toMatchObject({ outcome: 'withdrawn', reversedK: 45_000_000 });

    const sheet = buildBalanceSheet(await sumsOf(businessId));
    expect(sheet.assets.find((l) => l.account === 'EQUIPMENT')?.amountK ?? 0).toBe(0);
    expect(sheet.assets.find((l) => l.account === 'BANK')?.amountK ?? 0).toBe(0);

    /* And it reads as withdrawn, worth nothing, rather than disappearing. */
    const [asset] = await withBusiness(db, businessId, (tx) =>
      assetsRepo.assetsFor(tx, businessId),
    );
    expect(asset).toMatchObject({ status: 'withdrawn', bookValueK: 0 });
  });

  it('refuses one that is gone, and one already withdrawn', async () => {
    const businessId = await seedBusiness();
    const recorded = await buy(businessId);
    const withdraw = (assetId: string) =>
      withBusiness(db, businessId, (tx) =>
        assetsRepo.withdrawAsset(tx, { businessId, assetId, reason: 'twice', actor: 'user:1' }),
      );

    expect(await withdraw(recorded.assetId)).toMatchObject({ outcome: 'withdrawn' });
    expect(await withdraw(recorded.assetId)).toEqual({ outcome: 'already_withdrawn' });
    expect(await withdraw('00000000-0000-4000-8000-000000000000')).toEqual({
      outcome: 'not_found',
    });
  });

  /* A thing the business bought is a fact. Deciding it was never bought is a
   * withdrawal, not a deletion, and the grant is what enforces that. */
  it('holds no DELETE on the record', async () => {
    const businessId = await seedBusiness();
    await buy(businessId);

    const refused = await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`DELETE FROM fixed_assets WHERE business_id = ${businessId}::uuid`),
    ).catch((error: unknown) => {
      for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
        const candidate = e as { code?: string; cause?: unknown };
        if (candidate.code === '42501') return candidate;
        e = candidate.cause;
      }
      return {};
    });
    expect(refused).toMatchObject({ code: '42501' });
  });
});
