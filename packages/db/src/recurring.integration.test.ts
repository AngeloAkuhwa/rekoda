/**
 * Schedules for costs that repeat (recurring.ts), against real PostgreSQL.
 *
 * The claims that matter: a claim can be taken exactly once for a given due
 * date no matter how many callers try; a stopped schedule is never due; the
 * worker credential can ask the cross-tenant question and cannot answer it;
 * and one tenant's schedules are invisible to another.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, recurringRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;
let workerDb: Db;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 8 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeDb?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348120000041'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

function schedule(businessId: string, firstDueOn: string, anchorDay: number) {
  return withBusiness(db, businessId, (tx) =>
    recurringRepo.createSchedule(tx, {
      businessId,
      description: 'Shop rent',
      category: 'Rent',
      amountK: 15_000_000,
      method: 'transfer',
      anchorDay,
      firstDueOn,
    }),
  );
}

describe('a schedule', () => {
  it('is listed with the day the merchant chose and nothing raised yet', async () => {
    const businessId = await seedBusiness();
    await schedule(businessId, '2026-09-01', 1);

    const {
      rows: [row],
    } = await withBusiness(db, businessId, (tx) => recurringRepo.schedulesFor(tx, businessId));
    expect(row).toMatchObject({
      description: 'Shop rent',
      /* 'Rent' as the merchant capitalised it, folded to the key the
       * statements group by, so the schedule names its entries' category
       * rather than a near-miss of it. */
      category: 'rent',
      amountK: 15_000_000,
      method: 'transfer',
      anchorDay: 1,
      nextDueOn: '2026-09-01',
      lastRaisedOn: null,
      active: true,
    });
  });

  it('cuts the list at the limit and still counts everything', async () => {
    const businessId = await seedBusiness();
    await schedule(businessId, '2026-09-01', 1);
    await schedule(businessId, '2026-09-02', 2);
    await schedule(businessId, '2026-09-03', 3);

    const cut = await withBusiness(db, businessId, (tx) =>
      recurringRepo.schedulesFor(tx, businessId, 2),
    );
    expect(cut.rows).toHaveLength(2);
    expect(cut.total).toBe(3);
  });

  it('refuses an amount of nothing and a day that is not a day', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        recurringRepo.createSchedule(tx, {
          businessId,
          description: 'Free rent',
          category: null,
          amountK: 0,
          method: 'cash',
          anchorDay: 1,
          firstDueOn: '2026-09-01',
        }),
      ),
    ).rejects.toThrow();

    await expect(
      withBusiness(db, businessId, (tx) =>
        recurringRepo.createSchedule(tx, {
          businessId,
          description: 'Rent',
          category: null,
          amountK: 100,
          method: 'cash',
          anchorDay: 32,
          firstDueOn: '2026-09-01',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('what is due', () => {
  it('answers on and after the due day, and not before it', async () => {
    const businessId = await seedBusiness();
    await schedule(businessId, '2026-09-01', 1);

    expect(await recurringRepo.dueSchedules(workerDb, '2026-08-31')).toHaveLength(0);
    expect(await recurringRepo.dueSchedules(workerDb, '2026-09-01')).toHaveLength(1);
    /* A sweep that did not run for a week must still find it. */
    expect(await recurringRepo.dueSchedules(workerDb, '2026-09-08')).toHaveLength(1);
  });

  it('never answers for a stopped schedule', async () => {
    const businessId = await seedBusiness();
    const id = await schedule(businessId, '2026-09-01', 1);

    expect(
      await withBusiness(db, businessId, (tx) => recurringRepo.stopSchedule(tx, businessId, id)),
    ).toBe('stopped');
    expect(await recurringRepo.dueSchedules(workerDb, '2026-09-01')).toHaveLength(0);
  });

  it('stops once, and says so the second time', async () => {
    const businessId = await seedBusiness();
    const id = await schedule(businessId, '2026-09-01', 1);
    const stop = () =>
      withBusiness(db, businessId, (tx) => recurringRepo.stopSchedule(tx, businessId, id));

    expect(await stop()).toBe('stopped');
    expect(await stop()).toBe('already_stopped');
  });

  it('keeps a stopped schedule listed, so its entries stay explained', async () => {
    const businessId = await seedBusiness();
    const id = await schedule(businessId, '2026-09-01', 1);
    await withBusiness(db, businessId, (tx) => recurringRepo.stopSchedule(tx, businessId, id));

    const { rows } = await withBusiness(db, businessId, (tx) =>
      recurringRepo.schedulesFor(tx, businessId),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(false);
  });

  it('reports not_found for a schedule that belongs to somebody else', async () => {
    const mine = await seedBusiness('+2348120000041');
    const theirs = await seedBusiness('+2348120000042');
    const id = await schedule(theirs, '2026-09-01', 1);

    expect(await withBusiness(db, mine, (tx) => recurringRepo.stopSchedule(tx, mine, id))).toBe(
      'not_found',
    );
  });
});

describe('the claim', () => {
  it('is taken exactly once, however many callers race for it', async () => {
    const businessId = await seedBusiness();
    const id = await schedule(businessId, '2026-09-01', 1);

    const claim = () =>
      withBusiness(db, businessId, (tx) =>
        recurringRepo.claimDue(tx, businessId, id, '2026-09-01', '2026-10-01'),
      );
    const results = await Promise.all([claim(), claim(), claim(), claim()]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const {
      rows: [row],
    } = await withBusiness(db, businessId, (tx) => recurringRepo.schedulesFor(tx, businessId));
    expect(row!.nextDueOn).toBe('2026-10-01');
    expect(row!.lastRaisedOn).toBe('2026-09-01');
  });

  it('refuses once the schedule has moved past the day being claimed', async () => {
    const businessId = await seedBusiness();
    const id = await schedule(businessId, '2026-09-01', 1);

    await withBusiness(db, businessId, (tx) =>
      recurringRepo.claimDue(tx, businessId, id, '2026-09-01', '2026-10-01'),
    );
    expect(
      await withBusiness(db, businessId, (tx) =>
        recurringRepo.claimDue(tx, businessId, id, '2026-09-01', '2026-10-01'),
      ),
    ).toBe(false);
  });

  it('refuses a stopped schedule', async () => {
    const businessId = await seedBusiness();
    const id = await schedule(businessId, '2026-09-01', 1);
    await withBusiness(db, businessId, (tx) => recurringRepo.stopSchedule(tx, businessId, id));

    expect(
      await withBusiness(db, businessId, (tx) =>
        recurringRepo.claimDue(tx, businessId, id, '2026-09-01', '2026-10-01'),
      ),
    ).toBe(false);
  });
});

describe('tenant isolation', () => {
  it('hides one merchant’s schedules from another', async () => {
    const mine = await seedBusiness('+2348120000041');
    const theirs = await seedBusiness('+2348120000042');
    await schedule(theirs, '2026-09-01', 1);

    expect(await withBusiness(db, mine, (tx) => recurringRepo.schedulesFor(tx, mine))).toEqual({
      rows: [],
      total: 0,
    });
  });

  /**
   * The reach the worker credential buys is the QUESTION and never the
   * answer. If this ever passes, a background process can write into a
   * merchant's books without pinning the tenant it is writing for.
   */
  it('lets the worker ask what is due and not write the result', async () => {
    const businessId = await seedBusiness();
    const id = await schedule(businessId, '2026-09-01', 1);

    expect(await recurringRepo.dueSchedules(workerDb, '2026-09-01')).toHaveLength(1);

    const refused = await workerDb
      .transaction((tx) => recurringRepo.claimDue(tx, businessId, id, '2026-09-01', '2026-10-01'))
      .then(
        () => null,
        (error: unknown) => error,
      );
    /* Drizzle wraps the driver's error, so the privilege check is in the
     * CAUSE. Asserting on the wrapper's text would pass for any failure at
     * all, including the day the grant is quietly widened and the write
     * fails for some unrelated reason. */
    expect(causesOf(refused)).toMatch(/permission denied/i);
  });
});

/** Every message in an error's cause chain, joined. */
function causesOf(error: unknown): string {
  const messages: string[] = [];
  for (let current = error, depth = 0; current && depth < 10; depth += 1) {
    messages.push(current instanceof Error ? current.message : String(current));
    if (!(current instanceof Error)) break;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return messages.join(' | ');
}
