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

describe('selling or scrapping one', () => {
  /* Enough wear on the books that book value and cost are plainly different,
   * which is the whole point of what follows. */
  async function wornGenerator(businessId: string) {
    const recorded = await buy(businessId);
    for (let m = 0; m < 12; m++) {
      await withBusiness(db, businessId, (tx) =>
        assetsRepo.chargeOneMonth(tx, {
          businessId,
          assetId: recorded.assetId,
          expectMonthsCharged: m,
          at: new Date(),
        }),
      );
    }
    return recorded;
  }

  /**
   * The arithmetic that must not double-count. Bought for ₦450,000, worn to
   * ₦360,000, sold for ₦200,000 is a ₦160,000 loss — not ₦250,000, because
   * the other ₦90,000 already reached the profit and loss a month at a time.
   */
  it('measures the result against book value, never against the price paid', async () => {
    const businessId = await seedBusiness();
    const recorded = await wornGenerator(businessId);

    expect(
      await withBusiness(db, businessId, (tx) =>
        assetsRepo.disposeAsset(tx, {
          businessId,
          assetId: recorded.assetId,
          proceedsK: 20_000_000,
          method: 'transfer',
          actor: 'user:1',
        }),
      ),
    ).toMatchObject({
      outcome: 'sold',
      bookValueK: 36_000_000,
      resultK: -16_000_000,
    });
  });

  /**
   * The balance sheet must have nothing left of it: not the cost, and not the
   * wear recorded against it. A stranded credit under equipment that no
   * longer exists is a balance sheet nobody can explain.
   */
  it('leaves nothing of it on the balance sheet', async () => {
    const businessId = await seedBusiness();
    const recorded = await wornGenerator(businessId);
    await withBusiness(db, businessId, (tx) =>
      assetsRepo.disposeAsset(tx, {
        businessId,
        assetId: recorded.assetId,
        proceedsK: 20_000_000,
        method: 'transfer',
        actor: 'user:1',
      }),
    );

    const sums = await sumsOf(businessId);
    const sheet = buildBalanceSheet(sums);
    expect(sheet.assets.find((l) => l.account === 'EQUIPMENT')?.amountK ?? 0).toBe(0);
    expect(sheet.assets.find((l) => l.account === 'ACCUMULATED_DEPRECIATION')?.amountK ?? 0).toBe(
      0,
    );
    expect(sheet.balanced).toBe(true);

    /* The loss is in the profit and loss, once, at its true size. */
    const pnl = buildProfitAndLoss(sums);
    expect(pnl.expenses.find((l) => l.account === 'DISPOSAL_RESULT')?.amountK).toBe(16_000_000);
    /* And the depreciation charged over the year is still there, unerased. */
    expect(pnl.expenses.find((l) => l.account === 'DEPRECIATION')?.amountK).toBe(9_000_000);
  });

  it('records a gain when it fetched more than it was worth', async () => {
    const businessId = await seedBusiness();
    const recorded = await wornGenerator(businessId);
    expect(
      await withBusiness(db, businessId, (tx) =>
        assetsRepo.disposeAsset(tx, {
          businessId,
          assetId: recorded.assetId,
          proceedsK: 40_000_000,
          method: 'cash',
          actor: 'user:1',
        }),
      ),
    ).toMatchObject({ resultK: 4_000_000 });

    const pnl = buildProfitAndLoss(await sumsOf(businessId));
    /* A gain is a credit on an expense account, so it reads as negative. */
    expect(pnl.expenses.find((l) => l.account === 'DISPOSAL_RESULT')?.amountK).toBe(-4_000_000);
  });

  /* Scrapped: it went and nothing came back, so the whole book value is lost. */
  it('makes the whole remaining value the loss when nothing came back', async () => {
    const businessId = await seedBusiness();
    const recorded = await wornGenerator(businessId);
    expect(
      await withBusiness(db, businessId, (tx) =>
        assetsRepo.disposeAsset(tx, {
          businessId,
          assetId: recorded.assetId,
          proceedsK: 0,
          method: 'cash',
          actor: 'user:1',
        }),
      ),
    ).toMatchObject({ resultK: -36_000_000 });
  });

  /**
   * A year of true history must survive the sale. `chargedK` sums the
   * DEPRECIATION debits rather than the accumulated-depreciation balance,
   * because a disposal nets that account to zero when it takes the wear off
   * with the equipment — and reading it would make a generator that had
   * ₦90,000 charged against it report "nothing yet" the moment it was sold.
   */
  it('still says what was charged against it, after it has gone', async () => {
    const businessId = await seedBusiness();
    const recorded = await wornGenerator(businessId);

    const before = await withBusiness(db, businessId, (tx) => assetsRepo.assetsFor(tx, businessId));
    expect(before[0]).toMatchObject({ chargedK: 9_000_000, bookValueK: 36_000_000 });

    await withBusiness(db, businessId, (tx) =>
      assetsRepo.disposeAsset(tx, {
        businessId,
        assetId: recorded.assetId,
        proceedsK: 20_000_000,
        method: 'transfer',
        actor: 'user:1',
      }),
    );

    const after = await withBusiness(db, businessId, (tx) => assetsRepo.assetsFor(tx, businessId));
    /* Worth nothing now, and still honest about the year it was used. */
    expect(after[0]).toMatchObject({ chargedK: 9_000_000, bookValueK: 0, status: 'sold' });
  });

  it('reads back as sold, worth nothing, with what it fetched', async () => {
    const businessId = await seedBusiness();
    const recorded = await buy(businessId);
    await withBusiness(db, businessId, (tx) =>
      assetsRepo.disposeAsset(tx, {
        businessId,
        assetId: recorded.assetId,
        proceedsK: 20_000_000,
        method: 'transfer',
        actor: 'user:1',
      }),
    );

    const [asset] = await withBusiness(db, businessId, (tx) =>
      assetsRepo.assetsFor(tx, businessId),
    );
    expect(asset).toMatchObject({
      status: 'sold',
      bookValueK: 0,
      proceedsK: 20_000_000,
    });
    expect(asset?.soldOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses one already gone, and one that was never here', async () => {
    const businessId = await seedBusiness();
    const recorded = await buy(businessId);
    const sell = (assetId: string) =>
      withBusiness(db, businessId, (tx) =>
        assetsRepo.disposeAsset(tx, {
          businessId,
          assetId,
          proceedsK: 1_000_000,
          method: 'cash',
          actor: 'user:1',
        }),
      );

    expect(await sell(recorded.assetId)).toMatchObject({ outcome: 'sold' });
    expect(await sell(recorded.assetId)).toEqual({ outcome: 'not_owned' });
    expect(await sell('00000000-0000-4000-8000-000000000000')).toEqual({ outcome: 'not_found' });
  });

  /* Something sold is not being used, so it stops wearing out. */
  it('stops the wear once it has gone', async () => {
    const businessId = await seedBusiness();
    const recorded = await buy(businessId);
    await withBusiness(db, businessId, (tx) =>
      assetsRepo.disposeAsset(tx, {
        businessId,
        assetId: recorded.assetId,
        proceedsK: 45_000_000,
        method: 'cash',
        actor: 'user:1',
      }),
    );

    expect(
      await withBusiness(db, businessId, (tx) =>
        assetsRepo.chargeOneMonth(tx, {
          businessId,
          assetId: recorded.assetId,
          expectMonthsCharged: 0,
          at: new Date(),
        }),
      ),
    ).toMatchObject({ charged: false });
  });
});
