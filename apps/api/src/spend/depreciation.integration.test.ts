/**
 * Charging equipment against the months it is used (ADR 0026).
 *
 * The claim that matters is not that a posting was written. It is that over
 * an asset's whole life the charges sum to EXACTLY what it cost: a generator
 * that depreciates to four kobo and stays there forever is small, permanent,
 * and precisely the kind of thing that makes an accountant stop trusting a
 * system.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, assetsRepo, identity, issueRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { sweepDepreciation } from './depreciation-sweep.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 6 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348140000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const DAY = 86_400_000;

async function buyMonthsAgo(
  businessId: string,
  monthsAgo: number,
  over: { costK?: number; usefulLifeMonths?: number } = {},
) {
  const at = new Date(Date.now() - monthsAgo * 30.5 * DAY);
  const costK = over.costK ?? 45_000_000;
  return withBusiness(appDb, businessId, (tx) =>
    assetsRepo.recordAsset(tx, {
      businessId,
      description: 'Generator, 5.5kVA',
      costK,
      /* Follows the cost. Spreading `over` after a fixed `paidK` let a test
       * change the price and try to pay the old one, which the posting
       * builder refused — correctly, and confusingly. */
      paidK: costK,
      usefulLifeMonths: over.usefulLifeMonths ?? 60,
      method: 'transfer',
      actor: 'user:1',
      boughtAt: at,
    }),
  );
}

const readBack = async (businessId: string) =>
  (await withBusiness(appDb, businessId, (tx) => assetsRepo.assetsFor(tx, businessId))).rows;

describe('charging equipment against the months it is used', () => {
  it('charges nothing on the day it was bought', async () => {
    const businessId = await seedBusiness();
    await buyMonthsAgo(businessId, 0);

    expect(await sweepDepreciation({ workerDb, appDb })).toMatchObject({ charged: 0 });
    expect((await readBack(businessId))[0]).toMatchObject({ chargedK: 0, bookValueK: 45_000_000 });
  });

  it('charges one month once a month has passed', async () => {
    const businessId = await seedBusiness();
    await buyMonthsAgo(businessId, 1);

    expect(await sweepDepreciation({ workerDb, appDb })).toMatchObject({
      charged: 1,
      chargedK: 750_000,
    });
    expect((await readBack(businessId))[0]).toMatchObject({
      monthsCharged: 1,
      chargedK: 750_000,
      bookValueK: 44_250_000,
    });
  });

  /* An outage is not a month the business did not use the generator. */
  it('catches up the months it missed, one charge each', async () => {
    const businessId = await seedBusiness();
    await buyMonthsAgo(businessId, 4);

    expect(await sweepDepreciation({ workerDb, appDb })).toMatchObject({
      charged: 4,
      chargedK: 3_000_000,
    });
    expect((await readBack(businessId))[0]).toMatchObject({ monthsCharged: 4 });
  });

  it('charges nothing twice, however often it runs', async () => {
    const businessId = await seedBusiness();
    await buyMonthsAgo(businessId, 2);

    await sweepDepreciation({ workerDb, appDb });
    const after = await readBack(businessId);
    expect(await sweepDepreciation({ workerDb, appDb })).toMatchObject({ charged: 0 });
    expect(await readBack(businessId)).toEqual(after);
  });

  /**
   * The property that keeps a balance sheet honest for good. Run the sweep
   * far enough past the end of the life and the asset must be worth exactly
   * nothing, with the charges summing to exactly what it cost.
   */
  it('depreciates to exactly nothing, never to a stray kobo', async () => {
    const businessId = await seedBusiness();
    /* A cost and a life that do not divide evenly: 999,999 over 7 months. */
    await buyMonthsAgo(businessId, 24, { costK: 999_999, usefulLifeMonths: 7 });

    /* Twice, because MAX_CATCHUP bounds one pass. */
    await sweepDepreciation({ workerDb, appDb });
    await sweepDepreciation({ workerDb, appDb });

    const [asset] = await readBack(businessId);
    expect(asset).toMatchObject({
      monthsCharged: 7,
      chargedK: 999_999,
      bookValueK: 0,
    });
  });

  it('stops at the end of the life and never runs past it', async () => {
    const businessId = await seedBusiness();
    await buyMonthsAgo(businessId, 40, { costK: 1_200_000, usefulLifeMonths: 12 });

    await sweepDepreciation({ workerDb, appDb });
    await sweepDepreciation({ workerDb, appDb });
    await sweepDepreciation({ workerDb, appDb });

    const [asset] = await readBack(businessId);
    expect(asset).toMatchObject({ monthsCharged: 12, chargedK: 1_200_000, bookValueK: 0 });
  });

  /**
   * Charging the same month twice is refused.
   *
   * What this covers is the SEQUENTIAL case, which is the one that happens:
   * a sweep that overlaps its own previous run, or a catch-up loop that
   * miscounts. `chargeOneMonth` reads the count, compares it to the one the
   * caller expected, and refuses on any mismatch.
   *
   * The conditional UPDATE beneath that check is a second defence against a
   * genuine race — two transactions both reading the count before either
   * writes — and this test does NOT prove it. Two overlapping transactions
   * could not be made to interleave reliably here, and a test that only
   * sometimes exercises the thing it names is worse than one that says
   * plainly what it covers. The condition stays because it is correct and
   * costs nothing; it is belt and braces, not proven ground.
   */
  it('refuses a second charge for a month already claimed', async () => {
    const businessId = await seedBusiness();
    const recorded = await buyMonthsAgo(businessId, 3);
    const chargeMonthZero = () =>
      withBusiness(appDb, businessId, (tx) =>
        assetsRepo.chargeOneMonth(tx, {
          businessId,
          assetId: recorded.assetId,
          expectMonthsCharged: 0,
          at: new Date(),
        }),
      );

    expect(await chargeMonthZero()).toMatchObject({ charged: true, amountK: 750_000 });
    /* The same month again, with the same expectation, is refused. */
    expect(await chargeMonthZero()).toMatchObject({ charged: false, amountK: 0 });

    const [asset] = await readBack(businessId);
    expect(asset).toMatchObject({ monthsCharged: 1, chargedK: 750_000 });
  });

  /* Something taken back out is not being used, so it is not wearing out. */
  it('leaves a withdrawn item alone', async () => {
    const businessId = await seedBusiness();
    const recorded = await buyMonthsAgo(businessId, 3);
    await withBusiness(appDb, businessId, (tx) =>
      assetsRepo.withdrawAsset(tx, {
        businessId,
        assetId: recorded.assetId,
        reason: 'recorded twice',
        actor: 'user:1',
      }),
    );

    expect(await sweepDepreciation({ workerDb, appDb })).toMatchObject({ charged: 0 });
  });

  /**
   * The charge is an expense: it is the half of ADR 0026 that puts equipment
   * back into the profit and loss, a month at a time, where recording it as
   * an expense on day one put all of it there at once.
   */
  it('reaches the profit and loss, one month at a time', async () => {
    const businessId = await seedBusiness();
    await buyMonthsAgo(businessId, 1);
    await sweepDepreciation({ workerDb, appDb });

    const entries = await withBusiness(appDb, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const depreciation = entries.filter((e) => e.account === 'DEPRECIATION');
    const accumulated = entries.filter((e) => e.account === 'ACCUMULATED_DEPRECIATION');
    expect(depreciation).toEqual([{ account: 'DEPRECIATION', debitK: 750_000, creditK: 0 }]);
    expect(accumulated).toEqual([
      { account: 'ACCUMULATED_DEPRECIATION', debitK: 0, creditK: 750_000 },
    ]);
    /* And what the business PAID is untouched: that is why the credit goes to
     * the contra-asset and not to EQUIPMENT. */
    expect(entries.filter((e) => e.account === 'EQUIPMENT')).toEqual([
      { account: 'EQUIPMENT', debitK: 45_000_000, creditK: 0 },
    ]);
  });

  it('charges each business its own, and never another`s', async () => {
    const ada = await seedBusiness('+2348140000001');
    const bola = await seedBusiness('+2348140000002');
    await buyMonthsAgo(ada, 2);

    await sweepDepreciation({ workerDb, appDb });
    expect((await readBack(ada))[0]).toMatchObject({ monthsCharged: 2 });
    expect((await withBusiness(appDb, bola, (tx) => assetsRepo.assetsFor(tx, bola))).rows).toEqual(
      [],
    );
  });
});

describe('whole months between two Lagos days', () => {
  it('counts calendar months, not thirty-day blocks', () => {
    expect(assetsRepo.monthsElapsed('2026-03-03', '2026-04-03')).toBe(1);
    expect(assetsRepo.monthsElapsed('2026-03-03', '2026-04-02')).toBe(0);
    expect(assetsRepo.monthsElapsed('2026-01-15', '2027-01-15')).toBe(12);
  });

  /* The conservative direction: never charge for time the business has not
   * had. Bought on the 31st, read on the 30th, is not a month yet. */
  it('never counts a month the business has not finished', () => {
    expect(assetsRepo.monthsElapsed('2026-01-31', '2026-02-28')).toBe(0);
    expect(assetsRepo.monthsElapsed('2026-01-31', '2026-03-31')).toBe(2);
    expect(assetsRepo.monthsElapsed('2026-05-10', '2026-05-09')).toBe(0);
  });
});
