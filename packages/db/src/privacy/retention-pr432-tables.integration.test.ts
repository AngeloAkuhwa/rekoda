/**
 * R10 (second independent review of PR #432): every tenant-owned table PR #432 adds is covered by
 * the retention deletion, with real rows in it, and nothing of another business is touched.
 *
 * The deletion (`retention_delete_business`, 0022, re-created through 0212) walks every table with
 * a `business_id` column under the target's pin and retries in foreign-key order, so a new table is
 * covered without being named. That is only true if no new foreign key or trigger blocks the walk;
 * this suite proves it with rows in each of the new tables, for two businesses, deleting one:
 *
 *   dead_job_exceptions (0194), staging_test_businesses / staging_tool_actions / staging_send_faults
 *   (0197), plan_change_reviews (0213), usage_reservations (0216), dead_job_enrolment_failures
 *   (0229), subscription_refunds and pack_credit_entitlements (0235).
 *
 * (A business that ever paid is never deleted by retention, so the refund and pack rows here hang
 * off a failed charge, which is the only charge an abandoned trial can hold; the deletion's foreign
 * key order is what is under test.) The singleton tables of the PR (`billing_pricing_source`,
 * `staging_environment`, `renewal_block_close_cursor`) carry no business id and are not tenant data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { identity, retentionRepo } from '../index.js';
import { migrate, requireUrls, setPlanAsOwner, truncateAll, type Urls } from '../testing.js';

const NEW_TENANT_TABLES = [
  'dead_job_exceptions',
  'dead_job_enrolment_failures',
  'plan_change_reviews',
  'staging_test_businesses',
  'staging_tool_actions',
  'staging_send_faults',
  'usage_reservations',
  'subscription_refunds',
  'pack_credit_entitlements',
] as const;

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
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

let seq = 0;
async function abandonedTrial(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481700000${String(seq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await setPlanAsOwner(urls, business.id, {
    planExpiresAt: new Date(Date.now() - 120 * 86_400_000),
  });
  return business.id;
}

/** One row in each new table for `businessId`, staged as the owner under its pin. */
async function populate(businessId: string): Promise<void> {
  seq += 1;
  const n = String(seq).padStart(5, '0');
  await withBusiness(ownerDb, businessId, async (tx) => {
    const [job] = await tx.execute<{ id: string }>(sql`
      INSERT INTO jobs (business_id, kind, payload, state, attempts, max_attempts)
      VALUES (${businessId}::uuid, 'payment.process', '{"eventId": null}'::jsonb, 'dead', 3, 3)
      RETURNING id`);
    const [other] = await tx.execute<{ id: string }>(sql`
      INSERT INTO jobs (business_id, kind, payload, state, attempts, max_attempts)
      VALUES (${businessId}::uuid, 'payment.process', '{"eventId": null}'::jsonb, 'dead', 3, 3)
      RETURNING id`);
    await tx.execute(sql`
      INSERT INTO dead_job_exceptions (job_id, business_id, kind, summary, attempts)
      VALUES (${job!.id}::uuid, ${businessId}::uuid, 'payment.process', 'stopped', 3)`);
    await tx.execute(sql`
      INSERT INTO dead_job_enrolment_failures (job_id, business_id, attempts, requeued_by)
      VALUES (${other!.id}::uuid, ${businessId}::uuid, 2, 'operator:ada')`);
    await tx.execute(sql`
      INSERT INTO plan_change_reviews (business_id, from_plan, to_plan, paid_through)
      VALUES (${businessId}::uuid, 'chat', 'complete', now() - interval '100 days')`);
    await tx.execute(sql`
      INSERT INTO staging_test_businesses (business_id, designated_by, reason)
      VALUES (${businessId}::uuid, 'operator:ada', 'acceptance walkthrough')`);
    await tx.execute(sql`
      INSERT INTO staging_tool_actions (business_id, operator, action, reason, outcome)
      VALUES (${businessId}::uuid, 'operator:ada', 'designate', 'acceptance walkthrough', 'done')`);
    await tx.execute(sql`
      INSERT INTO staging_send_faults (business_id, kind, armed_by)
      VALUES (${businessId}::uuid, 'send_timeout', 'operator:ada')`);
    await tx.execute(sql`
      INSERT INTO usage_reservations (business_id, period, unit, quantity)
      VALUES (${businessId}::uuid, 'TRIAL00', 'AI_ACTIONS', 1)`);
    const [charge] = await tx.execute<{ id: string }>(sql`
      INSERT INTO subscription_charges
        (business_id, kind, pack_id, quantity, amount_k, status, reference, period_start,
         period_end, pricing_source, billing_interval, failed_at, failure_reason, created_at)
      VALUES (${businessId}::uuid, 'add_on', 'messages_100', 1, 250000, 'failed',
              ${`RKD-PACK-20260701-T${n}`}, now() - interval '130 days', now() - interval '100 days',
              'catalogue', 'monthly', now() - interval '129 days', 'declined',
              now() - interval '130 days')
      RETURNING id`);
    await tx.execute(sql`
      INSERT INTO subscription_refunds
        (business_id, charge_id, provider_refund_id, amount_k, reason, actor)
      VALUES (${businessId}::uuid, ${charge!.id}::uuid, ${`rf-retention-${n}`}, 1000,
              'duplicate_charge', 'operator:ada')`);
    await tx.execute(sql`
      INSERT INTO pack_credit_entitlements (charge_id, business_id, unit, period, entitlement)
      VALUES (${charge!.id}::uuid, ${businessId}::uuid, 'AI_ACTIONS', 'TRIAL00', 50)`);
  });
}

const counts = async (businessId: string): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const table of NEW_TENANT_TABLES) {
    const [row] = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE business_id = ${businessId}::uuid`,
    );
    out[table] = row!.n;
  }
  return out;
};

describe('R10: retention deletes every PR #432 tenant table, and only the target’s rows', () => {
  it('the list above is every new table with a business id', async () => {
    const rows = await ownerDb.execute<{ table_name: string }>(sql`
      SELECT c.table_name::text AS table_name FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name = 'business_id'
        AND c.table_name IN (SELECT tag FROM (VALUES ${sql.join(
          NEW_TENANT_TABLES.map((t) => sql`(${t})`),
          sql`, `,
        )}) v(tag))`);
    expect([...rows].map((r) => r.table_name).sort()).toEqual([...NEW_TENANT_TABLES].sort());
  });

  it('a due business with rows in every new table is deleted completely; its neighbour is untouched', async () => {
    const target = await abandonedTrial();
    const neighbour = await abandonedTrial();
    await populate(target);
    await populate(neighbour);
    const all = Object.fromEntries(NEW_TENANT_TABLES.map((t) => [t, 1]));
    expect(await counts(target)).toEqual(all);
    expect(await counts(neighbour)).toEqual(all);

    await withBusiness(ownerDb, target, (tx) =>
      retentionRepo.claimRetentionNotice(tx, target, new Date(Date.now() - 40 * 86_400_000)),
    );
    const removed = await retentionRepo.deleteForRetention(
      workerDb,
      target,
      new Date(Date.now() - 90 * 86_400_000),
    );
    expect(removed).toBeGreaterThan(0);

    expect(await counts(target)).toEqual(Object.fromEntries(NEW_TENANT_TABLES.map((t) => [t, 0])));
    const [business] = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM businesses WHERE id = ${target}::uuid`,
    );
    expect(business!.n).toBe(0);
    expect(await counts(neighbour)).toEqual(all);
  });
});
