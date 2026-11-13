/**
 * Shared harness of the OD-37 boundary suites (plan-principals and plan-writer-boundary): a live
 * pool per principal (`rekoda_app`, `rekoda_worker`, `rekoda_settlement`, `rekoda_billing_operator`,
 * and the owner for reading back), businesses created by signup, and charges written by their real
 * writer (pending by the application, anything carrying a payment by settlement).
 */
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { identity } from '../index.js';
import { migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

export let urls: Urls;
export let appDb: Db;
export let workerDb: Db;
export let ownerDb: Db;
export let settlementDb: Db;
export let operatorDb: Db;
const closers: Array<() => Promise<void>> = [];

/** Registers the suite's hooks: one pool per principal, migrated, truncated before each test. */
export function usePlanWriterHarness(): void {
  beforeAll(async () => {
    urls = requireUrls();
    await migrate(urls);
    for (const [url, set] of [
      [urls.app, (d: Db) => (appDb = d)],
      [urls.worker, (d: Db) => (workerDb = d)],
      [urls.owner, (d: Db) => (ownerDb = d)],
      [urls.settlement, (d: Db) => (settlementDb = d)],
      [urls.operator, (d: Db) => (operatorDb = d)],
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
}

let phoneSeq = 0;
export async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23480600000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** The Developer API Starter, held from yesterday (written as the owner; settlement writes it in
 * production). It is what sells API requests and webhook deliveries (25,000 a month each), which
 * the database's own ceiling counts since migration 0222. */
export async function holdApiStarter(businessId: string): Promise<void> {
  await ownerDb.execute(sql`INSERT INTO business_add_ons (business_id, add_on_id, version, started_at)
                            VALUES (${businessId}::uuid, 'developer_api_starter', 1,
                                    now() - interval '1 day')`);
}

/** The Postgres error behind drizzle's wrapper, or 'allowed'. */
export const outcome = (run: Promise<unknown>) =>
  run.then(
    () => 'allowed',
    (error: { cause?: { message?: string; code?: string } }) =>
      `${error.cause?.code ?? ''} ${error.cause?.message ?? String(error)}`,
  );

export const planOf = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{
      plan: string;
      plan_expires_at: string | null;
      trial_started_at: string;
    }>(
      sql`SELECT plan, plan_expires_at, trial_started_at FROM businesses WHERE id = ${businessId}::uuid`,
    )),
  ][0];

export const FUTURE = new Date(Date.now() + 25 * 86_400_000);
export const PRINCIPALS = {
  app: () => appDb,
  worker: () => workerDb,
  settlement: () => settlementDb,
  operator: () => operatorDb,
};
export type Principal = keyof typeof PRINCIPALS;

export interface ChargeSpec {
  plan?: string | null;
  kind?: string;
  status?: string;
  applied?: boolean;
  unapplied?: boolean;
  superseded?: boolean;
  interval?: 'monthly' | 'annual';
}

let chargeSeq = 0;
/** A subscription charge in any state, written as the table owner: a fixture. No runtime role
 * inserts a charge that already carries a payment (the application opens pending ones, and
 * settlement settles them but opens none, 0217). */
export async function seedCharge(businessId: string, spec: ChargeSpec = {}): Promise<string> {
  chargeSeq += 1;
  const reference = `RKD-SUB-OD37-${String(chargeSeq).padStart(6, '0')}`;
  const kind = spec.kind ?? 'first_purchase';
  const plan = spec.plan === undefined ? 'chat' : spec.plan;
  const status = spec.status ?? 'paid';
  await ownerDb.execute(sql`
      INSERT INTO subscription_charges
        (business_id, kind, plan, pack_id, amount_k, status, reference, period_start, period_end,
         paid_at, applied_period_start, applied_period_end, unapplied_at, unapplied_reason,
         superseded_at, billing_interval)
      VALUES (${businessId}::uuid, ${kind}, ${plan},
        ${kind === 'add_on' ? 'whatsapp_500' : null}, 1000, ${status}, ${reference},
        now(), now() + interval '30 days',
        ${status === 'paid' ? sql`now()` : sql`NULL`},
        ${spec.applied ? sql`now()` : sql`NULL`}, ${spec.applied ? sql`now() + interval '30 days'` : sql`NULL`},
        ${spec.unapplied ? sql`now()` : sql`NULL`}, ${spec.unapplied ? 'cycle_ended' : null},
        ${spec.superseded ? sql`now()` : sql`NULL`}, ${spec.interval ?? 'monthly'})`);
  return reference;
}

/** The database's own bound for one interval from now (Lagos calendar months), read as the owner. */
export async function dbBound(interval: 'monthly' | 'annual'): Promise<Date> {
  const [row] = await ownerDb.execute<{ at: string }>(
    sql`SELECT rekoda_private.add_billing_interval(clock_timestamp(), ${interval})::text AS at`,
  );
  return new Date(row!.at);
}
