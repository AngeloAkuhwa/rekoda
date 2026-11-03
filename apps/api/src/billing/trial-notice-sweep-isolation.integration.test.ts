/**
 * Trial reminders at 7, 2 and 1 days before expiry (G-109, OWN-56).
 *
 * The assertions are about what the merchant is sent and what the books record, not
 * about the sweep's return value: one message per milestone, nothing before day 7 or
 * after expiry, nothing through an unconfigured template, nothing to someone who has
 * opted out or already bought a plan, and a failed send retried rather than lost.
 */
// The trial reminder suite (G-109, OWN-56). Split by concern; the rest of this suite is in trial-
// notice-sweep.integration.test.ts, trial-notice-sweep-eligibility.integration.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { TRIAL_DAYS } from '@rekoda/core';

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;
let workerDb: Db;
let closeWorker: () => Promise<void>;
let ownerDb: Db;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const DAY = 86_400_000;
const start = new Date('2026-11-02T09:00:00Z');
const expiry = new Date(start.getTime() + TRIAL_DAYS * DAY);
const at = (days: number, extraMs = 0): Date => new Date(start.getTime() + days * DAY + extraMs);

let seq = 0;
async function seedTrial(phone?: string): Promise<{ id: string; phone: string }> {
  seq += 1;
  const number = phone ?? `+23481800${String(seq).padStart(4, '0')}`;
  const user = await identity.upsertUserByPhone(appDb, number);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Trial Notice Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  await ownerDb.execute(
    sql`UPDATE businesses SET plan = 'trial', plan_expires_at = ${expiry.toISOString()}::timestamptz WHERE id = ${business.id}::uuid`,
  );
  return { id: business.id, phone: number };
}

async function stateOf(id: string) {
  const rows = await ownerDb.execute<{
    stage: number | null;
    state: string | null;
    provider: string | null;
  }>(
    sql`SELECT last_trial_notice_stage AS stage, trial_notice_state AS state, trial_notice_provider_message_id AS provider FROM businesses WHERE id = ${id}::uuid`,
  );
  return [...rows][0]!;
}

describe('trial reminders', () => {
  describe('tenant isolation of the reminder sweep (security review)', () => {
    it('lists only the minimum: an id, the trial end and the latest attempt', async () => {
      await seedTrial();
      const { subscriptionsRepo } = await import('@rekoda/db');

      const rows = await subscriptionsRepo.trialsEndingWithin(workerDb, at(12), 7);

      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!).sort()).toEqual(['attempt', 'businessId', 'trialEndsAt']);
    });

    it('discovery is a SECURITY DEFINER function with a pinned path, executable by the worker alone', async () => {
      const fn = [
        ...(await ownerDb.execute<{
          definer: boolean;
          config: string[] | null;
          columns: string[];
          app: boolean;
          worker: boolean;
          pub: boolean;
        }>(sql`
          SELECT p.prosecdef AS definer, p.proconfig AS config,
                 (SELECT array_agg(a ORDER BY a) FROM unnest(p.proargnames) a
                   WHERE a NOT IN ('as_of', 'within_days', 'page_size', 'after_id')) AS columns,
                 has_function_privilege('rekoda_app', p.oid, 'EXECUTE') AS app,
                 has_function_privilege('rekoda_worker', p.oid, 'EXECUTE') AS worker,
                 has_function_privilege('public', p.oid, 'EXECUTE') AS pub
          FROM pg_proc p WHERE p.proname = 'sweep_trial_candidates'
        `)),
      ];

      expect(fn).toHaveLength(1);
      expect(fn[0]!.definer).toBe(true);
      expect(fn[0]!.config).toContain('search_path=pg_catalog, pg_temp');
      expect(fn[0]!.worker).toBe(true);
      expect(fn[0]!.app).toBe(false);
      expect(fn[0]!.pub).toBe(false);
      expect(fn[0]!.columns).toEqual(
        [
          'id',
          'plan_expires_at',
          'last_trial_notice_stage',
          'trial_notice_state',
          'trial_notice_attempted_at',
        ].sort(),
      );
    });

    it('the application role cannot run discovery', async () => {
      await seedTrial();

      await expect(
        appDb.execute(
          sql`SELECT * FROM sweep_trial_candidates(${at(12).toISOString()}::timestamptz, 7, 10, NULL)`,
        ),
      ).rejects.toThrow();
    });

    it('discovery names only running trials: not a bought plan, an expired trial or a later trial', async () => {
      const running = await seedTrial();
      const bought = await seedTrial();
      const ended = await seedTrial();
      const later = await seedTrial();
      await ownerDb.execute(sql`UPDATE businesses SET plan = 'chat' WHERE id = ${bought.id}::uuid`);
      await ownerDb.execute(
        sql`UPDATE businesses SET plan_expires_at = ${at(10).toISOString()}::timestamptz WHERE id = ${ended.id}::uuid`,
      );
      await ownerDb.execute(
        sql`UPDATE businesses SET plan_expires_at = ${at(40).toISOString()}::timestamptz WHERE id = ${later.id}::uuid`,
      );
      const { subscriptionsRepo } = await import('@rekoda/db');

      const rows = await subscriptionsRepo.trialsEndingWithin(workerDb, at(12), 7);

      expect(rows.map((r) => r.businessId)).toEqual([running.id]);
    });

    it('clamps the window and the page, and pages by id without repeats or gaps', async () => {
      const ids: string[] = [];
      for (let k = 0; k < 5; k += 1) ids.push((await seedTrial()).id);
      const far = await seedTrial();
      await ownerDb.execute(
        sql`UPDATE businesses SET plan_expires_at = ${at(100).toISOString()}::timestamptz WHERE id = ${far.id}::uuid`,
      );
      const { subscriptionsRepo } = await import('@rekoda/db');

      /* A window of 10000 days is capped at 60: the trial 100 days out is never listed. */
      const wide = await subscriptionsRepo.trialsEndingWithin(workerDb, at(0), 10_000, 100);
      expect(wide.map((r) => r.businessId).sort()).toEqual([...ids].sort());
      /* A negative window and a zero page still return a bounded, sane answer. */
      expect(await subscriptionsRepo.trialsEndingWithin(workerDb, at(0), -5, 100)).toEqual([]);
      expect(await subscriptionsRepo.trialsEndingWithin(workerDb, at(0), 20, 0)).toHaveLength(1);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await subscriptionsRepo.trialsEndingWithin(workerDb, at(0), 20, 2, cursor);
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.businessId));
        cursor = page[page.length - 1]!.businessId;
      }
      expect(seen).toEqual([...ids].sort());
    });

    it('scheduling a due task grants no wider read: discovery returns no business column beyond the minimum', async () => {
      await seedTrial();

      const raw = await workerDb.execute<Record<string, unknown>>(
        sql`SELECT * FROM sweep_trial_candidates(${at(12).toISOString()}::timestamptz, 7, 10, NULL)`,
      );

      expect(Object.keys([...raw][0]!).sort()).toEqual([
        'id',
        'last_trial_notice_stage',
        'plan_expires_at',
        'trial_notice_attempted_at',
        'trial_notice_state',
      ]);
    });

    it('the worker role can read candidates but cannot write a business row', async () => {
      const { id } = await seedTrial();

      const visible = await workerDb.execute<{ id: string }>(
        sql`SELECT id FROM businesses WHERE id = ${id}::uuid`,
      );
      const written = await workerDb.execute<{ id: string }>(
        sql`UPDATE businesses SET trial_notice_state = 'sent', last_trial_notice_stage = 3 WHERE id = ${id}::uuid RETURNING id`,
      );

      expect([...visible]).toHaveLength(1);
      expect([...written]).toHaveLength(0);
      expect((await stateOf(id)).stage).toBeNull();
    });

    it('an unpinned application connection sees and changes no business', async () => {
      const { id } = await seedTrial();

      const written = await appDb.execute<{ id: string }>(
        sql`UPDATE businesses SET trial_notice_state = 'sent' WHERE id = ${id}::uuid RETURNING id`,
      );

      expect([...written]).toHaveLength(0);
    });

    it('a candidate id used under another tenant changes nothing, for every write', async () => {
      const victim = await seedTrial();
      const other = await seedTrial();
      const { subscriptionsRepo } = await import('@rekoda/db');
      /* The victim is mid-attempt, so every write below WOULD change it if the tenant pin
       * did not stop it. */
      await withBusiness(appDb, victim.id, (tx) =>
        subscriptionsRepo.claimTrialNotice(tx, victim.id, 2, at(12)),
      );
      const asOther = <T>(
        fn: (tx: Parameters<Parameters<typeof withBusiness>[2]>[0]) => Promise<T>,
      ) => withBusiness(appDb, other.id, fn);

      expect(
        await asOther((tx) => subscriptionsRepo.claimTrialNotice(tx, victim.id, 3, at(13))),
      ).toBe('not_claimed');
      expect(
        await asOther((tx) =>
          subscriptionsRepo.finalizeTrialNoticeDispatch(tx, victim.id, 2, at(12)),
        ),
      ).toEqual({ outcome: 'lost' });
      await asOther((tx) => subscriptionsRepo.markTrialNoticeSent(tx, victim.id, 2, 'x'));
      await asOther((tx) => subscriptionsRepo.markTrialNoticeRefused(tx, victim.id, 2));
      expect(
        await asOther((tx) => subscriptionsRepo.markTrialNoticeUnknown(tx, victim.id, 2)),
      ).toBe(false);
      await asOther((tx) => subscriptionsRepo.releaseTrialNotice(tx, victim.id, 2));

      expect(await stateOf(victim.id)).toEqual({ stage: 2, state: 'sending', provider: null });
    });

    it('never reads the owner phone outside the tenant that owns it', async () => {
      const victim = await seedTrial();
      const other = await seedTrial();
      const { subscriptionsRepo } = await import('@rekoda/db');
      await withBusiness(appDb, victim.id, (tx) =>
        subscriptionsRepo.claimTrialNotice(tx, victim.id, 2, at(12)),
      );

      const final = await withBusiness(appDb, other.id, (tx) =>
        subscriptionsRepo.finalizeTrialNoticeDispatch(tx, victim.id, 2, at(12)),
      );

      expect(final).toEqual({ outcome: 'lost' });
    });
  });
});
