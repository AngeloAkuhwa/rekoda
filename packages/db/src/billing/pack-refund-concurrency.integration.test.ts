/**
 * F-3 (owner instruction, 18 Nov 2026): the pack refund under concurrency, made deterministic.
 *
 * `subscription_record_refund` (0235, 0240, 0241) runs in READ COMMITTED, statement by statement:
 *   S1  lock the charge row (FOR UPDATE)
 *   S2  read the recorded allowance, `usage_entitlement` and the allowance history (no lock)
 *   S3  lock the period's usage counter row (FOR UPDATE) and read `used` and `bonus`
 *   S4  revoke the units, insert the refund row, mark the charge, write the audit row
 * Each statement takes a fresh snapshot. The final review recorded a theoretical race (F-3): a plan
 * change committing between S2 and S4. These tests force every interleaving the owner named with
 * separate connections: a third connection holds the exact row lock the refund needs next, the
 * refund is observed blocked on it in `pg_stat_activity`, the competing write commits, and only then
 * is the lock released. (Since 0243 S2 runs after S3's lock; the statement order above is 0240's.)
 *
 * What they establish (`docs/audits/pr-432/final-closeout-f.md` §4):
 *   - A plan or holding change that commits before the refund holds the counter is seen (0243 judges
 *     the allowance after the counter lock) and the refund goes to the owner (OD-55). Before 0243
 *     the allowance was judged before the lock, and review A of the closeout round showed a
 *     downgrade plus consumption spending the pack, both committing while the refund waited, let a
 *     spent pack be refunded: the RED case below.
 *   - One that commits after the refund has judged is ordered after it, and recorded in the history.
 *   - Consumption and the refund serialise on the counter row in both orders.
 *   - Two refunds of one pack serialise on the charge row; two packs on one counter serialise on the
 *     counter row, and the second reads the first's revocation. Every path takes the charge before
 *     the counter (refund, credit) or the counter alone (consumption), so there is no lock cycle.
 *   - A refund that rolls back leaves no refund row, no revocation and no charge change.
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

const PACK_K = 250_000; // messages_100, the catalogue's price
const UNITS = 100;
const ACTOR = 'operator:ada@rekoda.test';

type Client = ReturnType<typeof postgres>;
const clients: Client[] = [];
/** A dedicated single-connection client, named so its backend can be found in pg_stat_activity. */
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

let seq = 0;
async function thisMonth(): Promise<string> {
  const [r] = await ownerDb.execute<{ m: string }>(
    sql`SELECT to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYY-MM') AS m`,
  );
  return r!.m;
}
/** A paid pack charge for `businessId` (on Chat), credited through usage_credit_pack. */
async function creditPack(businessId: string): Promise<string> {
  seq += 1;
  const reference = `RKD-PACK-20261118-C${String(seq).padStart(5, '0')}`;
  await ownerDb.execute(sql`
    INSERT INTO subscription_charges
      (business_id, kind, plan, pack_id, quantity, amount_k, paid_amount_k, status, reference,
       period_start, period_end, paid_at, pricing_source, billing_interval)
    VALUES (${businessId}::uuid, 'add_on', NULL, 'messages_100', 1, ${PACK_K}, ${PACK_K}, 'paid',
            ${reference}, now(), now() + interval '30 days', now(), 'catalogue', 'monthly')`);
  const month = await thisMonth();
  await withBusiness(settlementDb, businessId, (tx) =>
    tx.execute(
      sql`SELECT usage_credit_pack(${businessId}::uuid, ${reference}, ${month}, 'AI_ACTIONS', ${UNITS}::int)`,
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

/** Arrange consumption (as the owner, under the pin `usage_entitlement` requires): the plan's
 * allowance used in full, plus `extra` units drawn from packs. */
const useAllowancePlus = (businessId: string, extra: number) =>
  owner.begin(async (tx) => {
    await tx`SELECT set_config('app.business_id', ${businessId}, true)`;
    await tx`
      UPDATE usage_counters
      SET used = public.usage_entitlement(${businessId}::uuid, 'AI_ACTIONS') + ${extra}
      WHERE business_id = ${businessId} AND unit = 'AI_ACTIONS'`;
  });

const refundSql = (
  tx: postgres.TransactionSql,
  businessId: string,
  reference: string,
  id: string,
) =>
  tx`SELECT set_config('app.business_id', ${businessId}, true)`.then(
    () => tx`SELECT * FROM subscription_record_refund(${businessId}::uuid, ${reference},
               ${PACK_K}::bigint, 'unused_add_on', ${ACTOR}, ${id})`,
  );
/** The refund on its own operator connection, committed when it returns. */
const refundOn = (
  client: Client,
  businessId: string,
  reference: string,
  id = `rf-${seq}-${Date.now()}`,
) =>
  client
    .begin((tx) => refundSql(tx, businessId, reference, id))
    .then(
      () => 'refunded',
      (error: { message?: string }) => String(error.message),
    );

/** Hold a transaction open on `client` after `body` has run, until `release()` is called. */
function holdOpen(client: Client, body: (tx: postgres.TransactionSql) => Promise<unknown>) {
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = new Promise<void>((resolve) => (ready = resolve));
  const done = client.begin(async (tx) => {
    await body(tx);
    ready();
    await gate;
  });
  return { held, release, done };
}
/** Wait until the backend named `name` is blocked on a row lock. */
async function blockedOnLock(name: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const rows = await owner`
      SELECT wait_event_type FROM pg_stat_activity WHERE application_name = ${name}`;
    if (rows[0]?.['wait_event_type'] === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${name} never blocked on a lock`);
}
const lockCounter = (tx: postgres.TransactionSql, businessId: string) =>
  tx`SELECT used FROM usage_counters WHERE business_id = ${businessId} AND unit = 'AI_ACTIONS'
     FOR UPDATE`;
const lockCharge = (tx: postgres.TransactionSql, reference: string) =>
  tx`SELECT id FROM subscription_charges WHERE reference = ${reference} FOR UPDATE`;
const upgradeToComplete = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    tx.execute(
      sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'complete', now() + interval '25 days')`,
    ),
  );

async function facts(businessId: string, reference: string) {
  const [charge] = await owner`
    SELECT status, refunded_amount_k::int AS refunded, units_revoked_at IS NOT NULL AS revoked
    FROM subscription_charges WHERE reference = ${reference}`;
  const [counter] = await owner`
    SELECT used, bonus FROM usage_counters WHERE business_id = ${businessId} AND unit = 'AI_ACTIONS'`;
  const [refunds] = await owner`
    SELECT count(*)::int AS n FROM subscription_refunds r JOIN subscription_charges c ON c.id = r.charge_id
    WHERE c.reference = ${reference}`;
  const [plan] = await owner`SELECT plan FROM businesses WHERE id = ${businessId}`;
  const [history] = await owner`
    SELECT count(*)::int AS n FROM business_allowance_changes WHERE business_id = ${businessId}`;
  return {
    status: charge!['status'] as string,
    refunded: charge!['refunded'] as number,
    revoked: charge!['revoked'] as boolean,
    used: counter!['used'] as number,
    bonus: counter!['bonus'] as number,
    refundRows: refunds!['n'] as number,
    plan: plan!['plan'] as string,
    historyRows: history!['n'] as number,
  };
}

describe('F-3: the pack refund under forced interleavings', () => {
  it('a plan change committed while the refund waits for the charge (before S2) is seen: refused for the owner', async () => {
    const businessId = await chatBusiness();
    const reference = await creditPack(businessId);
    const blocker = holdOpen(connect(urls.owner, 'f3-charge-holder'), (tx) =>
      lockCharge(tx, reference),
    );
    await blocker.held;
    const refunding = refundOn(connect(urls.operator, 'f3-refund-a'), businessId, reference);
    await blockedOnLock('f3-refund-a'); // at S1
    await upgradeToComplete(businessId); // commits while the refund is at S1
    blocker.release();
    await blocker.done;
    expect(await refunding).toMatch(/needs an owner decision \(OD-55\)/);
    expect(await facts(businessId, reference)).toMatchObject({
      status: 'paid',
      revoked: false,
      bonus: UNITS,
      refundRows: 0,
      plan: 'complete',
    });
  });

  /* Since 0243 the allowance is judged after the counter lock: a change that commits while the
   * refund waits for the counter is seen, and the refund goes to the owner, the serial order
   * "change, then refund". (Before 0243 it was not seen; review A showed that unsafe.) */
  it('a plan change committed while the refund waits for the counter is seen: refused for the owner', async () => {
    const businessId = await chatBusiness();
    const reference = await creditPack(businessId);
    const blocker = holdOpen(connect(urls.owner, 'f3-counter-holder'), (tx) =>
      lockCounter(tx, businessId),
    );
    await blocker.held;
    const refunding = refundOn(connect(urls.operator, 'f3-refund-b'), businessId, reference);
    await blockedOnLock('f3-refund-b'); // waiting for the counter
    await upgradeToComplete(businessId); // the plan writer commits; it needs neither lock
    blocker.release();
    await blocker.done;
    expect(await refunding).toMatch(/needs an owner decision \(OD-55\)/);
    expect(await facts(businessId, reference)).toMatchObject({
      status: 'paid',
      revoked: false,
      bonus: UNITS,
      refundRows: 0,
      plan: 'complete',
    });
  });

  it('an add-on holding change committed while the refund waits for the counter is likewise seen', async () => {
    const businessId = await chatBusiness();
    const reference = await creditPack(businessId);
    const blocker = holdOpen(connect(urls.owner, 'f3-counter-holder-2'), (tx) =>
      lockCounter(tx, businessId),
    );
    await blocker.held;
    const refunding = refundOn(connect(urls.operator, 'f3-refund-c'), businessId, reference);
    await blockedOnLock('f3-refund-c');
    /* A holding written as the owner would by settlement (no runtime role may write one, 0226). */
    await owner`
      INSERT INTO business_add_ons (business_id, add_on_id, version, started_at)
      SELECT ${businessId}, add_on_id, version, now() FROM add_ons ORDER BY add_on_id, version LIMIT 1`;
    blocker.release();
    await blocker.done;
    expect(await refunding).toMatch(/needs an owner decision \(OD-55\)/);
    expect(await facts(businessId, reference)).toMatchObject({
      status: 'paid',
      revoked: false,
      refundRows: 0,
    });
  });

  it('a plan change committed after the refund has judged and revoked is ordered after it', async () => {
    const businessId = await chatBusiness();
    const reference = await creditPack(businessId);
    const [{ at: before }] = await owner<{ at: Date }[]>`
      SELECT changed_at AS at FROM business_allowance_changes WHERE business_id = ${businessId}`;
    const refund = holdOpen(connect(urls.operator, 'f3-refund-b2'), (tx) =>
      refundSql(tx, businessId, reference, `rf-b2-${Date.now()}`),
    );
    await refund.held; // judged, revoked and recorded; uncommitted, holding the charge and counter
    await upgradeToComplete(businessId); // needs neither lock: commits now
    refund.release();
    await refund.done;
    expect(await facts(businessId, reference)).toMatchObject({
      status: 'refunded',
      refunded: PACK_K,
      revoked: true,
      bonus: 0,
      refundRows: 1,
      plan: 'complete',
    });
    /* And the change is in the history for any later refund to see. */
    const [{ at: after }] = await owner<{ at: Date }[]>`
      SELECT changed_at AS at FROM business_allowance_changes WHERE business_id = ${businessId}`;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('consumption committed while the refund waits at S3 is seen: a pack used meanwhile is not refunded', async () => {
    const businessId = await chatBusiness();
    const reference = await creditPack(businessId);
    /* The merchant's own allowance is fully used; the next reservation spends a pack unit. */
    await useAllowancePlus(businessId, 0);
    const month = await thisMonth();
    const consuming = holdOpen(connect(urls.app, 'f3-consumer'), async (tx) => {
      await tx`SELECT set_config('app.business_id', ${businessId}, true)`;
      const [r] = await tx`SELECT * FROM usage_reserve(${businessId}::uuid, ${month}, 'AI_ACTIONS',
                                  1000000, 1, false)`;
      expect(r!['granted']).toBe(true);
    });
    await consuming.held; // holds the counter row with one pack unit spent, uncommitted
    const refunding = refundOn(connect(urls.operator, 'f3-refund-d'), businessId, reference);
    await blockedOnLock('f3-refund-d');
    consuming.release();
    await consuming.done;
    expect(await refunding).toMatch(/the pack has been used/);
    expect(await facts(businessId, reference)).toMatchObject({
      status: 'paid',
      revoked: false,
      bonus: UNITS,
      refundRows: 0,
    });
  });

  it('consumption waiting behind a refund sees the revocation: it cannot spend a refunded unit', async () => {
    const businessId = await chatBusiness();
    const reference = await creditPack(businessId);
    await useAllowancePlus(businessId, 0);
    const refund = holdOpen(connect(urls.operator, 'f3-refund-e'), (tx) =>
      refundSql(tx, businessId, reference, `rf-e-${Date.now()}`),
    );
    await refund.held; // revoked, recorded, uncommitted: holds the charge and the counter
    const month = await thisMonth();
    const consumer = connect(urls.app, 'f3-consumer-2');
    const reserving = consumer.begin(async (tx) => {
      await tx`SELECT set_config('app.business_id', ${businessId}, true)`;
      const [r] = await tx`SELECT * FROM usage_reserve(${businessId}::uuid, ${month}, 'AI_ACTIONS',
                                  1000000, 1, false)`;
      return r!['granted'] as boolean;
    });
    await blockedOnLock('f3-consumer-2');
    refund.release();
    await refund.done;
    expect(await reserving).toBe(false); // the allowance is used and the pack is gone
    expect(await facts(businessId, reference)).toMatchObject({
      status: 'refunded',
      revoked: true,
      bonus: 0,
      refundRows: 1,
    });
  });

  it('two refunds of one pack serialise on the charge: the second is refused, units revoked once', async () => {
    const businessId = await chatBusiness();
    const reference = await creditPack(businessId);
    const first = holdOpen(connect(urls.operator, 'f3-refund-f1'), (tx) =>
      refundSql(tx, businessId, reference, `rf-f1-${Date.now()}`),
    );
    await first.held;
    const second = refundOn(
      connect(urls.operator, 'f3-refund-f2'),
      businessId,
      reference,
      `rf-f2-${Date.now()}`,
    );
    await blockedOnLock('f3-refund-f2');
    first.release();
    await first.done;
    expect(await second).toMatch(/cannot be refunded by that amount|refunded only once/);
    expect(await facts(businessId, reference)).toMatchObject({
      status: 'refunded',
      revoked: true,
      bonus: 0,
      refundRows: 1,
    });
  });

  it('two packs on one counter serialise there without a deadlock; the second reads the first’s revocation', async () => {
    const businessId = await chatBusiness();
    const one = await creditPack(businessId);
    const two = await creditPack(businessId);
    /* Use exactly one pack's worth beyond the plan: one pack is unused, the other is not. */
    await useAllowancePlus(businessId, UNITS);
    const first = holdOpen(connect(urls.operator, 'f3-refund-g1'), (tx) =>
      refundSql(tx, businessId, one, `rf-g1-${Date.now()}`),
    );
    await first.held; // holds charge one and the counter
    const second = refundOn(
      connect(urls.operator, 'f3-refund-g2'),
      businessId,
      two,
      `rf-g2-${Date.now()}`,
    );
    await blockedOnLock('f3-refund-g2'); // holds charge two, waits for the counter: no cycle
    first.release();
    await first.done;
    /* After the first revocation the remaining pack is the one the consumption needed. */
    expect(await second).toMatch(/the pack has been used/);
    expect((await facts(businessId, one)).refundRows).toBe(1);
    expect(await facts(businessId, two)).toMatchObject({
      status: 'paid',
      revoked: false,
      refundRows: 0,
    });
    expect((await facts(businessId, two)).bonus).toBe(UNITS);
  });

  it('a renewal of the same plan committed while the refund waits at S3 changes nothing it relies on', async () => {
    const businessId = await chatBusiness();
    const reference = await creditPack(businessId);
    const blocker = holdOpen(connect(urls.owner, 'f3-counter-holder-3'), (tx) =>
      lockCounter(tx, businessId),
    );
    await blocker.held;
    const refunding = refundOn(connect(urls.operator, 'f3-refund-h'), businessId, reference);
    await blockedOnLock('f3-refund-h');
    /* The renewal moves a paid plan's expiry and cycle; it is not an allowance change (0241). */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(
        sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'chat', now() + interval '55 days')`,
      ),
    );
    blocker.release();
    await blocker.done;
    expect(await refunding).toBe('refunded');
    expect(await facts(businessId, reference)).toMatchObject({
      status: 'refunded',
      revoked: true,
      bonus: 0,
      refundRows: 1,
      plan: 'chat',
    });
  });

  /* Review A of the closeout round (IMPORTANT): an allowance drop that commits after the refund's
   * allowance check, followed by consumption that spends pack units under the lower allowance, both
   * committing while the refund waits for the counter. Judged against the allowance read before the
   * lock, the pack looked unused and was refunded although the merchant had spent 51 of its units. */
  it('a downgrade and consumption that spends the pack, both while the refund waits at the counter, refuse it', async () => {
    const businessId = await chatBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(
        sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'complete', now() + interval '25 days')`,
      ),
    );
    const reference = await creditPack(businessId); // credited beside Complete's 1,200
    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.business_id', ${businessId}, true)`;
      await tx`UPDATE usage_counters SET used = 350
               WHERE business_id = ${businessId} AND unit = 'AI_ACTIONS'`;
    });
    const month = await thisMonth();
    const reserve = (tx: postgres.TransactionSql, n: number) =>
      tx`SELECT * FROM usage_reserve(${businessId}::uuid, ${month}, 'AI_ACTIONS', 1000000, ${n}, false)`;
    let spend!: () => void;
    const spendNow = new Promise<void>((resolve) => (spend = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const consumer = connect(urls.app, 'f3-consumer-down').begin(async (tx) => {
      await tx`SELECT set_config('app.business_id', ${businessId}, true)`;
      await reserve(tx, 1); // takes the counter row under Complete
      held();
      await spendNow;
      const [r] = await reserve(tx, 100); // under Chat: 400 + the pack's 100
      return r!['granted'] as boolean;
    });
    await holding;
    const refunding = refundOn(connect(urls.operator, 'f3-refund-down'), businessId, reference);
    await blockedOnLock('f3-refund-down'); // past its allowance read, waiting for the counter
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(
        sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'chat', now() + interval '25 days')`,
      ),
    );
    spend();
    expect(await consumer).toBe(true); // 451 used: 51 of them are the pack's
    expect(await refunding).toMatch(/needs an owner decision \(OD-55\)|the pack has been used/);
    expect(await facts(businessId, reference)).toMatchObject({
      status: 'paid',
      revoked: false,
      used: 451,
      bonus: UNITS,
      refundRows: 0,
    });
  });

  it('a refund that rolls back leaves no refund row, no revocation and no charge change', async () => {
    const businessId = await chatBusiness();
    const reference = await creditPack(businessId);
    const before = await facts(businessId, reference);
    const rolledBack = await connect(urls.operator, 'f3-refund-i')
      .begin(async (tx) => {
        await refundSql(tx, businessId, reference, `rf-i-${Date.now()}`);
        throw new Error('rolled back after the refund');
      })
      .catch((error: Error) => error.message);
    expect(rolledBack).toBe('rolled back after the refund');
    expect(await facts(businessId, reference)).toEqual(before);
  });
});
