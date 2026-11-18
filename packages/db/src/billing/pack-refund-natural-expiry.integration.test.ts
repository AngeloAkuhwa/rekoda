/**
 * A pack refund across an allowance that changes by TIME, with no write (owner instruction, 18 Nov
 * 2026, "natural allowance expiry during a refund"; `docs/audits/pr-432/final-closeout-g.md` §2).
 *
 * `usage_entitlement` (0222) reads three things against `now()`: a trial's `plan_expires_at`, the
 * catalogue version in force (when the business's pin does not choose one), and the add-on holdings
 * active at that instant (`started_at`, `ends_at`). None of them is a write when it passes, so the
 * allowance history (0240, 0241) records nothing. Two ways a spent pack could then pass as unused:
 *   1. the refund's `now()` is its transaction's start. A refund that began before an expiry and
 *      waited (here, for the charge row) judges the allowance as it was then, while consumption
 *      that started after the expiry metered against the lower allowance and spent pack units;
 *   2. the allowance dips and comes back by time alone (a holding ends, the next one starts later):
 *      the allowance is equal at the credit and at the refund, so the equality check passes.
 * Each case below forces its order with separate connections: a third connection holds the charge
 * row, the refund is observed blocked on it in `pg_stat_activity` with a transaction that started
 * before the expiry, the database's own clock is waited past the boundary, and the consumption
 * commits before the lock is released. The boundaries are a few seconds ahead of the database clock,
 * read from the database, so nothing depends on the test runner's clock or on scheduling.
 *
 * RED at 0243: cases 1 to 3 recorded a full refund and revoked the units of a pack that had paid for
 * the consumption. Since 0244 the refund refuses (for the owner, OD-55) whenever any of those time
 * boundaries falls between the credit and the moment it holds the counter.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import {
  appDb,
  ownerDb,
  seedBusiness,
  settlementDb,
  urls,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const ACTOR = 'operator:ada@rekoda.test';
const OD55 = /needs an owner decision \(OD-55\)/;
/** The two packs used here, at the catalogue's figures (`usage_packs`). */
const API_PACK = { id: 'api_requests_25k', unit: 'API_REQUEST_UNITS', units: 25_000, k: 1_000_000 };
const AI_PACK = { id: 'messages_100', unit: 'AI_ACTIONS', units: 100, k: 250_000 };
type Pack = typeof API_PACK;

type Client = ReturnType<typeof postgres>;
const clients: Client[] = [];
function connect(url: string, name: string): Client {
  const client = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: name },
  });
  clients.push(client);
  return client;
}
let owner: Client;
beforeAll(() => {
  owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
  clients.push(owner);
});
afterAll(async () => {
  for (const client of clients) await client.end();
});

/** An instant `seconds` ahead of the DATABASE clock. */
async function dbClockPlus(seconds: number): Promise<Date> {
  const [r] = await owner<{ at: Date }[]>`
    SELECT clock_timestamp() + make_interval(secs => ${seconds}) AS at`;
  return r!.at;
}
/** Wait (bounded) until the database clock is past `at`. */
async function untilDbClockPast(at: Date): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const [r] = await owner<{ past: boolean }[]>`SELECT clock_timestamp() > ${at} AS past`;
    if (r!.past) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the database clock never passed ${at.toISOString()}`);
}
/** Wait until `name` is blocked on a lock; returns when its transaction started. */
async function blockedOnLock(name: string): Promise<Date> {
  for (let i = 0; i < 200; i += 1) {
    const rows = await owner<{ wait: string | null; started: Date }[]>`
      SELECT wait_event_type AS wait, xact_start AS started
      FROM pg_stat_activity WHERE application_name = ${name}`;
    if (rows[0]?.wait === 'Lock') return rows[0].started;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${name} never blocked on a lock`);
}
const month = async () => {
  const [r] = await owner<{ m: string }[]>`
    SELECT to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYY-MM') AS m`;
  return r!.m;
};

let seq = 0;
/** A paid pack charge, credited by settlement through usage_credit_pack on `period`. */
async function creditPack(businessId: string, pack: Pack, period: string): Promise<string> {
  seq += 1;
  const reference = `RKD-PACK-20261118-N${String(seq).padStart(5, '0')}`;
  await ownerDb.execute(sql`
    INSERT INTO subscription_charges
      (business_id, kind, plan, pack_id, quantity, amount_k, paid_amount_k, status, reference,
       period_start, period_end, paid_at, pricing_source, billing_interval)
    VALUES (${businessId}::uuid, 'add_on', NULL, ${pack.id}, 1, ${pack.k}, ${pack.k}, 'paid',
            ${reference}, now(), now() + interval '30 days', now(), 'catalogue', 'monthly')`);
  await withBusiness(settlementDb, businessId, (tx) =>
    tx.execute(
      sql`SELECT usage_credit_pack(${businessId}::uuid, ${reference}, ${period}, ${pack.unit}, ${pack.units}::int)`,
    ),
  );
  return reference;
}
async function chatBusiness(): Promise<string> {
  const businessId = await seedBusiness();
  await withBusiness(appDb, businessId, (tx) =>
    tx.execute(
      sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'chat', now() + interval '25 days')`,
    ),
  );
  return businessId;
}
/** A Developer API Starter holding (25,000 API requests a month), written as the owner as
 * settlement would (no runtime role writes one, 0226), from `from` to `to`. */
const holdStarter = (businessId: string, from: Date | null, to: Date | null) =>
  owner`INSERT INTO business_add_ons (business_id, add_on_id, version, started_at, ends_at)
        VALUES (${businessId}, 'developer_api_starter', 1,
                coalesce(${from}::timestamptz, now() - interval '1 day'), ${to}::timestamptz)`;

/** Consumption on the application's credential, in its own transaction, committed. */
async function consume(businessId: string, unit: string, period: string, n: number) {
  return connect(urls.app, `nx-consumer-${seq}-${n}`).begin(async (tx) => {
    await tx`SELECT set_config('app.business_id', ${businessId}, true)`;
    const [r] = await tx`SELECT * FROM usage_reserve(${businessId}::uuid, ${period}, ${unit},
                                1000000, ${n}, false)`;
    return r!['granted'] as boolean;
  });
}

/** The refund on its own operator connection; resolves to 'refunded' or the refusal. */
const refundOn = (client: Client, businessId: string, reference: string, amountK: number) =>
  client
    .begin(async (tx) => {
      await tx`SELECT set_config('app.business_id', ${businessId}, true)`;
      await tx`SELECT * FROM subscription_record_refund(${businessId}::uuid, ${reference},
                 ${amountK}::bigint, 'unused_add_on', ${ACTOR}, ${`rf-nx-${seq}-${Date.now()}`})`;
    })
    .then(
      () => 'refunded',
      (error: { message?: string }) => String(error.message),
    );

/** Hold the charge row on the owner's connection until `release()`. */
function holdCharge(reference: string, name: string) {
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = new Promise<void>((resolve) => (ready = resolve));
  const done = connect(urls.owner, name).begin(async (tx) => {
    await tx`SELECT id FROM subscription_charges WHERE reference = ${reference} FOR UPDATE`;
    ready();
    await gate;
  });
  return { held, release, done };
}

async function facts(businessId: string, reference: string, unit: string) {
  const [charge] = await owner`
    SELECT status, refunded_amount_k::bigint AS refunded, units_revoked_at IS NOT NULL AS revoked
    FROM subscription_charges WHERE reference = ${reference}`;
  const [counter] = await owner`
    SELECT used, bonus FROM usage_counters
    WHERE business_id = ${businessId} AND unit = ${unit} ORDER BY period DESC LIMIT 1`;
  const [refunds] = await owner`
    SELECT count(*)::int AS n FROM subscription_refunds r JOIN subscription_charges c ON c.id = r.charge_id
    WHERE c.reference = ${reference}`;
  const [audit] = await owner`
    SELECT count(*)::int AS n FROM audit_events
    WHERE entity = 'subscription_charge' AND entity_id = ${reference} AND action = 'refunded'`;
  return {
    status: charge!['status'] as string,
    refunded: Number(charge!['refunded']),
    revoked: charge!['revoked'] as boolean,
    used: counter!['used'] as number,
    bonus: counter!['bonus'] as number,
    refundRows: refunds!['n'] as number,
    auditRows: audit!['n'] as number,
  };
}
const untouched = (pack: Pack, used: number) => ({
  status: 'paid',
  refunded: 0,
  revoked: false,
  used,
  bonus: pack.units,
  refundRows: 0,
  auditRows: 0,
});

/** The shared order: the refund starts before `boundary`, waits on the charge, the boundary passes,
 * `n` units are consumed after it and commit, then the refund is let go. */
async function refundAcrossBoundary(input: {
  businessId: string;
  reference: string;
  pack: Pack;
  period: string;
  boundary: Date;
  n: number;
  name: string;
}): Promise<string> {
  const blocker = holdCharge(input.reference, `${input.name}-charge-holder`);
  await blocker.held;
  const refunding = refundOn(
    connect(urls.operator, input.name),
    input.businessId,
    input.reference,
    input.pack.k,
  );
  const refundStarted = await blockedOnLock(input.name);
  expect(refundStarted.getTime()).toBeLessThan(input.boundary.getTime()); // its now() is before
  await untilDbClockPast(input.boundary);
  /* Metered after the boundary: the lower allowance, so these units are the pack's. */
  expect(await consume(input.businessId, input.pack.unit, input.period, input.n)).toBe(true);
  blocker.release();
  await blocker.done;
  return refunding;
}

describe('a pack refund across an allowance that changes by time alone', () => {
  it('a holding that ends while the refund waits: the pack that paid for the consumption is not refunded', async () => {
    const businessId = await chatBusiness();
    const endsAt = await dbClockPlus(3);
    await holdStarter(businessId, null, endsAt); // a cancellation taking effect at endsAt
    const period = await month();
    const reference = await creditPack(businessId, API_PACK, period); // beside 25,000 a month
    const outcome = await refundAcrossBoundary({
      businessId,
      reference,
      pack: API_PACK,
      period,
      boundary: endsAt,
      n: 10, // after endsAt the plan sells no API requests: all 10 are the pack's
      name: 'nx-refund-holding',
    });
    expect(outcome).toMatch(OD55);
    expect(await facts(businessId, reference, API_PACK.unit)).toEqual(untouched(API_PACK, 10));
  });

  it('a trial that expires while the refund waits: the pack that paid for the consumption is not refunded', async () => {
    const businessId = await seedBusiness();
    const expiresAt = await dbClockPlus(3);
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(
        sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'trial', ${expiresAt.toISOString()}::timestamptz)`,
      ),
    );
    const reference = await creditPack(businessId, AI_PACK, 'TRIAL00'); // beside the trial's 50
    const outcome = await refundAcrossBoundary({
      businessId,
      reference,
      pack: AI_PACK,
      period: 'TRIAL00',
      boundary: expiresAt,
      n: 10, // an expired trial sells nothing: all 10 are the pack's
      name: 'nx-refund-trial',
    });
    expect(outcome).toMatch(OD55);
    expect(await facts(businessId, reference, AI_PACK.unit)).toEqual(untouched(AI_PACK, 10));
  });

  it('an allowance that dips and comes back by time alone: equal at both ends is not unchanged', async () => {
    const businessId = await chatBusiness();
    const endsAt = await dbClockPlus(2);
    const resumesAt = await dbClockPlus(4);
    await holdStarter(businessId, null, endsAt); // ends, and a second holding starts 2 s later
    await holdStarter(businessId, resumesAt, null);
    const period = await month();
    const reference = await creditPack(businessId, API_PACK, period);
    await untilDbClockPast(endsAt);
    expect(await consume(businessId, API_PACK.unit, period, 10)).toBe(true); // in the dip
    await untilDbClockPast(resumesAt);
    /* No refund waited: it starts after the dip, with the allowance back where it was. */
    const outcome = await refundOn(
      connect(urls.operator, 'nx-refund-dip'),
      businessId,
      reference,
      API_PACK.k,
    );
    expect(outcome).toMatch(OD55);
    expect(await facts(businessId, reference, API_PACK.unit)).toEqual(untouched(API_PACK, 10));
  });

  it('a boundary that passed before the credit changes nothing: an unused pack is still refunded', async () => {
    const businessId = await chatBusiness();
    const endsAt = await dbClockPlus(1);
    await holdStarter(businessId, null, endsAt);
    await untilDbClockPast(endsAt);
    const period = await month();
    const reference = await creditPack(businessId, API_PACK, period); // beside 0, after the end
    expect(
      await refundOn(connect(urls.operator, 'nx-refund-before'), businessId, reference, API_PACK.k),
    ).toBe('refunded');
    expect(await facts(businessId, reference, API_PACK.unit)).toEqual({
      status: 'refunded',
      refunded: API_PACK.k,
      revoked: true,
      used: 0,
      bonus: 0,
      refundRows: 1,
      auditRows: 1,
    });
  });

  it('a holding that ends after the refund holds the counter is ordered after it: refunded once', async () => {
    const businessId = await chatBusiness();
    const endsAt = await dbClockPlus(3);
    await holdStarter(businessId, null, endsAt);
    const period = await month();
    const reference = await creditPack(businessId, API_PACK, period);
    expect(
      await refundOn(connect(urls.operator, 'nx-refund-early'), businessId, reference, API_PACK.k),
    ).toBe('refunded');
    await untilDbClockPast(endsAt);
    /* The pack is gone and the plan sells none: nothing more can be metered. */
    expect(await consume(businessId, API_PACK.unit, period, 1)).toBe(false);
    expect(await facts(businessId, reference, API_PACK.unit)).toMatchObject({
      status: 'refunded',
      revoked: true,
      bonus: 0,
      used: 0,
      refundRows: 1,
    });
  });
});

/* The catalogue's own boundary. A version of a plan that takes effect (or ends) by date changes the
 * allowance of a business whose pin does not choose a version of that plan, with no business write.
 * It is checked through the boundary function directly, inside a transaction that is rolled back,
 * because a committed catalogue row would change every other suite's allowances. */
describe('the catalogue boundary (rekoda_private.pack_allowance_boundary_between)', () => {
  const rollback = new Error('rolled back');
  async function inRolledBack<T>(body: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let result!: T;
    await owner
      .begin(async (tx) => {
        result = await body(tx);
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    return result;
  }
  const crossed = (tx: postgres.TransactionSql, businessId: string, from: Date, to: Date) =>
    tx<{ crossed: boolean }[]>`
      SELECT rekoda_private.pack_allowance_boundary_between(
        ${businessId}::uuid, 'AI_ACTIONS', ${from}::timestamptz, ${to}::timestamptz) AS crossed`.then(
      (rows) => rows[0]!.crossed,
    );

  it('a version ending in the window is a boundary for an unpinned business, not for a pinned one', async () => {
    const businessId = await seedBusiness(); // on the trial, no pin
    const from = await dbClockPlus(-60);
    const to = await dbClockPlus(60);
    const result = await inRolledBack(async (tx) => {
      await tx`SELECT set_config('app.business_id', ${businessId}, true)`;
      const before = await crossed(tx, businessId, from, to);
      await tx`
        UPDATE plan_versions SET effective_to = clock_timestamp()
        WHERE plan_id = 'trial' AND effective_to IS NULL`; // one open version per plan: end it
      const unpinned = await crossed(tx, businessId, from, to);
      await tx`UPDATE businesses SET plan_version_id =
                 (SELECT id FROM plan_versions WHERE plan_id = 'trial' ORDER BY version LIMIT 1)
               WHERE id = ${businessId}`;
      const pinned = await crossed(tx, businessId, from, to);
      return { before, unpinned, pinned };
    });
    expect(result).toEqual({ before: false, unpinned: true, pinned: false });
  });
});
