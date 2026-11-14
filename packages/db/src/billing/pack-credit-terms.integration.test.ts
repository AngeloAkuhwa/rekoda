/**
 * Migration 0224: `usage_credit_pack` credits exactly what the charge bought, never what the caller
 * says it bought.
 *
 * Before 0224 the function checked that the charge was a paid, not-set-aside, not-yet-credited
 * add-on charge of the pinned business, but took the unit, the meter row and the number of units
 * from its caller (`rekoda_settlement`). A holder of that credential could therefore credit a
 * legitimate paid pack charge with any unit and any quantity. Since 0224, for a charge priced from
 * the catalogue (the source in force on staging and in production), the database derives the pack
 * version in force when the charge was priced, the unit, and the quantity (pack size x packs
 * bought, voice in seconds), and accepts the call only when the caller's values are exactly those,
 * on the meter row the database itself would use now.
 *
 * Every call runs on a live `rekoda_settlement` connection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness, type Db } from '../client.js';
import {
  appDb,
  outcome,
  ownerDb,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const MISMATCH = /^42501 .*does not match the pack this charge bought/;
const NOT_A_PACK = /^42501 .*not a paid pack charge that may be credited/;

let chargeSeq = 0;
/** A paid pack charge, written as the owner with the columns settlement would have left. */
async function packCharge(
  businessId: string,
  spec: {
    packId?: string | null;
    quantity?: number;
    pricedAt?: string;
    pricingSource?: 'catalogue' | 'constants' | null;
    /** Default: the pack's catalogue price x the packs bought, as the application opens it. */
    amountK?: number;
    paidAmountK?: number | null;
    unapplied?: boolean;
    superseded?: boolean;
  } = {},
): Promise<string> {
  chargeSeq += 1;
  const reference = `RKD-ADD-0224-${String(chargeSeq).padStart(6, '0')}`;
  const packId = spec.packId === undefined ? 'messages_100' : spec.packId;
  const quantity = spec.quantity ?? 1;
  const amount =
    spec.amountK === undefined
      ? sql`coalesce((SELECT price_minor FROM usage_packs WHERE pack_id = ${packId}
                      ORDER BY version LIMIT 1), 1000) * ${quantity}::int`
      : sql`${spec.amountK}::bigint`;
  await ownerDb.execute(sql`
    INSERT INTO subscription_charges
      (business_id, kind, plan, pack_id, quantity, amount_k, paid_amount_k, status, reference,
       period_start, period_end, paid_at, priced_at, pricing_source, billing_interval,
       unapplied_at, unapplied_reason, superseded_at)
    VALUES (${businessId}::uuid, 'add_on', NULL, ${packId}, ${quantity}, ${amount},
      ${spec.paidAmountK ?? null}::bigint, 'paid', ${reference}, now(), now() + interval '30 days',
      now(), ${spec.pricedAt ?? null}::timestamptz,
      ${spec.pricingSource === undefined ? 'catalogue' : spec.pricingSource}, 'monthly',
      ${spec.unapplied ? sql`now()` : sql`NULL`}, ${spec.unapplied ? 'price_not_verified' : null},
      ${spec.superseded ? sql`now()` : sql`NULL`})`);
  return reference;
}

/** The meter month the database is in now (Africa/Lagos), as a paid plan's row is named. */
async function thisMonth(): Promise<string> {
  const [r] = await ownerDb.execute<{ m: string }>(
    sql`SELECT to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYY-MM') AS m`,
  );
  return r!.m;
}
async function monthOffset(months: number): Promise<string> {
  const [r] = await ownerDb.execute<{ m: string }>(
    sql`SELECT to_char((date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')
                        + make_interval(months => ${months}::int)), 'YYYY-MM') AS m`,
  );
  return r!.m;
}

/** A business on a paid plan, so its units meter on the calendar month. */
async function paidBusiness(): Promise<string> {
  const businessId = await seedBusiness();
  await withBusiness(appDb, businessId, (tx) =>
    tx.execute(sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'chat',
                     now() + interval '25 days')`),
  );
  return businessId;
}

const credit = (businessId: string, reference: string, period: string, unit: string, n: number) =>
  withBusiness(settlementDb as Db, businessId, async (tx) => {
    const rows = await tx.execute<{ credited: boolean }>(
      sql`SELECT usage_credit_pack(${businessId}::uuid, ${reference}, ${period}, ${unit}, ${n}::int) AS credited`,
    );
    return [...rows][0]?.credited;
  });

const counters = async (businessId: string) => [
  ...(await ownerDb.execute<{ period: string; unit: string; bonus: number }>(sql`
      SELECT period::text AS period, unit, bonus FROM usage_counters
      WHERE business_id = ${businessId}::uuid AND bonus <> 0 ORDER BY period, unit`)),
];
const creditedAt = async (reference: string) =>
  [
    ...(await ownerDb.execute<{ at: string | null }>(
      sql`SELECT units_credited_at::text AS at FROM subscription_charges WHERE reference = ${reference}`,
    )),
  ][0]!.at;

describe('0224: a pack charge credits exactly what it bought', () => {
  it('credits the purchased unit and quantity, on this month, once', async () => {
    const businessId = await paidBusiness();
    const month = await thisMonth();
    const one = await packCharge(businessId);
    const three = await packCharge(businessId, { packId: 'documents_50', quantity: 3 });
    expect(await credit(businessId, one, month, 'AI_ACTIONS', 100)).toBe(true);
    expect(await credit(businessId, three, month, 'DOCUMENT_GENERATION', 150)).toBe(true);
    expect(await counters(businessId)).toEqual([
      { period: month, unit: 'AI_ACTIONS', bonus: 100 },
      { period: month, unit: 'DOCUMENT_GENERATION', bonus: 150 },
    ]);
    // Repeating, with the right values or with any others, changes nothing.
    expect(await credit(businessId, one, month, 'AI_ACTIONS', 100)).toBe(false);
    expect(await credit(businessId, one, month, 'AI_ACTIONS', 5000)).toBe(false);
    expect((await counters(businessId))[0]!.bonus).toBe(100);
  });

  it('counts a voice pack in seconds, as the meter does', async () => {
    const businessId = await paidBusiness();
    const reference = await packCharge(businessId, { packId: 'voice_30min' });
    expect(
      await outcome(credit(businessId, reference, await thisMonth(), 'VOICE_MINUTES', 30)),
    ).toMatch(MISMATCH);
    expect(await credit(businessId, reference, await thisMonth(), 'VOICE_MINUTES', 1800)).toBe(
      true,
    );
  });

  it('refuses an inflated or reduced quantity, and credits nothing', async () => {
    const businessId = await paidBusiness();
    const month = await thisMonth();
    const reference = await packCharge(businessId, { quantity: 2 });
    for (const n of [201, 1000, 2_000_000, 199, 100, 1]) {
      expect(await outcome(credit(businessId, reference, month, 'AI_ACTIONS', n))).toMatch(
        MISMATCH,
      );
    }
    expect(await counters(businessId)).toEqual([]);
    expect(await creditedAt(reference)).toBeNull();
    expect(await credit(businessId, reference, month, 'AI_ACTIONS', 200)).toBe(true);
  });

  it('refuses another unit than the pack sells', async () => {
    const businessId = await paidBusiness();
    const month = await thisMonth();
    const reference = await packCharge(businessId);
    for (const unit of [
      'DOCUMENT_GENERATION',
      'VOICE_MINUTES',
      'CATALOGUE_ORDERS',
      'API_REQUEST_UNITS',
    ]) {
      expect(await outcome(credit(businessId, reference, month, unit, 100))).toMatch(MISMATCH);
    }
    expect(await counters(businessId)).toEqual([]);
    expect(await creditedAt(reference)).toBeNull();
  });

  it('refuses a meter row other than the one the database uses now', async () => {
    const businessId = await paidBusiness();
    const reference = await packCharge(businessId);
    for (const period of [
      await monthOffset(1),
      await monthOffset(12),
      await monthOffset(-6),
      'TRIAL00',
    ]) {
      expect(await outcome(credit(businessId, reference, period, 'AI_ACTIONS', 100))).toMatch(
        MISMATCH,
      );
    }
    expect((await counters(businessId)).filter((c) => c.unit === 'AI_ACTIONS')).toEqual([]);
    // A trial meters its base units on the trial row, and only there.
    const trial = await seedBusiness();
    const onTrial = await packCharge(trial);
    expect(await outcome(credit(trial, onTrial, await thisMonth(), 'AI_ACTIONS', 100))).toMatch(
      MISMATCH,
    );
    expect(await credit(trial, onTrial, 'TRIAL00', 'AI_ACTIONS', 100)).toBe(true);
  });

  it('refuses a charge with no pack, or with a pack the catalogue does not hold', async () => {
    const businessId = await paidBusiness();
    const month = await thisMonth();
    const noPack = await packCharge(businessId, { packId: null });
    const unknown = await packCharge(businessId, { packId: 'whatsapp_500' });
    expect(await outcome(credit(businessId, noPack, month, 'AI_ACTIONS', 100))).toMatch(NOT_A_PACK);
    expect(await outcome(credit(businessId, unknown, month, 'AI_ACTIONS', 100))).toMatch(MISMATCH);
    expect(await counters(businessId)).toEqual([]);
  });

  it('derives the terms for a charge that recorded no pricing source from the source in force', async () => {
    const businessId = await paidBusiness();
    const reference = await packCharge(businessId, { pricingSource: null });
    expect(
      await outcome(credit(businessId, reference, await thisMonth(), 'AI_ACTIONS', 900)),
    ).toMatch(MISMATCH);
    expect(await credit(businessId, reference, await thisMonth(), 'AI_ACTIONS', 100)).toBe(true);
  });
});

describe('0224: the amount paid for is bound to the units credited', () => {
  it('refuses a charge whose amount is not the pack price x the packs bought', async () => {
    const businessId = await paidBusiness();
    const month = await thisMonth();
    // 50,000 packs "bought" for one kobo, and one pack for one kobo.
    const cheapMany = await packCharge(businessId, { quantity: 50_000, amountK: 1 });
    const cheapOne = await packCharge(businessId, { amountK: 1 });
    expect(await outcome(credit(businessId, cheapMany, month, 'AI_ACTIONS', 5_000_000))).toMatch(
      MISMATCH,
    );
    expect(await outcome(credit(businessId, cheapOne, month, 'AI_ACTIONS', 100))).toMatch(MISMATCH);
    expect(await counters(businessId)).toEqual([]);
  });

  it('refuses a charge the provider was paid less than its amount for', async () => {
    const businessId = await paidBusiness();
    const short = await packCharge(businessId, { paidAmountK: 249_999 });
    const exact = await packCharge(businessId, { paidAmountK: 250_000 });
    const over = await packCharge(businessId, { paidAmountK: 300_000 });
    const month = await thisMonth();
    expect(await outcome(credit(businessId, short, month, 'AI_ACTIONS', 100))).toMatch(MISMATCH);
    expect(await credit(businessId, exact, month, 'AI_ACTIONS', 100)).toBe(true);
    // An overpayment still buys the pack (the excess is visible on the charge, G-107).
    expect(await credit(businessId, over, month, 'AI_ACTIONS', 100)).toBe(true);
  });

  it('settlement cannot put a set-aside or superseded paid charge back to credit it', async () => {
    const businessId = await paidBusiness();
    const setAside = await packCharge(businessId, { unapplied: true });
    const superseded = await packCharge(businessId, { superseded: true });
    for (const [reference, column] of [
      [setAside, 'unapplied_at'],
      [superseded, 'superseded_at'],
    ] as const) {
      expect(
        await outcome(
          withBusiness(settlementDb as Db, businessId, (tx) =>
            tx.execute(sql`UPDATE subscription_charges SET ${sql.raw(column)} = NULL
                           WHERE reference = ${reference}`),
          ),
        ),
      ).toMatch(/^42501 .*a paid charge set aside cannot be put back/);
    }
    expect(
      await outcome(credit(businessId, setAside, await thisMonth(), 'AI_ACTIONS', 100)),
    ).toMatch(NOT_A_PACK);
    expect(await counters(businessId)).toEqual([]);
  });
});

describe('0224: settlement moves a status only out of pending', () => {
  const asSettlement = (businessId: string, statement: ReturnType<typeof sql>) =>
    outcome(withBusiness(settlementDb as Db, businessId, (tx) => tx.execute(statement)));

  it('cannot move a set-aside paid charge back to pending, clear it, and pay it again', async () => {
    const businessId = await paidBusiness();
    const setAside = await packCharge(businessId, { unapplied: true });
    expect(
      await asSettlement(
        businessId,
        sql`UPDATE subscription_charges SET status = 'pending' WHERE reference = ${setAside}`,
      ),
    ).toMatch(/^42501 .*settlement moves a charge's status only out of pending/);
    expect(
      await outcome(credit(businessId, setAside, await thisMonth(), 'AI_ACTIONS', 100)),
    ).toMatch(NOT_A_PACK);
    expect(await counters(businessId)).toEqual([]);
  });

  it('cannot revive a refunded charge to credit it', async () => {
    const businessId = await paidBusiness();
    const reference = await packCharge(businessId);
    await ownerDb.execute(sql`UPDATE subscription_charges
      SET status = 'refunded', refunded_amount_k = amount_k, refunded_at = now()
      WHERE reference = ${reference}`);
    for (const status of ['pending', 'paid', 'failed']) {
      expect(
        await asSettlement(
          businessId,
          sql`UPDATE subscription_charges SET status = ${status} WHERE reference = ${reference}`,
        ),
      ).toMatch(/^42501 .*settlement moves a charge's status only out of pending/);
    }
    expect(
      await outcome(credit(businessId, reference, await thisMonth(), 'AI_ACTIONS', 100)),
    ).toMatch(NOT_A_PACK);
  });

  it('still settles a pending charge (pending to paid, and pending to failed)', async () => {
    const businessId = await paidBusiness();
    const a = await packCharge(businessId);
    const b = await packCharge(businessId, { packId: 'documents_50' });
    await ownerDb.execute(sql`UPDATE subscription_charges SET status = 'pending', paid_at = NULL
      WHERE reference IN (${a}, ${b})`);
    expect(
      await asSettlement(
        businessId,
        sql`UPDATE subscription_charges SET status = 'paid', paid_at = now() WHERE reference = ${a}`,
      ),
    ).toBe('allowed');
    expect(
      await asSettlement(
        businessId,
        sql`UPDATE subscription_charges SET status = 'failed', failed_at = now() WHERE reference = ${b}`,
      ),
    ).toBe('allowed');
  });
});

describe('0224: a charge priced from the compiled figures (constants)', () => {
  it('still credits only the unit the pack sells, on the meter row in use (the quantity is the recorded trust boundary)', async () => {
    const businessId = await paidBusiness();
    const month = await thisMonth();
    const reference = await packCharge(businessId, { pricingSource: 'constants' });
    expect(await outcome(credit(businessId, reference, month, 'VOICE_MINUTES', 100))).toMatch(
      MISMATCH,
    );
    expect(
      await outcome(credit(businessId, reference, await monthOffset(1), 'AI_ACTIONS', 100)),
    ).toMatch(MISMATCH);
    expect(await credit(businessId, reference, month, 'AI_ACTIONS', 100)).toBe(true);
  });
});

describe('0224: the catalogue version in force when the charge was PRICED', () => {
  /* A pack of its own, so the seeded catalogue is never altered, even by a crashed run. */
  const PACK = 'test_pack_0224';
  const addVersion = (version: number, quantity: number, from: string, to: string | null) =>
    ownerDb.execute(sql`
      INSERT INTO usage_packs (pack_id, version, label, unit, quantity, price_minor, currency,
                               effective_from, effective_to)
      VALUES (${PACK}, ${version}, ${`test pack v${version}`}, 'AI_ACTIONS', ${quantity}, 250000,
              'NGN', ${from}::timestamptz, ${to}::timestamptz)`);
  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  beforeEach(async () => {
    await ownerDb.execute(sql`DELETE FROM usage_packs WHERE pack_id = ${PACK}`);
  });
  afterEach(async () => {
    await ownerDb.execute(sql`DELETE FROM usage_packs WHERE pack_id = ${PACK}`);
  });

  it('with no version in force at pricing time, credits the earliest version, as settlement does', async () => {
    await addVersion(1, 70, hoursFromNow(24), hoursFromNow(48));
    await addVersion(2, 90, hoursFromNow(48), null);
    const businessId = await paidBusiness();
    const reference = await packCharge(businessId, { packId: PACK });
    expect(
      await outcome(credit(businessId, reference, await thisMonth(), 'AI_ACTIONS', 90)),
    ).toMatch(MISMATCH);
    expect(await credit(businessId, reference, await thisMonth(), 'AI_ACTIONS', 70)).toBe(true);
  });

  it('credits the version a charge was priced at, not the one in force at settlement', async () => {
    // Version 1 (100 units) until an hour ago; version 2 (150 units) since.
    await addVersion(1, 100, hoursFromNow(-48), hoursFromNow(-1));
    await addVersion(2, 150, hoursFromNow(-1), null);
    const businessId = await paidBusiness();
    const month = await thisMonth();
    const before = await packCharge(businessId, { packId: PACK, pricedAt: hoursFromNow(-2) });
    const after = await packCharge(businessId, { packId: PACK, pricedAt: hoursFromNow(0) });
    // Priced under version 1: 100, never the newer 150.
    expect(await outcome(credit(businessId, before, month, 'AI_ACTIONS', 150))).toMatch(MISMATCH);
    expect(await credit(businessId, before, month, 'AI_ACTIONS', 100)).toBe(true);
    // Priced under version 2: 150, never the older 100.
    expect(await outcome(credit(businessId, after, month, 'AI_ACTIONS', 100))).toMatch(MISMATCH);
    expect(await credit(businessId, after, month, 'AI_ACTIONS', 150)).toBe(true);
    expect(await counters(businessId)).toEqual([{ period: month, unit: 'AI_ACTIONS', bonus: 250 }]);
  });
});
