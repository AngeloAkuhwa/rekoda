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
import { afterEach, describe, expect, it } from 'vitest';
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
  } = {},
): Promise<string> {
  chargeSeq += 1;
  const reference = `RKD-ADD-0224-${String(chargeSeq).padStart(6, '0')}`;
  await ownerDb.execute(sql`
    INSERT INTO subscription_charges
      (business_id, kind, plan, pack_id, quantity, amount_k, status, reference, period_start,
       period_end, paid_at, priced_at, pricing_source, billing_interval)
    VALUES (${businessId}::uuid, 'add_on', NULL,
      ${spec.packId === undefined ? 'messages_100' : spec.packId}, ${spec.quantity ?? 1},
      250000, 'paid', ${reference}, now(), now() + interval '30 days', now(),
      ${spec.pricedAt ?? null}::timestamptz,
      ${spec.pricingSource === undefined ? 'catalogue' : spec.pricingSource}, 'monthly')`);
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
    expect(await counters(businessId)).toEqual([]);
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

describe('0224: the catalogue version in force when the charge was PRICED', () => {
  afterEach(async () => {
    await ownerDb.execute(
      sql`DELETE FROM usage_packs WHERE pack_id = 'messages_100' AND version = 99`,
    );
    await ownerDb.execute(
      sql`UPDATE usage_packs SET effective_to = NULL WHERE pack_id = 'messages_100' AND version = 1`,
    );
  });

  it('credits the version a charge was priced at, not the one in force at settlement', async () => {
    // Version 1 (100 messages) until an hour ago; version 99 (150 messages) since.
    await ownerDb.execute(sql`
      UPDATE usage_packs SET effective_to = now() - interval '1 hour'
      WHERE pack_id = 'messages_100' AND version = 1`);
    await ownerDb.execute(sql`
      INSERT INTO usage_packs (pack_id, version, label, unit, quantity, price_minor, currency, effective_from)
      VALUES ('messages_100', 99, '150 extra WhatsApp messages', 'AI_ACTIONS', 150, 250000, 'NGN',
              now() - interval '1 hour')`);
    const businessId = await paidBusiness();
    const month = await thisMonth();
    const before = await packCharge(businessId, {
      pricedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    const after = await packCharge(businessId, { pricedAt: new Date().toISOString() });
    // Priced under version 1: 100, never the newer 150.
    expect(await outcome(credit(businessId, before, month, 'AI_ACTIONS', 150))).toMatch(MISMATCH);
    expect(await credit(businessId, before, month, 'AI_ACTIONS', 100)).toBe(true);
    // Priced under version 99: 150, never the older 100.
    expect(await outcome(credit(businessId, after, month, 'AI_ACTIONS', 100))).toMatch(MISMATCH);
    expect(await credit(businessId, after, month, 'AI_ACTIONS', 150)).toBe(true);
    expect(await counters(businessId)).toEqual([{ period: month, unit: 'AI_ACTIONS', bonus: 250 }]);
  });
});
