/**
 * The retention sweep, end to end (ADR 0024, /privacy#retention).
 *
 * The storage and the privileged delete function are proven in
 * packages/db/src/retention.integration.test.ts. What this pins is the chain
 * between the two stages, and one property above all:
 *
 *   a warning that could not be delivered leaves the account unclaimed, and
 *   an unclaimed account is never deleted.
 *
 * That is the whole safety of the design. The schedule promises notice; if
 * the notice does not go out, nothing goes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RETENTION, RETENTION_NOTICE_DAYS } from '@rekoda/core';
import {
  billingRepo,
  createDb,
  identity,
  retentionRepo,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { SendFailed } from '../channels/sender.js';
import { StubSender } from '../channels/sender.stub.js';
import { sweepRetention } from './retention-sweep.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let phoneSeq = 0;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** A trial that ended `endedDaysAgo` and was never converted. */
async function abandonedTrial(
  endedDaysAgo: number,
): Promise<{ businessId: string; phone: string }> {
  phoneSeq += 1;
  const phone = `+23481700000${String(phoneSeq).padStart(2, '0')}`;
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await billingRepo.setPlan(appDb, {
    businessId: business.id,
    plan: 'trial',
    expiresAt: daysAgo(endedDaysAgo),
    actor: 'operator:test',
  });
  return { businessId: business.id, phone };
}

const deps = (sender: StubSender) => ({ workerDb, appDb, sender });

const exists = async (businessId: string): Promise<boolean> =>
  (await withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.subscriptionFor(tx, businessId),
  )) !== null;

describe('the warning', () => {
  it('does nothing at all when nobody is due', async () => {
    await abandonedTrial(2);
    const sender = new StubSender();

    expect(await sweepRetention(deps(sender), new Date())).toEqual({
      warned: 0,
      deleted: 0,
      rowsRemoved: 0,
    });
    expect(sender.retentionNotices).toEqual([]);
  });

  it('warns a merchant whose trial ended long enough ago, once', async () => {
    const { businessId, phone } = await abandonedTrial(RETENTION_NOTICE_DAYS + 5);
    const sender = new StubSender();

    const first = await sweepRetention(deps(sender), new Date());
    expect(first.warned).toBe(1);
    expect(sender.retentionNotices).toHaveLength(1);
    expect(sender.retentionNotices[0]?.to).toBe(phone);
    // Told the date, and how long they have. Nothing about what they sell.
    expect(sender.retentionNotices[0]?.deletesOn).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(Number(sender.retentionNotices[0]?.daysLeft)).toBeGreaterThan(0);

    // A second pass sends nothing: the claim is taken.
    expect((await sweepRetention(deps(sender), new Date())).warned).toBe(0);
    expect(sender.retentionNotices).toHaveLength(1);
    expect(await exists(businessId)).toBe(true);
  });

  it('does not warn, or claim, a merchant who has ever paid us', async () => {
    const { businessId } = await abandonedTrial(400);
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'first_purchase',
        plan: 'chat',
        amountK: 990_000,
        reference: 'RKD-SUB-20260101-AAAAAA',
        periodStart: daysAgo(400),
        periodEnd: daysAgo(370),
      }),
    );
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.settleCharge(tx, {
        reference: 'RKD-SUB-20260101-AAAAAA',
        status: 'paid',
        when: daysAgo(400),
      }),
    );

    const sender = new StubSender();
    expect(await sweepRetention(deps(sender), new Date())).toEqual({
      warned: 0,
      deleted: 0,
      rowsRemoved: 0,
    });
    expect(await exists(businessId)).toBe(true);
  });

  it('honours STOP by staying silent AND keeping the records', async () => {
    const { businessId, phone } = await abandonedTrial(400);
    await identity.setOptOut(appDb, phone, new Date());

    const sender = new StubSender();
    const swept = await sweepRetention(deps(sender), new Date());
    expect(sender.retentionNotices).toEqual([]);
    expect(swept.warned).toBe(0);

    // A merchant who asked for silence did not ask to be forgotten. The claim
    // is never taken, so the deletion stage never sees them.
    expect(swept.deleted).toBe(0);
    expect(await exists(businessId)).toBe(true);
  });
});

describe('the deletion', () => {
  it('NEVER deletes an account the warning could not reach', async () => {
    const { businessId } = await abandonedTrial(400);
    const sender = new StubSender();
    // What an unapproved template, or an outage, looks like.
    sender.failWith(new SendFailed('no retention template configured'));

    const swept = await sweepRetention(deps(sender), new Date());
    expect(swept.warned).toBe(0);
    expect(swept.deleted).toBe(0);
    expect(await exists(businessId)).toBe(true);

    // Still nothing on a later pass: unwarned means undeletable, forever, and
    // the sweep will keep trying to warn instead.
    expect((await sweepRetention(deps(sender), new Date())).deleted).toBe(0);
    expect(await exists(businessId)).toBe(true);
  });

  it('deletes only after the notice period has actually run', async () => {
    const { businessId } = await abandonedTrial(RETENTION.abandonedTrialDays + 10);
    const sender = new StubSender();

    const warned = await sweepRetention(deps(sender), new Date());
    expect(warned).toMatchObject({ warned: 1, deleted: 0 });
    expect(await exists(businessId)).toBe(true);

    // The day before the notice period is up: still nothing.
    const almost = new Date(Date.now() + (RETENTION.noticeDays - 1) * 86_400_000);
    expect((await sweepRetention(deps(sender), almost)).deleted).toBe(0);
    expect(await exists(businessId)).toBe(true);

    // And on the day it is up.
    const due = new Date(Date.now() + (RETENTION.noticeDays + 1) * 86_400_000);
    const swept = await sweepRetention(deps(sender), due);
    expect(swept.deleted).toBe(1);
    expect(swept.rowsRemoved).toBeGreaterThan(0);
    expect(await exists(businessId)).toBe(false);

    // The proof outlives the tenant.
    const record = (await retentionRepo.deletions(workerDb)).find(
      (row) => row.businessId === businessId,
    );
    expect(record?.reason).toBe('abandoned_trial');
  });

  it('stops for a merchant who started paying after the warning went out', async () => {
    const { businessId } = await abandonedTrial(RETENTION.abandonedTrialDays + 10);
    const sender = new StubSender();
    await sweepRetention(deps(sender), new Date());

    // They came back and subscribed. The books are theirs again.
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'first_purchase',
        plan: 'chat',
        amountK: 990_000,
        reference: 'RKD-SUB-20260601-BBBBBB',
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86_400_000),
      }),
    );
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.settleCharge(tx, {
        reference: 'RKD-SUB-20260601-BBBBBB',
        status: 'paid',
        when: new Date(),
      }),
    );

    const due = new Date(Date.now() + (RETENTION.noticeDays + 1) * 86_400_000);
    expect((await sweepRetention(deps(sender), due)).deleted).toBe(0);
    expect(await exists(businessId)).toBe(true);
  });
});
