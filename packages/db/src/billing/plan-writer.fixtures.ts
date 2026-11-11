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
/** A subscription charge, written as its real writer would: pending by the application, anything
 * carrying a payment by settlement (the only non-owner role allowed to, 0202). */
export async function seedCharge(businessId: string, spec: ChargeSpec = {}): Promise<string> {
  chargeSeq += 1;
  const reference = `RKD-SUB-OD37-${String(chargeSeq).padStart(6, '0')}`;
  const kind = spec.kind ?? 'first_purchase';
  const plan = spec.plan === undefined ? 'chat' : spec.plan;
  const status = spec.status ?? 'paid';
  const writer = settlementDb; // only settlement opens a charge (0205)
  const amountK = await catalogueAmountK(businessId, kind, plan, spec.interval ?? 'monthly');
  await withBusiness(writer, businessId, (tx) =>
    tx.execute(sql`
      INSERT INTO subscription_charges
        (business_id, kind, plan, pack_id, amount_k, status, reference, period_start, period_end,
         paid_at, applied_period_start, applied_period_end, unapplied_at, unapplied_reason,
         superseded_at, billing_interval)
      VALUES (${businessId}::uuid, ${kind}, ${plan},
        ${kind === 'add_on' ? FIXTURE_PACK : null}, ${amountK}, ${status}, ${reference},
        now(), now() + interval '30 days',
        ${status === 'paid' ? sql`now()` : sql`NULL`},
        ${spec.applied ? sql`now()` : sql`NULL`}, ${spec.applied ? sql`now() + interval '30 days'` : sql`NULL`},
        ${spec.unapplied ? sql`now()` : sql`NULL`}, ${spec.unapplied ? 'cycle_ended' : null},
        ${spec.superseded ? sql`now()` : sql`NULL`}, ${spec.interval ?? 'monthly'})`),
  );
  return reference;
}

/** A pack the catalogue sells (0106/0113). */
export const FIXTURE_PACK = 'messages_100';

/**
 * What a charge must cost to be opened at all (migration 0210's price check, read as the owner):
 * the catalogue price of the plan on the interval, the pack's price, or, for an upgrade from the
 * business's current plan, the prorated difference over a cycle running now to 30 days from now.
 */
export async function catalogueAmountK(
  businessId: string,
  kind: string,
  plan: string | null,
  interval: 'monthly' | 'annual' = 'monthly',
): Promise<number> {
  const [row] = await ownerDb.execute<{ k: string | null }>(sql`
    SELECT CASE
      WHEN ${kind} = 'add_on' THEN (SELECT price_minor FROM usage_packs
        WHERE pack_id = ${FIXTURE_PACK} AND effective_to IS NULL ORDER BY version DESC LIMIT 1)
      WHEN ${kind} = 'upgrade' THEN (
        SELECT floor((rekoda_private.plan_price_minor(${plan}, b.plan_version_id, 'monthly')
                      - rekoda_private.plan_price_minor(b.plan, b.plan_version_id, 'monthly')) * 29 / 30.0)
        FROM businesses b WHERE b.id = ${businessId}::uuid)
      ELSE (SELECT rekoda_private.plan_price_minor(${plan}, b.plan_version_id, ${interval})
            FROM businesses b WHERE b.id = ${businessId}::uuid)
    END::text AS k`);
  if (row?.k == null) throw new Error(`no catalogue price for a ${kind} charge on ${plan}`);
  return Number(row.k);
}

/** The database's own bound for one interval from now (Lagos calendar months), read as the owner. */
export async function dbBound(interval: 'monthly' | 'annual'): Promise<Date> {
  const [row] = await ownerDb.execute<{ at: string }>(
    sql`SELECT rekoda_private.add_billing_interval(clock_timestamp(), ${interval})::text AS at`,
  );
  return new Date(row!.at);
}
