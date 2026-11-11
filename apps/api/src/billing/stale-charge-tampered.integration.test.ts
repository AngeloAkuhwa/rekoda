/**
 * OD-37, security re-review of PR #432 at 5772e92, finding B3 (migration 0206): settlement decides
 * whether a paid upgrade or renewal still buys anything from the charge's frozen period, not only
 * from the stale-charge markers (`plan_decided_at`, `superseded_at`) that the application credential
 * can write. An upgrade priced for the last days of one cycle and paid after the renewal goes to the
 * operator queue, even when those markers have been reset; the payment truth stays recorded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  settlementDb,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
import { applySettledCharge } from './billing.service.js';

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
    const { db, close } = createDb(url, { max: 2 });
    set(db);
    closers.push(close);
  }
});
afterAll(async () => {
  for (const close of closers) await close();
});
beforeEach(async () => {
  await truncateAll(urls);
});

const DAY = 86_400_000;
const config = {
  planCatalogueReads: false,
  paystackSecretKey: 'sk_test_x',
  paystackPlatformConfirmed: false,
};

async function open(
  businessId: string,
  kind: 'upgrade' | 'renewal',
  plan: string,
  periodStart: Date,
  periodEnd: Date,
  reference: string,
): Promise<string> {
  await withBusiness(settlementDb(), businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind,
      plan,
      amountK: kind === 'upgrade' ? 50_000 : 500_000,
      reference,
      periodStart,
      periodEnd,
      billingInterval: 'monthly',
    }),
  );
  return reference;
}

const settle = (businessId: string, reference: string) =>
  withBusiness(settlementDb(), businessId, (tx) =>
    applySettledCharge(tx, {
      businessId,
      reference,
      providerReference: `ps_${reference}`,
      when: new Date(),
      config,
    }),
  );

describe('B3: a stale upgrade is refused from its frozen period, whatever the markers say', () => {
  it('goes to the operator queue after a renewal, with plan_decided_at and superseded_at reset', async () => {
    const user = await identity.upsertUserByPhone(appDb, '+2348179990001');
    const { id: businessId } = await identity.createBusinessWithOwner(appDb, {
      name: 'Tampered Ltd',
      businessType: null,
      ownerUserId: user.id,
    });
    const firstEnd = new Date(Date.now() + 2 * DAY);
    await withBusiness(appDb, businessId, (tx) =>
      applyFixtureCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: new Date(firstEnd.getTime() - 30 * DAY),
        renewsAt: firstEnd,
        anchorDay: new Date(firstEnd.getTime() + 3_600_000).getUTCDate(),
      }),
    );
    // A two-day upgrade, then the renewal, opened while the first cycle runs.
    const upgrade = await open(
      businessId,
      'upgrade',
      'complete',
      new Date(firstEnd.getTime() - 30 * DAY),
      firstEnd,
      'RKD-SUB-B3T-000001',
    );
    const renewal = await open(
      businessId,
      'renewal',
      'chat',
      firstEnd,
      new Date(firstEnd.getTime() + 30 * DAY),
      'RKD-SUB-B3T-000002',
    );
    expect(await settle(businessId, renewal)).toBe('applied');
    const [renewed] = await ownerDb.execute<{ end: string }>(
      sql`SELECT plan_expires_at::text AS end FROM businesses WHERE id = ${businessId}::uuid`,
    );

    // A holder of the application credential resets both stale-charge markers.
    await withBusiness(appDb, businessId, async (tx) => {
      await tx.execute(
        sql`UPDATE businesses SET plan_decided_at = NULL WHERE id = ${businessId}::uuid`,
      );
      await tx.execute(
        sql`UPDATE subscription_charges SET superseded_at = NULL WHERE reference = ${upgrade}`,
      );
    });

    expect(await settle(businessId, upgrade)).toBe('superseded');
    const [after] = await ownerDb.execute<{
      plan: string;
      end: string;
      status: string;
      reason: string | null;
      applied: string | null;
    }>(sql`
      SELECT b.plan, b.plan_expires_at::text AS end, c.status, c.unapplied_reason AS reason,
             c.applied_period_end::text AS applied
      FROM businesses b JOIN subscription_charges c ON c.business_id = b.id
      WHERE b.id = ${businessId}::uuid AND c.reference = ${upgrade}`);
    expect(after).toEqual({
      plan: 'chat',
      end: renewed!.end,
      status: 'paid',
      reason: 'subscription_decided_after_charge',
      applied: null,
    });
  });
});
