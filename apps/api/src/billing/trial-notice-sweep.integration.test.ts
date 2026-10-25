/**
 * Trial reminders at 7, 2 and 1 days before expiry (G-109, OWN-56).
 *
 * The assertions are about what the merchant is sent and what the books record, not
 * about the sweep's return value: one message per milestone, nothing before day 7 or
 * after expiry, nothing through an unconfigured template, nothing to someone who has
 * opted out or already bought a plan, and a failed send retried rather than lost.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { TRIAL_DAYS } from '@rekoda/core';
import { SendFailed } from '../channels/sender.js';
import { StubSender } from '../channels/sender.stub.js';
import { sweepTrialNotices } from './trial-notice-sweep.js';

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
  sweepTrialNotices({ workerDb, appDb, sender, templateConfigured, fxNairaPerUsd: 1500 }, now);

describe('trial reminders', () => {
  it('sends nothing on days 0 to 6', async () => {
    await seedTrial();
    const sender = new StubSender();

    for (const now of [at(0), at(1), at(6, 86_399_999)]) await sweep(sender, now);

    expect(sender.trialNotices).toHaveLength(0);
  });

  it('sends exactly one message per milestone, however often the sweep runs', async () => {
    const { phone } = await seedTrial();
    const sender = new StubSender();

    for (const now of [at(7), at(7, 3_600_000), at(9), at(12), at(12, 60_000), at(13), at(13, 5)]) {
      await sweep(sender, now);
    }

    expect(sender.trialNotices).toEqual([
      { to: phone, daysLeft: '7', endsOn: '16/11/2026' },
      { to: phone, daysLeft: '2', endsOn: '16/11/2026' },
      { to: phone, daysLeft: '1', endsOn: '16/11/2026' },
    ]);
  });

  it('sends nothing at or after the expiry instant', async () => {
    await seedTrial();
    const sender = new StubSender();

    await sweep(sender, at(14));
    await sweep(sender, at(15));

    expect(sender.trialNotices).toHaveLength(0);
  });

  it('after an outage across a milestone sends only the latest stage reached, once', async () => {
    const { phone } = await seedTrial();
    const sender = new StubSender();

    await sweep(sender, at(13, 1_000));

    expect(sender.trialNotices).toEqual([{ to: phone, daysLeft: '1', endsOn: '16/11/2026' }]);
  });

  it('does nothing, and claims nothing, while no template is configured', async () => {
    const { id } = await seedTrial();
    const sender = new StubSender();

    const result = await sweep(sender, at(12), false);

    expect(result.disabled).toBe(true);
    expect(sender.trialNotices).toHaveLength(0);
    const rows = await ownerDb.execute<{ s: number | null }>(
      sql`SELECT last_trial_notice_stage AS s FROM businesses WHERE id = ${id}::uuid`,
    );
    expect([...rows][0]?.s).toBeNull();

    /* Approving the template later still reaches the trial that is still running. */
    await sweep(sender, at(12, 3_600_000));
    expect(sender.trialNotices).toHaveLength(1);
  });

  it('gives a transiently refused send back, so the next pass retries it and records no cost', async () => {
    const { id } = await seedTrial();
    const sender = new StubSender();
    sender.failWith(new SendFailed('meta 429', 130429, true, true));

    const first = await sweep(sender, at(12));
    expect(first).toMatchObject({ sent: 0, failed: 1 });
    expect(sender.trialNotices).toHaveLength(0);
    const cost = () =>
      ownerDb.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM platform_cost_events WHERE business_id = ${id}::uuid`,
      );
    expect([...(await cost())][0]?.n).toBe('0');

    const second = await sweep(sender, at(12, 3_600_000));
    expect(second).toMatchObject({ sent: 1, failed: 0 });
    expect(sender.trialNotices).toHaveLength(1);
    expect([...(await cost())][0]?.n).toBe('1');
  });

  it('never messages an owner who sent STOP, claims nothing, and owes the milestone after START', async () => {
    const { id } = await seedTrial();
    await ownerDb.execute(
      sql`UPDATE users SET opted_out_at = now() WHERE id = (SELECT owner_user_id FROM businesses WHERE id = ${id}::uuid)`,
    );
    const sender = new StubSender();

    const result = await sweep(sender, at(12));

    expect(result).toMatchObject({ sent: 0, optedOut: 1 });
    expect(sender.trialNotices).toHaveLength(0);
    expect((await stateOf(id)).stage).toBeNull();

    await ownerDb.execute(sql`UPDATE users SET opted_out_at = NULL WHERE opted_out_at IS NOT NULL`);
    await sweep(sender, at(12, 3_600_000));
    expect(sender.trialNotices).toHaveLength(1);
  });

  it('sends nothing to a business that has bought a plan', async () => {
    const { id } = await seedTrial();
    await ownerDb.execute(sql`UPDATE businesses SET plan = 'chat' WHERE id = ${id}::uuid`);
    const sender = new StubSender();

    await sweep(sender, at(12));

    expect(sender.trialNotices).toHaveLength(0);
  });

  it('a purchase landing between the read and the claim sends nothing', async () => {
    const { id } = await seedTrial();
    const { subscriptionsRepo } = await import('@rekoda/db');
    await ownerDb.execute(sql`UPDATE businesses SET plan = 'chat' WHERE id = ${id}::uuid`);

    const claimed = await withBusiness(appDb, id, (tx) =>
      subscriptionsRepo.claimTrialNotice(tx, id, 2, at(12)),
    );

    expect(claimed).toBe('not_claimed');
  });

  it('two overlapping passes produce one message', async () => {
    await seedTrial();
    const sender = new StubSender();

    await Promise.all([sweep(sender, at(12)), sweep(sender, at(12))]);

    expect(sender.trialNotices).toHaveLength(1);
  });

  it('records an accepted send durably, with the provider message id', async () => {
    const { id } = await seedTrial();
    const sender = new StubSender();

    await sweep(sender, at(12));

    expect(await stateOf(id)).toEqual({ stage: 2, state: 'sent', provider: 'stub-1' });
  });

  it('keeps the claim and does not resend when the outcome is unknown (a timeout)', async () => {
    const { id } = await seedTrial();
    const sender = new StubSender();
    sender.failWith(new SendFailed('meta request failed: AbortError'));

    const first = await sweep(sender, at(12));
    const second = await sweep(sender, at(12, 3_600_000));

    expect(first).toMatchObject({ sent: 0, uncertain: 1, failed: 0 });
    expect(second).toMatchObject({ sent: 0, uncertain: 0 });
    expect(sender.trialNotices).toHaveLength(0);
    expect(await stateOf(id)).toMatchObject({ stage: 2, state: 'unknown' });

    /* The next milestone is still owed. */
    await sweep(sender, at(13));
    expect(sender.trialNotices).toHaveLength(1);
  });

  it('turns an attempt abandoned mid-send into unknown after 30 minutes, and never resends it', async () => {
    const { id } = await seedTrial();
    const sender = new StubSender();
    await ownerDb.execute(
      sql`UPDATE businesses SET last_trial_notice_stage = 2, trial_notice_state = 'sending', trial_notice_attempted_at = ${at(12).toISOString()}::timestamptz WHERE id = ${id}::uuid`,
    );

    const young = await sweep(sender, at(12, 10 * 60_000));
    expect(young.uncertain).toBe(0);
    expect((await stateOf(id)).state).toBe('sending');

    const stale = await sweep(sender, at(12, 31 * 60_000));
    expect(stale.uncertain).toBe(1);
    expect((await stateOf(id)).state).toBe('unknown');
    expect(sender.trialNotices).toHaveLength(0);
  });

  it('a trial that ends between the listing and the claim is not claimed', async () => {
    const { id } = await seedTrial();
    const { subscriptionsRepo } = await import('@rekoda/db');

    const claimed = await withBusiness(appDb, id, (tx) =>
      subscriptionsRepo.claimTrialNotice(tx, id, 3, expiry),
    );

    expect(claimed).toBe('not_claimed');
    expect((await stateOf(id)).stage).toBeNull();
  });

  it('an owner who sends STOP between the listing and the claim is not claimed', async () => {
    const { id } = await seedTrial();
    const { subscriptionsRepo } = await import('@rekoda/db');
    await ownerDb.execute(
      sql`UPDATE users SET opted_out_at = now() WHERE id = (SELECT owner_user_id FROM businesses WHERE id = ${id}::uuid)`,
    );

    const claimed = await withBusiness(appDb, id, (tx) =>
      subscriptionsRepo.claimTrialNotice(tx, id, 2, at(12)),
    );

    expect(claimed).toBe('opted_out');
    expect((await stateOf(id)).stage).toBeNull();
  });

  it('records the cost of an accepted message even when marking it sent fails', async () => {
    const { id } = await seedTrial();
    const sender = new StubSender();
    /* Marking an attempt 'sent' is refused, as a failing write would be. */
    await ownerDb.execute(sql`
      CREATE FUNCTION refuse_sent() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.trial_notice_state = 'sent' THEN RAISE EXCEPTION 'refused'; END IF;
        RETURN NEW;
      END $$`);
    await ownerDb.execute(
      sql`CREATE TRIGGER refuse_sent BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION refuse_sent()`,
    );
    try {
      const result = await sweep(sender, at(12));
      expect(result.sent).toBe(1);
      /* A later pass (past the 30 minute stale rule) must not send it again. */
      await sweep(sender, at(12, 3_600_000));
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER refuse_sent ON businesses`);
      await ownerDb.execute(sql`DROP FUNCTION refuse_sent()`);
    }

    expect(sender.trialNotices).toHaveLength(1);
    const cost = await ownerDb.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM platform_cost_events WHERE business_id = ${id}::uuid`,
    );
    expect([...cost][0]?.n).toBe('1');
    /* The acknowledgement never landed, so the stale rule has by now called it unknown; it was
     * not resent. */
    expect((await stateOf(id)).state).toBe('unknown');
  });

  it('one business whose claim fails does not stop the others', async () => {
    const first = await seedTrial();
    const second = await seedTrial();
    const sender = new StubSender();
    await ownerDb.execute(
      sql.raw(`
      CREATE FUNCTION refuse_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.trial_notice_state = 'sending' AND NEW.id = '${first.id}'::uuid THEN
          RAISE EXCEPTION 'refused';
        END IF;
        RETURN NEW;
      END $$`),
    );
    await ownerDb.execute(
      sql`CREATE TRIGGER refuse_claim BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION refuse_claim()`,
    );
    try {
      await sweep(sender, at(12));
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER refuse_claim ON businesses`);
      await ownerDb.execute(sql`DROP FUNCTION refuse_claim()`);
    }

    expect(sender.trialNotices.map((n) => n.to)).toEqual([second.phone]);
    expect((await stateOf(first.id)).stage).toBeNull();
  });

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
        "IF NEW.plan = 'trial' THEN UPDATE businesses SET plan = 'chat' WHERE id = NEW.id; END IF;",
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

  describe('tenant isolation of the reminder sweep (security review)', () => {
    it('lists only the minimum: an id, the trial end and the latest attempt', async () => {
      await seedTrial();
      const { subscriptionsRepo } = await import('@rekoda/db');

      const rows = await subscriptionsRepo.trialsEndingWithin(workerDb, at(12), 7);

      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!).sort()).toEqual(['attempt', 'businessId', 'trialEndsAt']);
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

  describe('provider refusals and the clock', () => {
    it('a permanent refusal is recorded against the stage and not retried every hour', async () => {
      const { id } = await seedTrial();
      const sender = new StubSender();
      sender.failTrialNoticesWith(new SendFailed('meta 132001', 132001, true, false));

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
        { workerDb, appDb, sender, templateConfigured: true, fxNairaPerUsd: 1500 },
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
          return Promise.reject(new SendFailed('meta 132001', 132001, true, false, false));
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

  it('skips a stage the listing already shows as handled, and does not recount an opted-out owner', async () => {
    const { id } = await seedTrial();
    const sender = new StubSender();
    await sweep(sender, at(12));
    expect(sender.trialNotices).toHaveLength(1);
    await ownerDb.execute(
      sql`UPDATE users SET opted_out_at = now() WHERE id = (SELECT owner_user_id FROM businesses WHERE id = ${id}::uuid)`,
    );

    const later = await sweep(sender, at(12, 3_600_000));

    expect(later).toMatchObject({ sent: 0, optedOut: 0 });
    expect(sender.trialNotices).toHaveLength(1);
  });
});
