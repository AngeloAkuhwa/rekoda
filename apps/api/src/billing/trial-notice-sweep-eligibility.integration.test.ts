/**
 * Trial reminders at 7, 2 and 1 days before expiry (G-109, OWN-56).
 *
 * The assertions are about what the merchant is sent and what the books record, not
 * about the sweep's return value: one message per milestone, nothing before day 7 or
 * after expiry, nothing through an unconfigured template, nothing to someone who has
 * opted out or already bought a plan, and a failed send retried rather than lost.
 */
// The trial reminder suite (G-109, OWN-56). Split by concern; the rest of this suite is in trial-
// notice-sweep.integration.test.ts, trial-notice-sweep-isolation.integration.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { TRIAL_DAYS } from '@rekoda/core';
import { SendFailed } from '../channels/sender.js';
import { StubSender } from '../channels/sender.stub.js';
import { sweepTrialNotices } from './trial-notice-sweep.js';

/** The billing page the grace and trial templates link to (`{{3}}`, OD-41(b)). */
const BILLING_URL = 'https://app.rekoda.test/app/billing';

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

const sweep = (sender: StubSender, now: Date, templateConfigured = true) =>
  sweepTrialNotices(
    { workerDb, appDb, sender, templateConfigured, fxNairaPerUsd: 1500, billingUrl: BILLING_URL },
    now,
  );

describe('trial reminders', () => {
  describe('the final eligibility check before dispatch (owner ruling, 25 Oct 2026)', () => {
    /* A trigger fires inside the claim's own transaction, so the change commits together
     * with the claim and is therefore visible to the final check but not to the claim's
     * predicate: the exact "after claim, before dispatch" window. */
    async function afterClaim(effect: string, run: () => Promise<void>): Promise<void> {
      await ownerDb.execute(
        sql.raw(`
        CREATE FUNCTION after_claim_effect() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.trial_notice_state = 'sending' AND OLD.trial_notice_state IS DISTINCT FROM 'sending' THEN
            ${effect}
          END IF;
          RETURN NEW;
        END $$`),
      );
      await ownerDb.execute(
        sql`CREATE TRIGGER after_claim_effect AFTER UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION after_claim_effect()`,
      );
      try {
        await run();
      } finally {
        await ownerDb.execute(sql`DROP TRIGGER after_claim_effect ON businesses`);
        await ownerDb.execute(sql`DROP FUNCTION after_claim_effect()`);
      }
    }

    const costRows = async (id: string) =>
      [
        ...(await ownerDb.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM platform_cost_events WHERE business_id = ${id}::uuid`,
        )),
      ][0]?.n;

    it('a STOP that lands after the claim stops the send, and the stage is not retried', async () => {
      const { id } = await seedTrial();
      const sender = new StubSender();

      let result!: Awaited<ReturnType<typeof sweep>>;
      await afterClaim(
        'UPDATE users SET opted_out_at = now() WHERE id = NEW.owner_user_id;',
        async () => {
          result = await sweep(sender, at(12));
        },
      );

      expect(sender.trialNotices).toHaveLength(0);
      expect(result).toMatchObject({ sent: 0, suppressed: 1 });
      expect(await stateOf(id)).toMatchObject({ stage: 2, state: 'suppressed' });
      expect(await costRows(id)).toBe('0');

      /* Opting back in later does not resurrect the suppressed stage ... */
      await ownerDb.execute(
        sql`UPDATE users SET opted_out_at = NULL WHERE opted_out_at IS NOT NULL`,
      );
      await sweep(sender, at(12, 3_600_000));
      expect(sender.trialNotices).toHaveLength(0);
      /* ... but the next milestone is still owed. */
      await sweep(sender, at(13));
      expect(sender.trialNotices).toHaveLength(1);
    });

    it('a plan purchase that lands after the claim stops the send', async () => {
      const { id } = await seedTrial();
      const sender = new StubSender();

      let result!: Awaited<ReturnType<typeof sweep>>;
      await afterClaim(
        /* Through a plan writer (OD-37); the test harness's fixture writer stands in for a
         * settled purchase, which would need a paid charge staged first. */
        "IF NEW.plan = 'trial' THEN PERFORM test_fixture_set_plan(NEW.id, 'chat', NEW.plan_expires_at); END IF;",
        async () => {
          result = await sweep(sender, at(12));
        },
      );

      expect(sender.trialNotices).toHaveLength(0);
      expect(result).toMatchObject({ sent: 0, suppressed: 1 });
      expect((await stateOf(id)).state).toBe('suppressed');
      expect(await costRows(id)).toBe('0');
    });

    it('a trial that ends between the claim and the check stops the send', async () => {
      const { id } = await seedTrial();
      const { subscriptionsRepo } = await import('@rekoda/db');

      const claimed = await withBusiness(appDb, id, (tx) =>
        subscriptionsRepo.claimTrialNotice(tx, id, 3, at(13)),
      );
      const final = await withBusiness(appDb, id, (tx) =>
        subscriptionsRepo.finalizeTrialNoticeDispatch(tx, id, 3, expiry),
      );

      expect(claimed).toBe('claimed');
      expect(final).toEqual({ outcome: 'suppressed' });
      expect((await stateOf(id)).state).toBe('suppressed');
    });

    it('sends nothing when the attempt is no longer the one in flight', async () => {
      const { id } = await seedTrial();
      const { subscriptionsRepo } = await import('@rekoda/db');
      await withBusiness(appDb, id, (tx) => subscriptionsRepo.claimTrialNotice(tx, id, 2, at(12)));
      await ownerDb.execute(
        sql`UPDATE businesses SET trial_notice_state = 'unknown' WHERE id = ${id}::uuid`,
      );

      const final = await withBusiness(appDb, id, (tx) =>
        subscriptionsRepo.finalizeTrialNoticeDispatch(tx, id, 2, at(12)),
      );

      expect(final).toEqual({ outcome: 'lost' });
      expect((await stateOf(id)).state).toBe('unknown');
    });

    it('a failing final check puts the claim back, since nothing was sent', async () => {
      const { id } = await seedTrial();
      const sender = new StubSender();
      await ownerDb.execute(sql`
        CREATE FUNCTION refuse_suppress() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.trial_notice_state = 'sending' AND OLD.trial_notice_state = 'sending' THEN
            RAISE EXCEPTION 'refused';
          END IF;
          RETURN NEW;
        END $$`);
      await ownerDb.execute(
        sql`CREATE TRIGGER refuse_suppress BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION refuse_suppress()`,
      );
      try {
        await sweep(sender, at(12));
      } finally {
        await ownerDb.execute(sql`DROP TRIGGER refuse_suppress ON businesses`);
        await ownerDb.execute(sql`DROP FUNCTION refuse_suppress()`);
      }

      expect(sender.trialNotices).toHaveLength(0);
      expect((await stateOf(id)).stage).toBe(1);
    });
  });

  describe('provider refusals and the clock', () => {
    it('a recipient-permanent refusal is recorded against the stage and not retried every hour', async () => {
      const { id } = await seedTrial();
      const sender = new StubSender();
      sender.failTrialNoticesWith(new SendFailed('meta 131026', 131026, true, false));

      const first = await sweep(sender, at(12));
      const second = await sweep(sender, at(12, 3_600_000));
      const third = await sweep(sender, at(12, 7_200_000));

      expect(first).toMatchObject({ refused: 1, failed: 0 });
      expect(second).toMatchObject({ refused: 0 });
      expect(third).toMatchObject({ refused: 0 });
      expect(await stateOf(id)).toMatchObject({ stage: 2, state: 'refused' });

      /* The next milestone is still owed once the template is fixed. */
      sender.reset();
      await sweep(sender, at(13));
      expect(sender.trialNotices).toHaveLength(1);
    });

    it('stops the pass after repeated transient refusals instead of asking Meta once per trial', async () => {
      for (let i = 0; i < 6; i += 1) await seedTrial();
      let attempts = 0;
      const sender = new StubSender();
      const original = sender.sendTrialNotice.bind(sender);
      sender.sendTrialNotice = (notice) => {
        attempts += 1;
        return original(notice);
      };
      sender.failTrialNoticesWith(new SendFailed('meta 429', 130429, true, true, true));

      const result = await sweep(sender, at(12));

      expect(attempts).toBe(3);
      expect(result).toMatchObject({ stoppedEarly: true, failed: 3, sent: 0 });

      /* A later pass, once the outage has cleared, still reaches everyone. */
      sender.reset();
      await sweep(sender, at(12, 3_600_000));
      expect(sender.trialNotices).toHaveLength(6);
    });

    it('rechecks eligibility against a fresh clock at each claim', async () => {
      await seedTrial();
      const sender = new StubSender();
      /* The first two reads (pass start, stage) are inside the trial; the claim's read is
       * after it ended, as in a pass that has been running for minutes. */
      let reads = 0;
      const clock = () => {
        reads += 1;
        return reads <= 2 ? at(12) : expiry;
      };

      const result = await sweepTrialNotices(
        {
          workerDb,
          appDb,
          sender,
          templateConfigured: true,
          fxNairaPerUsd: 1500,
          billingUrl: BILLING_URL,
        },
        clock,
      );

      expect(sender.trialNotices).toHaveLength(0);
      expect(result.sent).toBe(0);
    });

    it('does not mislabel an attempt that was re-claimed after the listing was read', async () => {
      const { id } = await seedTrial();
      const { subscriptionsRepo } = await import('@rekoda/db');
      await withBusiness(appDb, id, (tx) => subscriptionsRepo.claimTrialNotice(tx, id, 2, at(12)));

      const marked = await withBusiness(appDb, id, (tx) =>
        subscriptionsRepo.markTrialNoticeUnknown(tx, id, 2, new Date(Date.now() - 60_000)),
      );

      expect(marked).toBe(false);
      expect((await stateOf(id)).state).toBe('sending');
    });

    /** A sender whose Nth call (in listing order) follows the given outcomes. */
    function scripted(outcomes: Array<'ok' | 'outage' | 'recipient' | 'permanent'>) {
      const sender = new StubSender();
      let call = 0;
      const original = sender.sendTrialNotice.bind(sender);
      sender.sendTrialNotice = (notice) => {
        const outcome = outcomes[call] ?? 'ok';
        call += 1;
        if (outcome === 'outage')
          return Promise.reject(new SendFailed('meta 429', 130429, true, true, true));
        if (outcome === 'recipient')
          return Promise.reject(new SendFailed('meta 131056', 131056, true, true, false));
        if (outcome === 'permanent')
          return Promise.reject(new SendFailed('meta 131026', 131026, true, false, false));
        return original(notice);
      };
      return { sender, calls: () => call };
    }

    it('does not stop the pass for per-recipient throttles, however many there are', async () => {
      for (let i = 0; i < 6; i += 1) await seedTrial();
      const { sender, calls } = scripted([
        'recipient',
        'recipient',
        'recipient',
        'recipient',
        'ok',
        'ok',
      ]);

      const result = await sweep(sender, at(12));

      expect(calls()).toBe(6);
      expect(result).toMatchObject({ stoppedEarly: false, failed: 4, sent: 2 });
    });

    it('counts only consecutive outages: a different answer in between clears the count', async () => {
      for (let i = 0; i < 6; i += 1) await seedTrial();
      const { sender, calls } = scripted([
        'outage',
        'outage',
        'permanent',
        'outage',
        'outage',
        'ok',
      ]);

      const result = await sweep(sender, at(12));

      expect(calls()).toBe(6);
      expect(result).toMatchObject({ stoppedEarly: false, refused: 1, failed: 4, sent: 1 });
    });
  });
});
