/**
 * F-2 (owner instruction, 18 Nov 2026): after a zero-priced upgrade the API answered `processing`,
 * the billing overview says what became of it, so the page never keeps saying "switching your plan
 * on now" once the switch happened, was withdrawn or stopped for good.
 *
 * The upgrade is real: `BillingService.changePlan` queues `billing.apply_no_charge` and waits a short
 * while; here the wait is cut to nothing so the answer is `processing`, as it is when settlement is
 * slower than the wait. The job is then run by the settlement handler on the settlement credential,
 * exactly as the settlement runner would (attempt numbers chosen by the test).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  setPlanForTest,
  setPricingSource,
  settlementDb,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
import { BillingService } from './billing.service.js';
import { applyNoChargeUpgradeHandler } from '../jobs/apply-no-charge-upgrade.handler.js';

let urls: Urls;
let appDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 4 });
    set(db);
    closers.push(close);
  }
});
afterAll(async () => {
  for (const close of closers) await close();
});
beforeEach(async () => {
  await truncateAll(urls);
  await setPricingSource(urls, 'constants');
});

const config = {
  planCatalogueReads: false,
  paystackSecretKey: 'sk_test_x',
  paystackPlatformConfirmed: true,
};
const DAY = 86_400_000;

let seq = 0;
/** A Chat business whose standard monthly cycle ends in ten hours: an upgrade costs nothing. */
async function chatEndingSoon(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481720${String(seq).padStart(4, '0')}`);
  const { id: businessId } = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const renewsAt = new Date(Date.now() + 10 * 3_600_000);
  await setPlanForTest(appDb, {
    businessId,
    plan: 'chat',
    expiresAt: renewsAt,
    actor: 'operator:test-f2',
  });
  await withBusiness(appDb, businessId, (tx) =>
    applyFixtureCycle(tx, businessId, {
      plan: 'chat',
      cycleStartedAt: new Date(renewsAt.getTime() - 30 * DAY),
      renewsAt,
      anchorDay: renewsAt.getUTCDate(),
    }),
  );
  return businessId;
}

/** Ask for the upgrade with no wait: answered `processing`, the job left pending. */
async function upgradeAnsweredProcessing(businessId: string) {
  const service = new BillingService(config as never, appDb);
  service.zeroChargeWaitMs = 0;
  expect(await service.changePlan(businessId, 'complete')).toEqual({
    state: 'processing',
    plan: 'complete',
  });
  const [job] = await ownerDb.execute<{ id: string; reference: string }>(sql`
    SELECT id, payload->>'reference' AS reference FROM jobs
    WHERE business_id = ${businessId}::uuid AND kind = 'billing.apply_no_charge'`);
  return { service, job: job! };
}

/** Run the job as settlement does, on attempt `attempt` of five. */
const runJob = (businessId: string, job: { id: string; reference: string }, attempt = 1) =>
  withBusiness(settlementDb(), businessId, (tx) =>
    applyNoChargeUpgradeHandler({ config: config as never })({
      tx,
      jobId: job.id,
      businessId,
      payload: { reference: job.reference },
      attempt,
      maxAttempts: 5,
    }),
  );
const setJob = (jobId: string, state: string) =>
  ownerDb.execute(sql`UPDATE jobs SET state = ${state} WHERE id = ${jobId}::uuid`);

describe('F-2: the overview says what became of a zero-priced upgrade', () => {
  it('reads processing while settlement has yet to run it, then applied once it has (delayed completion)', async () => {
    const businessId = await chatEndingSoon();
    const { service, job } = await upgradeAnsweredProcessing(businessId);
    // A refresh before settlement has run.
    expect((await service.overview(businessId)).noChargeUpgrade).toEqual({
      plan: 'complete',
      state: 'processing',
    });
    expect((await service.overview(businessId)).plan).toBe('chat');
    await setJob(job.id, 'running');
    expect((await service.overview(businessId)).noChargeUpgrade?.state).toBe('processing');
    // Settlement runs it after the synchronous wait has ended.
    await runJob(businessId, job);
    await setJob(job.id, 'done');
    const after = await service.overview(businessId);
    expect(after.noChargeUpgrade).toEqual({ plan: 'complete', state: 'applied' });
    expect(after.plan).toBe('complete');
  });

  it('reads withdrawn when settlement could no longer apply it, and the plan is unchanged', async () => {
    const businessId = await chatEndingSoon();
    const { service, job } = await upgradeAnsweredProcessing(businessId);
    /* A backlog: the job runs after the paid-through date (G3-1). */
    await ownerDb.execute(sql`
      UPDATE businesses SET plan_expires_at = now() - interval '1 minute' WHERE id = ${businessId}::uuid`);
    await runJob(businessId, job);
    await setJob(job.id, 'done');
    const view = await service.overview(businessId);
    expect(view.noChargeUpgrade).toEqual({ plan: 'complete', state: 'withdrawn' });
    // No payment is claimed: the zero-priced charge was never paid.
    expect(view.charges.some((c) => c.status === 'paid')).toBe(false);
  });

  it('reads failed when its last attempt failed, or its job died, and never claims the switch', async () => {
    const businessId = await chatEndingSoon();
    const { service, job } = await upgradeAnsweredProcessing(businessId);
    /* The last attempt fails inside settlement: the handler audits it and finishes the job. */
    await ownerDb.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION public.test_refuse_no_charge_apply() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test: settlement cannot apply' USING ERRCODE = 'P0001'; END $$;
      DROP TRIGGER IF EXISTS test_refuse_no_charge_apply ON businesses;
      CREATE TRIGGER test_refuse_no_charge_apply BEFORE UPDATE OF plan ON businesses
        FOR EACH ROW EXECUTE FUNCTION public.test_refuse_no_charge_apply();`),
    );
    try {
      await runJob(businessId, job, 5);
    } finally {
      await ownerDb.execute(
        sql.raw(`DROP TRIGGER IF EXISTS test_refuse_no_charge_apply ON businesses;
                 DROP FUNCTION IF EXISTS public.test_refuse_no_charge_apply();`),
      );
    }
    await setJob(job.id, 'done');
    let view = await service.overview(businessId);
    expect(view.noChargeUpgrade).toEqual({ plan: 'complete', state: 'failed' });
    expect(view.plan).toBe('chat');
    // A job that died is the same: it will not run again.
    await setJob(job.id, 'dead');
    view = await service.overview(businessId);
    expect(view.noChargeUpgrade?.state).toBe('failed');
  });

  it('is null with no zero-priced upgrade, and follows the newest request when the merchant asks again', async () => {
    const businessId = await chatEndingSoon();
    const service = new BillingService(config as never, appDb);
    expect((await service.overview(businessId)).noChargeUpgrade).toBeNull();
    const first = await upgradeAnsweredProcessing(businessId);
    await setJob(first.job.id, 'dead');
    expect((await service.overview(businessId)).noChargeUpgrade?.state).toBe('failed');
    /* Choosing the plan again retires the stopped one and queues a fresh request. */
    first.service.zeroChargeWaitMs = 0;
    expect(await first.service.changePlan(businessId, 'complete')).toMatchObject({
      state: 'processing',
    });
    expect((await service.overview(businessId)).noChargeUpgrade?.state).toBe('processing');
    const refs = await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.latestNoChargeUpgrade(tx, businessId),
    );
    expect(refs?.reference).not.toBe(first.job.reference);
  });
});
