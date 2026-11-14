/**
 * Migration safety for the whole of PR B (0193 to 0224): an UPGRADE of the database `main` leaves
 * behind, which is what the staging deploy actually applies.
 *
 * `upgrade-od51.integration.test.ts` starts from 0212, the last PR B migration before OWN-91. `main`
 * itself stops at 0192, so the staging database will take 0193 to 0224 in one stopped window. This
 * suite migrates a scratch database to 0192, seeds it as that release would have left it (a paying
 * business, a settled plan charge, a credited pack, an open pack checkout, a consumed meter, a
 * Paystack event, a settlement job and a general job still queued), then migrates forward. The
 * rules it holds:
 *
 *   - history is not rewritten: every column the 0192 release wrote reads back exactly as it was on
 *     every seeded charge, the business, the meter, the event and the jobs, and no audit row is
 *     invented (columns the new migrations add are not part of that history);
 *   - the new boundary arrives: settlement is not the application, the worker and the application
 *     cannot write a meter or a plan field directly;
 *   - work in flight survives: the queued settlement job is claimed by the settlement role, the
 *     general job by the worker, and the meter keeps counting through the new functions;
 *   - the deploy's pre-start smoke passes on the upgraded database.
 *
 * Roles are cluster-wide; `afterAll` re-applies every migration so no later suite sees an older
 * boundary, as the 0212 suite does.
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

const LAST_ON_MAIN = 192;
const SCRATCH = `rekoda_upgrade_main_${process.pid}`;
const SMOKE = /^SMOKE_0196_SQL="([\s\S]*?)"$/m.exec(
  readFileSync(new URL('../../../../scripts/deploy-staging.sh', import.meta.url), 'utf8'),
)?.[1];

let urls: Urls;
let admin: ReturnType<typeof postgres>;
let owner: ReturnType<typeof postgres>;
let oldMigrations: string;
let businessId: string;
let before: Snapshot;
let pending: string[];
const closers: Array<() => Promise<void>> = [];

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

type Doc = Record<string, unknown>;
interface Snapshot {
  charges: Doc[];
  business: Doc[];
  counters: Doc[];
  jobs: Doc[];
  events: Doc[];
  audits: number;
}
async function snapshot(): Promise<Snapshot> {
  const rows = async (query: string): Promise<Doc[]> =>
    (await owner.unsafe(query)).map((row) => row['doc'] as Doc);
  return {
    charges: await rows(`SELECT to_jsonb(c) AS doc FROM subscription_charges c ORDER BY reference`),
    business: await rows(`SELECT to_jsonb(b) AS doc FROM businesses b`),
    counters: await rows(`SELECT to_jsonb(u) AS doc FROM usage_counters u ORDER BY unit`),
    jobs: await rows(`SELECT to_jsonb(j) AS doc FROM jobs j ORDER BY kind`),
    events: await rows(`SELECT to_jsonb(e) AS doc FROM external_events e ORDER BY external_id`),
    audits: Number((await owner`SELECT count(*)::int AS n FROM audit_events`)[0]!['n']),
  };
}
/** The later rows cut down to the columns the earlier rows had: what the old release wrote. */
const asWritten = (later: Doc[], earlier: Doc[]): Doc[] =>
  later.map((row, i) =>
    Object.fromEntries(Object.keys(earlier[i] ?? {}).map((key) => [key, row[key]])),
  );

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  admin = postgres(urls.owner, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.unsafe(`CREATE DATABASE ${SCRATCH}`);

  /* The migrations `main` carries: the same files, with the journal cut at 0192. */
  oldMigrations = mkdtempSync(join(tmpdir(), 'rekoda-upgrade-main-'));
  mkdirSync(join(oldMigrations, 'meta'));
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const kept = journal.entries.filter((entry) => entry.idx <= LAST_ON_MAIN);
  pending = journal.entries.filter((entry) => entry.idx > LAST_ON_MAIN).map((entry) => entry.tag);
  for (const entry of kept) {
    cpSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(oldMigrations, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }),
  );
  await applyMigrations(scratchUrl(urls.owner), oldMigrations);
  owner = postgres(scratchUrl(urls.owner), { max: 1, onnotice: () => {} });

  /* What the 0192 release left behind, written as the owner so no current code is involved. */
  const [user] = await owner`INSERT INTO users (phone) VALUES ('+2348150000002') RETURNING id`;
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
       billing_interval, created_at)
    VALUES (${businessId}, 'first_purchase', 'chat', 990000, 'RKD-SUB-20261101-MAINUP', 'paid',
            'ps_main_plan', now() - interval '10 days', 990000, now() - interval '10 days',
            now() + interval '20 days', now() - interval '10 days', now() + interval '20 days',
            'monthly', now() - interval '10 days')`;
  await owner`
    INSERT INTO subscription_charges
      (business_id, kind, pack_id, quantity, amount_k, reference, status, provider_reference,
       paid_at, paid_amount_k, created_at)
    VALUES (${businessId}, 'add_on', 'messages_100', 1, 250000, 'RKD-ADD-20261105-MAINCR', 'paid',
            'ps_main_pack', now() - interval '5 days', 250000, now() - interval '5 days')`;
  await owner`
    INSERT INTO subscription_charges (business_id, kind, pack_id, quantity, amount_k, reference)
    VALUES (${businessId}, 'add_on', 'messages_100', 1, 250000, 'RKD-ADD-20261111-MAINOP')`;
  await owner`
    INSERT INTO usage_counters (business_id, period, unit, used, bonus)
    VALUES (${businessId}, to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYY-MM'), 'AI_ACTIONS', 5, 100)`;
  await owner`
    INSERT INTO external_events (business_id, provider, event_type, external_id, payload, signature_valid)
    VALUES (${businessId}, 'paystack', 'charge.success', '9200001:charge.success', '{}'::jsonb, 1)`;
  await owner`
    INSERT INTO jobs (business_id, kind, payload)
    VALUES (${businessId}, 'billing.process', '{"eventId":"00000000-0000-4000-8000-000000000002"}'::jsonb),
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

describe('upgrading the database main leaves (0192) through 0224', () => {
  it('starts at 0192 with the release seeded', () => {
    expect(pending[0]).toBe('0193_charge_provider_times');
    expect(pending.at(-1)).toBe('0224_pack_credit_derives_from_the_charge');
    expect(before.charges).toHaveLength(3);
    expect(before.charges[0]).not.toHaveProperty('provider_paid_at');
  });

  it('applies 0193 to 0224 in order and rewrites no column the old release wrote', async () => {
    const applied = await applyMigrations(scratchUrl(urls.owner));
    expect(applied).toEqual(pending);

    const after = await snapshot();
    expect(asWritten(after.charges, before.charges)).toEqual(before.charges);
    expect(asWritten(after.business, before.business)).toEqual(before.business);
    expect(asWritten(after.counters, before.counters)).toEqual(before.counters);
    expect(asWritten(after.jobs, before.jobs)).toEqual(before.jobs);
    expect(asWritten(after.events, before.events)).toEqual(before.events);
    expect(after.audits).toBe(before.audits);
    /* OD-40: no Paystack time is guessed for a charge paid before 0193. */
    const times = await owner`
      SELECT count(provider_paid_at)::int AS provider_times FROM subscription_charges`;
    expect(times[0]).toMatchObject({ provider_times: 0 });
  });

  it('arrives at the new boundary', async () => {
    const rows = await owner`
      SELECT
        pg_has_role('rekoda_settlement', 'rekoda_app', 'MEMBER') AS settlement_is_app,
        has_table_privilege('rekoda_worker', 'public.usage_counters', 'UPDATE') AS worker_writes_meters,
        has_table_privilege('rekoda_app', 'public.usage_counters', 'UPDATE') AS app_writes_meters`;
    expect(rows[0]).toEqual({
      settlement_is_app: false,
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

    const general = await jobsRepo.claimNext(worker, 'worker:upgrade-main');
    expect(general?.kind).toBe('message.inbound');
    expect(await jobsRepo.claimNext(worker, 'worker:upgrade-main')).toBeNull();

    const settling = await jobsRepo.claimNext(settlement, 'settlement:upgrade-main');
    expect(settling?.kind).toBe('billing.process');
    expect(await jobsRepo.claimNext(settlement, 'settlement:upgrade-main')).toBeNull();
  });

  it('keeps counting on a meter the old release wrote, and refuses the old direct writes', async () => {
    const app = scratchDb(urls.app);
    const period = String(
      (await owner`SELECT period FROM usage_counters WHERE business_id = ${businessId}`)[0]![
        'period'
      ],
    );
    /* Plan allowance 3, already past it at 5; the 100 bought units admit the next one. */
    const granted = await withBusiness(app, businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, period, 'AI_ACTIONS', 3),
    );
    expect(granted).toBe(true);
    const rows =
      await owner`SELECT used, bonus FROM usage_counters WHERE business_id = ${businessId}`;
    expect(rows[0]).toMatchObject({ used: 6, bonus: 100 });
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`UPDATE usage_counters SET used = 0 WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
    /* OD-37 (0196): the application no longer writes a plan field. */
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(
          sql`UPDATE businesses SET plan_expires_at = now() + interval '1 year' WHERE id = ${businessId}::uuid`,
        ),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/subscription writers|permission denied/) },
    });
    const plan = await owner`SELECT plan_expires_at FROM businesses WHERE id = ${businessId}`;
    expect(plan[0]!['plan_expires_at']).toEqual(
      new Date(String((before.business[0] as Doc)['plan_expires_at'])),
    );
  });
});
