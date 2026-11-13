/**
 * Migration safety for 0213 to 0223 (OD-50, OD-51): an UPGRADE of a database the previous release
 * left behind, not only a fresh build.
 *
 * A scratch database is migrated to 0212 (the last PR B migration before OWN-91; `main` itself
 * stops at 0192, and `upgrade-from-main.integration.test.ts` upgrades from there), seeded as that release would have
 * left it (a paying business, a settled plan charge, a credited pack, an open pack checkout, a
 * consumed meter, a settlement job and a general job still queued), then migrated forward. The
 * rules it holds:
 *
 *   - history is not rewritten: every seeded charge, the subscription, the meter, the events and
 *     the jobs read back exactly as they were, and no audit row is invented;
 *   - the boundary arrives: before, settlement acts as the application and the worker can write a
 *     meter and take a settlement job; after, none of that is true;
 *   - work in flight survives: the queued settlement job is claimed by the settlement role, the
 *     general job by the worker, and the meter keeps counting through the new functions;
 *   - the deploy's pre-start smoke passes on the upgraded database, and re-running the new
 *     migrations changes nothing.
 *
 * Roles are cluster-wide, so while the scratch database sits at 0212 the settlement role is, for
 * the whole cluster, a member of the application role again (0202). The forward migration removes
 * that, and `afterAll` finishes it whatever a test did, so no later suite sees the old boundary.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { jobsRepo, usageRepo } from '../index.js';
import { applyMigrations, MIGRATIONS_DIR } from '../migrate.js';
import { migrate, requireUrls, type Urls } from '../testing.js';

const LAST_ON_MAIN = 212;
const SCRATCH = `rekoda_upgrade_${process.pid}`;
const SMOKE = /^SMOKE_0196_SQL="([\s\S]*?)"$/m.exec(
  readFileSync(new URL('../../../../scripts/deploy-staging.sh', import.meta.url), 'utf8'),
)?.[1];

let urls: Urls;
let admin: ReturnType<typeof postgres>;
let owner: ReturnType<typeof postgres>;
let oldMigrations: string;
let businessId: string;
let before: Snapshot;
const closers: Array<() => Promise<void>> = [];

/** The same server and credentials, pointed at the scratch database. */
const scratchUrl = (url: string): string => {
  const u = new URL(url);
  u.pathname = `/${SCRATCH}`;
  return u.toString();
};
function scratchDb(url: string): Db {
  const made = createDb(scratchUrl(url), { max: 2 });
  closers.push(made.close);
  return made.db;
}

interface Snapshot {
  charges: unknown[];
  business: unknown;
  counters: unknown[];
  jobs: unknown[];
  events: unknown[];
  audits: number;
}
/** Everything the previous release wrote, as stored, without the columns 0214 and 0215 add. */
async function snapshot(): Promise<Snapshot> {
  const rows = async (query: string): Promise<unknown[]> =>
    (await owner.unsafe(query)).map((row) => row['doc'] as unknown);
  return {
    charges: await rows(`SELECT to_jsonb(c) - 'purchase_id' - 'pricing_source' AS doc
                         FROM subscription_charges c ORDER BY reference`),
    business: (await rows(`SELECT to_jsonb(b) AS doc FROM businesses b`))[0],
    counters: await rows(`SELECT to_jsonb(u) AS doc FROM usage_counters u ORDER BY unit`),
    jobs: await rows(`SELECT to_jsonb(j) AS doc FROM jobs j ORDER BY kind`),
    events: await rows(`SELECT to_jsonb(e) AS doc FROM external_events e ORDER BY external_id`),
    audits: Number((await owner`SELECT count(*)::int AS n FROM audit_events`)[0]!['n']),
  };
}

const facts = async (): Promise<Record<string, boolean>> =>
  (
    await owner`
      SELECT
        pg_has_role('rekoda_settlement', 'rekoda_app', 'MEMBER') AS settlement_is_app,
        has_table_privilege('rekoda_settlement', 'public.customers', 'SELECT') AS settlement_reads_customers,
        has_table_privilege('rekoda_settlement', 'public.subscription_charges', 'INSERT') AS settlement_opens_charges,
        has_table_privilege('rekoda_worker', 'public.usage_counters', 'UPDATE') AS worker_writes_meters,
        has_table_privilege('rekoda_app', 'public.usage_counters', 'UPDATE') AS app_writes_meters`
  )[0] as Record<string, boolean>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  admin = postgres(urls.owner, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.unsafe(`CREATE DATABASE ${SCRATCH}`);

  /* The migrations through 0212: the same files, with the journal cut there. */
  oldMigrations = mkdtempSync(join(tmpdir(), 'rekoda-upgrade-'));
  mkdirSync(join(oldMigrations, 'meta'));
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const kept = journal.entries.filter((entry) => entry.idx <= LAST_ON_MAIN);
  for (const entry of kept) {
    cpSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(oldMigrations, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }),
  );
  await applyMigrations(scratchUrl(urls.owner), oldMigrations);
  owner = postgres(scratchUrl(urls.owner), { max: 1, onnotice: () => {} });

  /* What the previous release left behind, written as the owner so no current code is involved. */
  const [user] = await owner`INSERT INTO users (phone) VALUES ('+2348150000001') RETURNING id`;
  const [business] = await owner`
    INSERT INTO businesses (name, owner_user_id) VALUES ('Ada Fashion', ${user!['id']})
    RETURNING id`;
  businessId = String(business!['id']);
  await owner`
    UPDATE businesses SET plan = 'chat', cycle_started_at = now() - interval '10 days',
      plan_expires_at = now() + interval '20 days', ever_paid_at = now() - interval '10 days',
      billing_interval = 'monthly', renewal_anchor_day = 1
    WHERE id = ${businessId}`;
  await owner`
    INSERT INTO subscription_charges
      (business_id, kind, plan, amount_k, reference, status, provider_reference, paid_at,
       paid_amount_k, period_start, period_end, applied_period_start, applied_period_end,
       billing_interval, priced_at, created_at)
    VALUES (${businessId}, 'first_purchase', 'chat', 990000, 'RKD-SUB-20261101-UPGRAD', 'paid',
            'ps_upgrade_plan', now() - interval '10 days', 990000, now() - interval '10 days',
            now() + interval '20 days', now() - interval '10 days', now() + interval '20 days',
            'monthly', now() - interval '10 days', now() - interval '10 days')`;
  await owner`
    INSERT INTO subscription_charges
      (business_id, kind, pack_id, quantity, amount_k, reference, status, provider_reference,
       paid_at, paid_amount_k, units_credited_at, priced_at, created_at)
    VALUES (${businessId}, 'add_on', 'messages_100', 1, 250000, 'RKD-ADD-20261105-CREDIT', 'paid',
            'ps_upgrade_pack', now() - interval '5 days', 250000, now() - interval '5 days',
            now() - interval '5 days', now() - interval '5 days')`;
  await owner`
    INSERT INTO subscription_charges
      (business_id, kind, pack_id, quantity, amount_k, reference, priced_at)
    VALUES (${businessId}, 'add_on', 'messages_100', 1, 250000, 'RKD-ADD-20261111-OPENED', now())`;
  await owner`
    INSERT INTO usage_counters (business_id, period, unit, used, bonus)
    VALUES (${businessId}, to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYY-MM'), 'AI_ACTIONS', 5, 100)`;
  await owner`
    INSERT INTO external_events (business_id, provider, event_type, external_id, payload, signature_valid)
    VALUES (${businessId}, 'paystack', 'charge.success', '9100001:charge.success', '{}'::jsonb, 1)`;
  await owner`
    INSERT INTO jobs (business_id, kind, payload)
    VALUES (${businessId}, 'billing.process', '{"eventId":"00000000-0000-4000-8000-000000000001"}'::jsonb),
           (${businessId}, 'message.inbound', '{}'::jsonb)`;
  before = await snapshot();
});

afterAll(async () => {
  for (const close of closers) await close();
  try {
    /* Whatever happened above, leave the cluster on the current boundary. */
    await applyMigrations(scratchUrl(urls.owner));
  } finally {
    await owner?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.end();
    rmSync(oldMigrations, { recursive: true, force: true });
  }
});

describe('upgrading a database from 0212 through 0223', () => {
  it('starts from the boundary the previous release had', async () => {
    expect(before.charges).toHaveLength(3);
    expect(await facts()).toEqual({
      settlement_is_app: true,
      settlement_reads_customers: true,
      settlement_opens_charges: true,
      worker_writes_meters: true,
      app_writes_meters: true,
    });
  });

  it('applies 0213 to 0223 and rewrites no history', async () => {
    const applied = await applyMigrations(scratchUrl(urls.owner));
    expect(applied).toEqual([
      '0213_support_review_plan_change',
      '0214_pack_purchase_identity',
      '0215_pricing_source_authority',
      '0216_usage_meter_boundary',
      '0217_settlement_isolation',
      '0218_usage_reservation_closure',
      '0219_support_review_respects_later_schedule',
      '0220_job_row_and_grace_review_fixes',
      '0221_operator_writes_only_through_its_functions',
      '0222_usage_entitlement_in_the_database',
      '0223_settlement_scope_and_dead_job_requeue',
    ]);

    const after = await snapshot();
    expect(after.charges).toEqual(before.charges);
    expect(after.business).toEqual(before.business);
    expect(after.counters).toEqual(before.counters);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.events).toEqual(before.events);
    expect(after.audits).toBe(before.audits);
    /* The new columns: every existing charge is its own purchase, priced under no recorded source. */
    const added = await owner`
      SELECT count(DISTINCT purchase_id)::int AS purchases, count(pricing_source)::int AS sourced
      FROM subscription_charges`;
    expect(added[0]).toMatchObject({ purchases: 3, sourced: 0 });
  });

  it('arrives at the new boundary', async () => {
    expect(await facts()).toEqual({
      settlement_is_app: false,
      settlement_reads_customers: false,
      settlement_opens_charges: false,
      worker_writes_meters: false,
      app_writes_meters: false,
    });
  });

  it('passes the pre-start smoke the deploy runs before starting the release', async () => {
    expect(SMOKE).toBeTruthy();
    const rows = await owner.unsafe(SMOKE!);
    expect(Object.values(rows[0]!)[0]).toBe(true);
  });

  it('keeps work in flight: the settlement job goes to settlement, the general job to the worker', async () => {
    const worker = scratchDb(urls.worker);
    const settlement = scratchDb(urls.settlement);

    const general = await jobsRepo.claimNext(worker, 'worker:upgrade');
    expect(general?.kind).toBe('message.inbound');
    expect(await jobsRepo.claimNext(worker, 'worker:upgrade')).toBeNull();

    const settling = await jobsRepo.claimNext(settlement, 'settlement:upgrade');
    expect(settling?.kind).toBe('billing.process');
    expect(await jobsRepo.claimNext(settlement, 'settlement:upgrade')).toBeNull();
  });

  it('keeps counting on a meter the previous release wrote, through the new functions', async () => {
    const app = scratchDb(urls.app);
    const period = String(
      (await owner`SELECT period FROM usage_counters WHERE business_id = ${businessId}`)[0]![
        'period'
      ],
    );
    /* Plan allowance 3, already past it at 5; the 100 bought units are what admit the next one. */
    const granted = await withBusiness(app, businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, period, 'AI_ACTIONS', 3),
    );
    expect(granted).toBe(true);
    const rows = await owner`
      SELECT used, bonus FROM usage_counters WHERE business_id = ${businessId}`;
    expect(rows[0]).toMatchObject({ used: 6, bonus: 100 });
    /* And a direct write, the previous release's way, is now refused. */
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`UPDATE usage_counters SET used = 0 WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
  });

  it('changes nothing when the new migrations are run again', async () => {
    const state = await snapshot();
    const boundary = await facts();
    for (const tag of [
      '0213_support_review_plan_change',
      '0214_pack_purchase_identity',
      '0215_pricing_source_authority',
      '0216_usage_meter_boundary',
      '0217_settlement_isolation',
      '0218_usage_reservation_closure',
      '0219_support_review_respects_later_schedule',
      '0220_job_row_and_grace_review_fixes',
      '0221_operator_writes_only_through_its_functions',
      '0222_usage_entitlement_in_the_database',
      '0223_settlement_scope_and_dead_job_requeue',
    ]) {
      await owner.unsafe(readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8')).simple();
    }
    const again = await snapshot();
    /* The meter moved in the test above and the jobs were claimed; compare like with like. */
    expect(again).toEqual(state);
    expect(await facts()).toEqual(boundary);
    const rows = await owner.unsafe(SMOKE!);
    expect(Object.values(rows[0]!)[0]).toBe(true);
  });
});
