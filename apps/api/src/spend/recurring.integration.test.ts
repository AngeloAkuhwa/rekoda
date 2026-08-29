/**
 * Costs that repeat, end to end: session guard → contract shape → the sweep
 * that raises them → the register they land in.
 *
 * The date arithmetic is proven in packages/core/src/recurring.test.ts and
 * the claim in packages/db/src/recurring.integration.test.ts. What this suite
 * pins is everything between them, and three claims in particular:
 *
 *   - a schedule anchored on the 31st produces exactly one entry in February,
 *     on the 28th, and returns to the 31st afterwards;
 *   - a sweep run twice on the same day raises one entry, not two;
 *   - a stopped schedule raises nothing, and what it already raised stays;
 *   - a raise carries its §9.4 posting key, and one due in a CLOSED month
 *     lands on the first open day instead of wedging (PR-082).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportsExpensesResponse } from '@rekoda/contracts';
import { lagosDay, nextDueAfter } from '@rekoda/core';
import { closeRepo, createDb, spendRepo, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sweepRecurring } from './recurring-sweep.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';

const testBus = new CommandBus(new RiskPolicyService());

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_REVEAL_OTP'] = '1';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode?: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = await post(
    '/v1/businesses',
    { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  const session = created.json() as { sessionToken: string; businessId: string };
  return {
    businessId: session.businessId,
    auth: { authorization: `Bearer ${session.sessionToken}` },
  };
}

const registerOf = async (auth: Record<string, string>) =>
  reportsExpensesResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
  );

const sweep = (now: Date) =>
  sweepRecurring({ workerDb, appDb: db, commandBus: testBus, commandRecordExpense: false }, now);

/** Noon Lagos on a given day, so no test result turns on the hour. */
const at = (day: string) => new Date(`${day}T11:00:00Z`);

describe('the guardrail', () => {
  it('refuses a caller with no session', async () => {
    expect((await post('/v1/reports/expenses/recurring', { description: 'Rent' })).statusCode).toBe(
      401,
    );
    expect((await post('/v1/reports/expenses/recurring/stop', { id: 'x' })).statusCode).toBe(401);
  });

  it('refuses a shape that is not a schedule', async () => {
    const { auth } = await onboard('+2348177200001');
    const bad = (payload: unknown) => post('/v1/reports/expenses/recurring', payload, auth);

    expect(
      (await bad({ description: 'R', amountK: 1, method: 'cash', anchorDay: 1 })).statusCode,
    ).toBe(400);
    expect(
      (await bad({ description: 'Rent', amountK: 0, method: 'cash', anchorDay: 1, category: null }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await bad({
          description: 'Rent',
          amountK: 100,
          method: 'cash',
          anchorDay: 32,
          category: null,
        })
      ).statusCode,
    ).toBe(400);
  });

  /* `stock` is the marker the register splits on. A schedule wearing it would
   * add to the stock total every month with no delivery behind it. */
  it('refuses a schedule that calls itself stock', async () => {
    const { auth } = await onboard('+2348177200002');
    const created = await post(
      '/v1/reports/expenses/recurring',
      {
        description: 'Weekly bales',
        category: 'Stock',
        amountK: 500_000,
        method: 'cash',
        anchorDay: 1,
      },
      auth,
    );
    expect(created.json()).toEqual({ outcome: 'not_stock' });
    expect((await registerOf(auth)).recurring).toHaveLength(0);
  });
});

describe('setting one up', () => {
  it('never raises the first entry today', async () => {
    const { auth } = await onboard('+2348177200003');
    const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);

    const created = (
      await post(
        '/v1/reports/expenses/recurring',
        {
          description: 'Shop rent',
          category: 'Rent',
          amountK: 15_000_000,
          method: 'transfer',
          anchorDay: Number(today.slice(8, 10)),
        },
        auth,
      )
    ).json() as { outcome: string; firstDueOn: string };

    expect(created.outcome).toBe('created');
    expect(created.firstDueOn > today).toBe(true);
  });

  it('shows on the register with the day the merchant chose', async () => {
    const { auth } = await onboard('+2348177200004');
    await post(
      '/v1/reports/expenses/recurring',
      {
        description: 'Shop rent',
        category: 'Rent',
        amountK: 15_000_000,
        method: 'transfer',
        anchorDay: 1,
      },
      auth,
    );

    const [schedule] = (await registerOf(auth)).recurring;
    expect(schedule).toMatchObject({
      description: 'Shop rent',
      /* Folded on the way in, so the schedule advertises the category its
       * entries will actually carry onto the profit and loss. */
      category: 'rent',
      amountK: 15_000_000,
      method: 'transfer',
      anchorDay: 1,
      lastRaisedOn: null,
      active: true,
    });
  });
});

describe('the sweep', () => {
  /** A schedule due tomorrow, reached by sweeping from that day onward. */
  async function scheduleFor(phone: string, anchorDay: number) {
    const { auth, businessId } = await onboard(phone);
    const created = (
      await post(
        '/v1/reports/expenses/recurring',
        {
          description: 'Shop rent',
          category: 'Rent',
          amountK: 15_000_000,
          method: 'transfer',
          anchorDay,
        },
        auth,
      )
    ).json() as { id: string; firstDueOn: string };
    return { auth, businessId, ...created };
  }

  it('raises nothing before the day, and one entry on it', async () => {
    const { auth, firstDueOn } = await scheduleFor('+2348177200005', 1);

    const dayBefore = new Date(`${firstDueOn}T11:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    expect(await sweep(dayBefore)).toEqual({ raised: 0, skipped: 0 });
    expect((await registerOf(auth)).entries).toHaveLength(0);

    expect(await sweep(at(firstDueOn))).toEqual({ raised: 1, skipped: 0 });
    const register = await registerOf(auth);
    expect(register.entries).toHaveLength(1);
    expect(register.entries[0]).toMatchObject({
      description: 'Shop rent',
      category: 'rent',
      amountK: 15_000_000,
      method: 'transfer',
      kind: 'expense',
      status: 'recorded',
      sourceType: 'recurring',
    });
    /* The entry is a real cost, so the register's own total moved. */
    expect(register.expensesK).toBe(15_000_000);
  });

  it('run twice on the same day raises one entry, not two', async () => {
    const { auth, firstDueOn } = await scheduleFor('+2348177200006', 1);

    expect(await sweep(at(firstDueOn))).toEqual({ raised: 1, skipped: 0 });
    expect(await sweep(at(firstDueOn))).toEqual({ raised: 0, skipped: 0 });
    expect((await registerOf(auth)).entries).toHaveLength(1);
  });

  it('run by two processes at once raises one entry, not two', async () => {
    const { auth, firstDueOn } = await scheduleFor('+2348177200007', 1);

    const [first, second] = await Promise.all([sweep(at(firstDueOn)), sweep(at(firstDueOn))]);
    expect(first.raised + second.raised).toBe(1);
    expect((await registerOf(auth)).entries).toHaveLength(1);
  });

  /**
   * The whole reason the anchor is stored rather than re-read off the last
   * due date. A schedule on the 31st has no February, and a month that
   * silently skips it is a rent entry an accountant cannot find.
   */
  it('gives a 31st schedule exactly one February entry, on the 28th', async () => {
    const { auth, firstDueOn } = await scheduleFor('+2348177200008', 31);
    expect(firstDueOn.slice(8)).toBe('31');

    /* Everything up to and including January, so the count below is February
     * alone rather than however many months lie between now and then. */
    await sweep(at('2027-01-31'));
    const beforeFebruary = (await registerOf(auth)).entries.length;

    /* Sweep every day of February. The schedule is anchored on the 31st, so
     * exactly one of those days may raise anything, and it is the last. */
    for (let day = 1; day <= 27; day += 1) {
      await sweep(at(`2027-02-${String(day).padStart(2, '0')}`));
    }
    expect((await registerOf(auth)).entries).toHaveLength(beforeFebruary);

    expect(await sweep(at('2027-02-28'))).toEqual({ raised: 1, skipped: 0 });
    expect((await registerOf(auth)).entries).toHaveLength(beforeFebruary + 1);

    const [schedule] = (await registerOf(auth)).recurring;
    expect(schedule!.lastRaisedOn).toBe('2027-02-28');
    /* And back out to the 31st, not stuck on the clamped day. */
    expect(schedule!.nextDueOn).toBe('2027-03-31');
  });

  it('raises nothing for a stopped schedule, and keeps what it already raised', async () => {
    const { auth, id, firstDueOn } = await scheduleFor('+2348177200009', 1);
    await sweep(at(firstDueOn));

    expect((await post('/v1/reports/expenses/recurring/stop', { id }, auth)).json()).toEqual({
      outcome: 'stopped',
    });

    const nextMonth = new Date(`${firstDueOn}T11:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 2);
    expect(await sweep(nextMonth)).toEqual({ raised: 0, skipped: 0 });

    const register = await registerOf(auth);
    expect(register.entries).toHaveLength(1);
    expect(register.recurring[0]!.active).toBe(false);
  });

  /**
   * An outage is not a discount. Each raise advances the schedule one month
   * from the date it was DUE, so the months nobody swept produce the entries
   * they owed rather than collapsing into one.
   */
  it('catches up the months it missed', async () => {
    const { auth, firstDueOn } = await scheduleFor('+2348177200010', 1);

    const threeMonthsOn = new Date(`${firstDueOn}T11:00:00Z`);
    threeMonthsOn.setUTCMonth(threeMonthsOn.getUTCMonth() + 2);
    expect(await sweep(threeMonthsOn)).toEqual({ raised: 3, skipped: 0 });

    const register = await registerOf(auth);
    expect(register.entries).toHaveLength(3);
    expect(register.expensesK).toBe(45_000_000);
  });

  /**
   * The defect a screenshot found and a green suite did not: entries stamped
   * with the day the sweep ran rather than the day they fell due. Three
   * months of rent on one date is a quarter's cost inside one month's profit
   * and loss, and two months that look like the shop paid no rent at all.
   */
  it('dates a caught-up entry the day it fell due, not the day it was raised', async () => {
    const { auth, firstDueOn } = await scheduleFor('+2348177200015', 1);

    const threeMonthsOn = new Date(`${firstDueOn}T11:00:00Z`);
    threeMonthsOn.setUTCMonth(threeMonthsOn.getUTCMonth() + 2);
    await sweep(threeMonthsOn);

    const days = (await registerOf(auth)).entries
      .map((entry) => lagosDay(new Date(entry.recordedAt)))
      .sort();
    const second = nextDueAfter(firstDueOn, 1);
    expect(days).toEqual([firstDueOn, second, nextDueAfter(second, 1)]);
  });

  /**
   * §9.4 at the ledger itself (PR-082). The claim and the command key both
   * protect the normal path; this is the defence in depth the spec asks
   * for — a writer that bypasses the bus entirely still cannot raise one
   * month's rent twice, because the posting carries the raise's identity
   * and `ledger_tx_posting_key_ux` refuses a second one.
   */
  it('stamps the raise on the posting, and the ledger refuses it twice', async () => {
    const { businessId, id, firstDueOn } = await scheduleFor('+2348177200016', 1);
    await sweep(at(firstDueOn));

    const keys = await withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ posting_key: string | null }>(sql`
        SELECT posting_key FROM ledger_transactions
        WHERE business_id = ${businessId}::uuid AND source_type = 'recurring'
      `);
      return [...rows].map((r) => r.posting_key);
    });
    expect(keys).toEqual([`recurring:${id}:${firstDueOn}`]);

    /* The bypass: the same raise straight into the repo, no bus, no claim. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        spendRepo.recordExpense(tx, {
          businessId,
          description: 'Shop rent',
          category: 'Rent',
          amountK: 15_000_000,
          method: 'transfer',
          sourceType: 'recurring',
          sourceId: `${id}:${firstDueOn}`,
          postingKey: `recurring:${id}:${firstDueOn}`,
        }),
      ),
    ).rejects.toThrow(/ledger_transactions/);
  });

  /**
   * The wedge (PR-082). Rent fell due in a month whose books have since
   * closed; dating it there is a posting the kernel refuses forever, and
   * before this the sweep retried it daily until the end of time. It lands
   * on day one of the earliest open month instead, saying which day it was
   * really for, and the open months still get their own entries on their
   * own days.
   */
  it('raises a closed month’s entry on the first open day, named for its due day', async () => {
    const { auth, businessId, firstDueOn } = await scheduleFor('+2348177200017', 1);
    const secondDueOn = nextDueAfter(firstDueOn, 1);
    const thirdDueOn = nextDueAfter(secondDueOn, 1);

    /* Close the first due month, judged from a clock two months on. */
    const closed = await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, {
        businessId,
        through: firstDueOn.slice(0, 7),
        actor: 'user:test',
        now: at(thirdDueOn),
      }),
    );
    expect(closed.outcome).toBe('closed');

    expect(await sweep(at(thirdDueOn))).toEqual({ raised: 3, skipped: 0 });

    const entries = (await registerOf(auth)).entries
      .map((entry) => ({
        description: entry.description,
        day: lagosDay(new Date(entry.recordedAt)),
      }))
      .sort((a, b) =>
        a.day === b.day ? a.description.localeCompare(b.description) : a.day < b.day ? -1 : 1,
      );
    expect(entries).toEqual([
      { description: 'Shop rent', day: secondDueOn },
      /* The displaced raise: dated the first open day, named for its own. */
      { description: `Shop rent (due ${firstDueOn})`, day: secondDueOn },
      { description: 'Shop rent', day: thirdDueOn },
    ]);
  });

  it('leaves one merchant’s schedule out of another’s books', async () => {
    const { firstDueOn } = await scheduleFor('+2348177200011', 1);
    const { auth: other } = await onboard('+2348177200012');

    await sweep(at(firstDueOn));
    expect((await registerOf(other)).entries).toHaveLength(0);
  });
});

describe('stopping one', () => {
  it('says so the second time, and refuses somebody else’s', async () => {
    const { auth } = await onboard('+2348177200013');
    const { auth: other } = await onboard('+2348177200014');
    const created = (
      await post(
        '/v1/reports/expenses/recurring',
        {
          description: 'Shop rent',
          category: 'Rent',
          amountK: 15_000_000,
          method: 'transfer',
          anchorDay: 1,
        },
        auth,
      )
    ).json() as { id: string };

    const stop = (headers: Record<string, string>) =>
      post('/v1/reports/expenses/recurring/stop', { id: created.id }, headers);

    expect((await stop(other)).json()).toEqual({ outcome: 'not_found' });
    expect((await stop(auth)).json()).toEqual({ outcome: 'stopped' });
    expect((await stop(auth)).json()).toEqual({ outcome: 'already_stopped' });
  });
});
