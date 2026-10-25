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

  it('gives a definitively refused send back, so the next pass retries it and records no cost', async () => {
    const { id } = await seedTrial();
    const sender = new StubSender();
    sender.failWith(new SendFailed('meta 400', 100, true));

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

    expect(claimed).toBe(false);
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

  it('a failure after Meta accepted (cost bookkeeping) never puts the claim back', async () => {
    const { id } = await seedTrial();
    const sender = new StubSender();
    /* The platform cost table refuses the write, as a broken ledger would. */
    await ownerDb.execute(sql`ALTER TABLE platform_cost_events RENAME TO platform_cost_events_x`);
    try {
      await sweep(sender, at(12));
      await sweep(sender, at(12, 3_600_000));
    } finally {
      await ownerDb.execute(sql`ALTER TABLE platform_cost_events_x RENAME TO platform_cost_events`);
    }

    expect(sender.trialNotices).toHaveLength(1);
    expect((await stateOf(id)).stage).toBe(2);
  });

  it('a trial that ends between the listing and the claim is not claimed', async () => {
    const { id } = await seedTrial();
    const { subscriptionsRepo } = await import('@rekoda/db');

    const claimed = await withBusiness(appDb, id, (tx) =>
      subscriptionsRepo.claimTrialNotice(tx, id, 3, expiry),
    );

    expect(claimed).toBe(false);
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

    expect(claimed).toBe(false);
    expect((await stateOf(id)).stage).toBeNull();
  });
});
