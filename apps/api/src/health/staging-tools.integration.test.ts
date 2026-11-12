/**
 * G-119 / OWN-77 (PR B item 6): the staging tools, API half.
 *
 * Fail-closed: the flag, a TEST Paystack key, no §47 confirmation and the database's staging
 * marker must all hold, or every operation is refused and nothing is written. Boot refuses a bad
 * flag value, a live key beside the flag, and the confirmation beside the flag. With the tools on, a
 * one-shot fault armed for a test business is consumed by the next grace reminder exactly as the
 * real failure would be: a timeout is never resent, a refused sender is retried next pass.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  identity,
  sql,
  stagingToolsRepo,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
  startGraceForTest,
} from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { StagingRefused, StagingToolsService } from './staging-tools.service.js';
import { assertStagingMarkerNotLive } from './staging-boot-check.js';
import { sweepGracePeriods } from '../billing/grace-sweep.js';
import { StubSender } from '../channels/sender.stub.js';

const DAY = 86_400_000;
const TEST_KEY = ['sk', 'test', 's'.repeat(24)].join('_');
const LIVE_KEY = ['sk', 'live', 's'.repeat(24)].join('_');
const OPERATOR = 'operator:alice@rekoda.app';
const BILLING_URL = 'https://staging.example.test/app/billing';

let urls: Urls;
let db: Db;
let workerDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];
let base: ApiConfig;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (db = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db: made, close } = createDb(url, { max: 4 });
    set(made);
    closers.push(close);
  }
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  delete process.env['REKODA_STAGING_TOOLS'];
  base = loadConfig();
});

afterAll(async () => {
  for (const close of closers) await close();
  delete process.env['REKODA_STAGING_TOOLS'];
  delete process.env['PAYSTACK_SECRET_KEY'];
  delete process.env['REKODA_PAYSTACK_PLATFORM_CONFIRMED'];
});

beforeEach(async () => {
  await truncateAll(urls);
});

const enabled = (): ApiConfig => ({
  ...base,
  stagingTools: true,
  paystackSecretKey: TEST_KEY,
  paystackPlatformConfirmed: false,
});
const tools = (config: ApiConfig = enabled()) => new StagingToolsService(config, db);
const markStaging = () =>
  ownerDb.execute(sql`INSERT INTO staging_environment (marked_by) VALUES ('owner:test')`);

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    db,
    `+23481950000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Test Shop',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const actionCount = async (businessId: string) =>
  (await withBusiness(db, businessId, (tx) => stagingToolsRepo.actionsFor(tx, businessId))).length;

const refusal = (run: Promise<unknown>) =>
  run.then(
    () => 'allowed',
    (error: unknown) => (error instanceof StagingRefused ? error.reason : String(error)),
  );

describe('OWN-77: boot refuses an unsafe configuration', () => {
  const boot = (env: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return loadConfig().stagingTools;
    } finally {
      for (const key of Object.keys(env)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };

  it('accepts 0, unset, or 1 with a test key; refuses anything else', () => {
    expect(boot({ REKODA_STAGING_TOOLS: undefined })).toBe(false);
    expect(boot({ REKODA_STAGING_TOOLS: '0' })).toBe(false);
    expect(boot({ REKODA_STAGING_TOOLS: '1', PAYSTACK_SECRET_KEY: TEST_KEY })).toBe(true);
    expect(() => boot({ REKODA_STAGING_TOOLS: 'yes' })).toThrow(/must be 0 or 1/);
    expect(() => boot({ REKODA_STAGING_TOOLS: 'true' })).toThrow(/must be 0 or 1/);
  });

  it('refuses the flag with a live key, no key, or the §47 confirmation', () => {
    expect(() => boot({ REKODA_STAGING_TOOLS: '1', PAYSTACK_SECRET_KEY: LIVE_KEY })).toThrow(
      /TEST key/,
    );
    expect(() => boot({ REKODA_STAGING_TOOLS: '1', PAYSTACK_SECRET_KEY: '' })).toThrow(/TEST key/);
    expect(() =>
      boot({
        REKODA_STAGING_TOOLS: '1',
        PAYSTACK_SECRET_KEY: TEST_KEY,
        REKODA_PAYSTACK_PLATFORM_CONFIRMED: '1',
      }),
    ).toThrow(/PLATFORM_CONFIRMED/);
  });
});

describe('OWN-77: boot refuses a staging-marked database beside a live key (main.ts)', () => {
  it('refuses a live key on a marked database, and allows a test key or an unmarked one', async () => {
    await expect(assertStagingMarkerNotLive(db, LIVE_KEY)).resolves.toBeUndefined();
    await markStaging();
    await expect(assertStagingMarkerNotLive(db, LIVE_KEY)).rejects.toThrow(/marked as staging/);
    await expect(assertStagingMarkerNotLive(db, TEST_KEY)).resolves.toBeUndefined();
    await expect(assertStagingMarkerNotLive(db, '')).resolves.toBeUndefined();
  });
});

describe('OWN-77: every condition must hold, or nothing is written', () => {
  it('refuses with the flag off, a live key, the confirmation set, or no staging marker', async () => {
    await markStaging();
    const businessId = await seedBusiness();
    for (const config of [
      { ...enabled(), stagingTools: false },
      { ...enabled(), paystackSecretKey: LIVE_KEY },
      { ...enabled(), paystackPlatformConfirmed: true },
    ]) {
      expect(await refusal(tools(config).designate(businessId, OPERATOR, 'walkthrough'))).toBe(
        'disabled',
      );
    }
    await ownerDb.execute(sql`DELETE FROM staging_environment`);
    expect(await refusal(tools().designate(businessId, OPERATOR, 'walkthrough'))).toBe(
      'not_staging',
    );
    expect(await actionCount(businessId)).toBe(0);
  });

  it('refuses a business that is not designated, writing nothing', async () => {
    await markStaging();
    const businessId = await seedBusiness();
    expect(
      await refusal(
        tools().moveDate(
          businessId,
          { field: 'trial_end', expected: null, to: new Date(), reason: 'step 22' },
          OPERATOR,
        ),
      ),
    ).toBe('not_test_business');
    expect(await refusal(tools().armFault(businessId, 'send_timeout', OPERATOR, 'step 19'))).toBe(
      'not_test_business',
    );
    expect(await actionCount(businessId)).toBe(0);
  });
});

describe('OWN-77: with the tools on', () => {
  beforeEach(markStaging);

  it('designates, moves a trial end, refuses a stale read, and reverts once', async () => {
    const businessId = await seedBusiness();
    await tools().designate(businessId, OPERATOR, 'walkthrough 22');
    const trialEnd = (await withBusiness(db, businessId, (tx) =>
      stagingToolsRepo.currentDate(tx, businessId, 'trial_end'),
    ))!.value!;
    const to = new Date(Date.now() - DAY);

    const moved = await tools().moveDate(
      businessId,
      { field: 'trial_end', expected: trialEnd, to, reason: 'step 22' },
      OPERATOR,
    );
    expect(
      await refusal(
        tools().moveDate(
          businessId,
          { field: 'trial_end', expected: trialEnd, to: new Date(), reason: 'stale read' },
          OPERATOR,
        ),
      ),
    ).toBe('changed');

    await tools().revert(businessId, moved.actionId, OPERATOR, 'cleanup');
    expect(await refusal(tools().revert(businessId, moved.actionId, OPERATOR, 'again'))).toMatch(
      /already_reverted|invalid|changed/,
    );
    const after = await withBusiness(db, businessId, (tx) =>
      stagingToolsRepo.currentDate(tx, businessId, 'trial_end'),
    );
    expect(after?.value?.toISOString()).toBe(trialEnd.toISOString());
  });

  it('refuses, writing nothing, when the marker goes after the entry check (armFault)', async () => {
    const businessId = await seedBusiness();
    await tools().designate(businessId, OPERATOR, 'walkthrough 19');
    await ownerDb.execute(sql`DELETE FROM staging_environment`);
    /* The entry check reads a marker that is gone by the time the transaction runs. */
    let first = true;
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'execute' && first) {
          first = false;
          return async () => [{ marked: true }];
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const service = new StagingToolsService(enabled(), racing);
    expect(await refusal(service.armFault(businessId, 'send_timeout', OPERATOR, 'step 19'))).toBe(
      'not_staging',
    );
    const faults = await ownerDb.execute(sql`SELECT count(*)::int AS n FROM staging_send_faults`);
    expect([...faults][0]).toEqual({ n: 0 });
  });

  async function graceMerchant(): Promise<{ businessId: string; failedAt: Date }> {
    const businessId = await seedBusiness();
    const failedAt = new Date(Date.now() - 3_600_000);
    await withBusiness(db, businessId, async (tx) => {
      await applyFixtureCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: new Date(failedAt.getTime() - 30 * DAY),
        renewsAt: failedAt,
        anchorDay: failedAt.getUTCDate(),
      });
      await startGraceForTest(tx, businessId, failedAt);
    });
    await tools().designate(businessId, OPERATOR, 'walkthrough 19');
    return { businessId, failedAt };
  }

  it('walkthrough 19, timeout: the day-1 reminder is not sent, and never resent', async () => {
    const { businessId, failedAt } = await graceMerchant();
    await tools().armFault(businessId, 'send_timeout', OPERATOR, 'step 19');
    const sender = new StubSender();
    const deps = {
      workerDb,
      appDb: db,
      sender,
      fxNairaPerUsd: 1_450,
      billingUrl: BILLING_URL,
      stagingFaults: true,
    };
    const day1 = new Date(failedAt.getTime() + DAY);

    await sweepGracePeriods(deps, day1);
    await sweepGracePeriods(deps, day1);
    expect(sender.billingNotices).toHaveLength(0);
    const log = await withBusiness(db, businessId, (tx) =>
      stagingToolsRepo.actionsFor(tx, businessId),
    );
    expect(log.filter((a) => a.action === 'consume_fault')).toHaveLength(1);
  });

  it('walkthrough 19, refused sender: nothing sent this pass, sent once on the next', async () => {
    const { businessId, failedAt } = await graceMerchant();
    await tools().armFault(businessId, 'sender_refused', OPERATOR, 'step 19');
    const sender = new StubSender();
    const deps = {
      workerDb,
      appDb: db,
      sender,
      fxNairaPerUsd: 1_450,
      billingUrl: BILLING_URL,
      stagingFaults: true,
    };
    const day1 = new Date(failedAt.getTime() + DAY);

    await sweepGracePeriods(deps, day1);
    expect(sender.billingNotices).toHaveLength(0);
    await sweepGracePeriods(deps, day1);
    expect(sender.billingNotices).toHaveLength(1);
  });

  it('with the deployment flag off, an armed fault is never consulted', async () => {
    const { businessId, failedAt } = await graceMerchant();
    await tools().armFault(businessId, 'send_timeout', OPERATOR, 'step 19');
    const sender = new StubSender();
    await sweepGracePeriods(
      { workerDb, appDb: db, sender, fxNairaPerUsd: 1_450, billingUrl: BILLING_URL },
      new Date(failedAt.getTime() + DAY),
    );
    expect(sender.billingNotices).toHaveLength(1);
  });
});
