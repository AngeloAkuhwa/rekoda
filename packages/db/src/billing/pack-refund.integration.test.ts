/**
 * Refunded packs and refund authorisation (owner brief, 15 Nov 2026; migration 0230).
 *
 * Owner decisions: a refunded pack's remaining units are revoked; a full refund is allowed only for
 * an unused pack within seven days (a partial refund of a pack is not approved, so none exists).
 * And only an authorised actor records a refund: `subscription_record_refund` runs on the
 * billing-operator credential alone, writes the audit event, and the application credential can no
 * longer move a charge to refunded.
 *
 * Every refund runs on a live `rekoda_billing_operator` connection; every attack on the role it
 * names; the owner only arranges state and reads it back.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness, type Db } from '../client.js';
import { subscriptionsRepo } from '../index.js';
import {
  appDb,
  operatorDb,
  outcome,
  ownerDb,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
  workerDb,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const PACK_K = 250_000; // messages_100, the catalogue's price
const UNITS = 100;

async function thisMonth(): Promise<string> {
  const [r] = await ownerDb.execute<{ m: string }>(
    sql`SELECT to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYY-MM') AS m`,
  );
  return r!.m;
}

let seq = 0;
/** A paid business holding a paid messages_100 charge, credited through usage_credit_pack. */
async function creditedPack(): Promise<{ businessId: string; reference: string }> {
  const businessId = await seedBusiness();
  await withBusiness(appDb, businessId, (tx) =>
    tx.execute(
      sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'chat', now() + interval '25 days')`,
    ),
  );
  seq += 1;
  const reference = `RKD-PACK-20261115-R${String(seq).padStart(5, '0')}`;
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
  return { businessId, reference };
}
const refund = (
  businessId: string,
  reference: string,
  amountK = PACK_K,
  reason: subscriptionsRepo.RefundReason = 'unused_add_on',
) =>
  subscriptionsRepo.recordRefund(operatorDb, {
    businessId,
    reference,
    amountK,
    reason,
    actor: 'operator:ada@rekoda.test',
  });
const bonus = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{ bonus: number }>(sql`
      SELECT coalesce(sum(bonus), 0)::int AS bonus FROM usage_counters
      WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS'`)),
  ][0]!.bonus;
const chargeOf = async (reference: string) =>
  [
    ...(await ownerDb.execute<{ status: string; refunded_amount_k: string; revoked: boolean }>(sql`
      SELECT status, refunded_amount_k::text, units_revoked_at IS NOT NULL AS revoked
      FROM subscription_charges WHERE reference = ${reference}`)),
  ][0]!;
const refundAudits = async (businessId: string) => [
  ...(await ownerDb.execute<{ actor: string; new_value: Record<string, unknown> }>(sql`
      SELECT actor, new_value FROM audit_events
      WHERE business_id = ${businessId}::uuid AND action = 'refunded' ORDER BY created_at`)),
];

describe('0230: a credited pack is refunded only in full, unused, within seven days, and loses its units', () => {
  it('records the credit; a full refund of an unused pack revokes its units, audited', async () => {
    const { businessId, reference } = await creditedPack();
    const [credit] = await ownerDb.execute<{ units: number; unit: string; period: string }>(sql`
      SELECT credited_units AS units, credited_unit AS unit, credited_period::text AS period
      FROM subscription_charges WHERE reference = ${reference}`);
    expect(credit).toEqual({ units: UNITS, unit: 'AI_ACTIONS', period: await thisMonth() });
    expect(await bonus(businessId)).toBe(UNITS);

    expect(await refund(businessId, reference)).toEqual({
      status: 'refunded',
      refundedK: PACK_K,
      revokedUnits: UNITS,
    });
    expect(await bonus(businessId)).toBe(0);
    expect(await chargeOf(reference)).toEqual({
      status: 'refunded',
      refunded_amount_k: String(PACK_K),
      revoked: true,
    });
    expect(await refundAudits(businessId)).toEqual([
      {
        actor: 'operator:ada@rekoda.test',
        new_value: {
          amountK: PACK_K,
          reason: 'unused_add_on',
          status: 'refunded',
          revokedUnits: UNITS,
        },
      },
    ]);
  });

  it('refuses a partial refund, a used pack, and one past seven days, changing nothing', async () => {
    const partial = await creditedPack();
    await expect(refund(partial.businessId, partial.reference, PACK_K - 1)).rejects.toThrow(
      /refunded only once, in full/,
    );

    const used = await creditedPack();
    /* Consumption needed the pack's units: one more than the plan alone allows. */
    await withBusiness(ownerDb, used.businessId, (tx) =>
      tx.execute(sql`UPDATE usage_counters SET used = usage_entitlement(${used.businessId}::uuid, 'AI_ACTIONS') + 1
                     WHERE business_id = ${used.businessId}::uuid AND unit = 'AI_ACTIONS'`),
    );
    await expect(refund(used.businessId, used.reference)).rejects.toThrow(/has been used/);

    const old = await creditedPack();
    await ownerDb.execute(sql`UPDATE subscription_charges SET units_credited_at = now() - interval '7 days 1 minute'
                              WHERE reference = ${old.reference}`);
    await expect(refund(old.businessId, old.reference)).rejects.toThrow(/within seven days/);

    for (const pack of [partial, used, old]) {
      expect(await bonus(pack.businessId)).toBe(UNITS);
      expect(await chargeOf(pack.reference)).toMatchObject({ status: 'paid', revoked: false });
      expect(await refundAudits(pack.businessId)).toEqual([]);
    }
  });

  it('a pack using only part of its plan allowance is still unused, at the boundary', async () => {
    const { businessId, reference } = await creditedPack();
    await withBusiness(ownerDb, businessId, (tx) =>
      tx.execute(sql`UPDATE usage_counters SET used = usage_entitlement(${businessId}::uuid, 'AI_ACTIONS')
                     WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS'`),
    );
    expect((await refund(businessId, reference)).revokedUnits).toBe(UNITS);
  });

  it('a repeated or concurrent refund revokes once', async () => {
    const { businessId, reference } = await creditedPack();
    const results = await Promise.allSettled([
      refund(businessId, reference),
      refund(businessId, reference),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(refund(businessId, reference)).rejects.toThrow(
      /cannot be refunded|refunded only once/,
    );
    expect(await bonus(businessId)).toBe(0);
    expect(await refundAudits(businessId)).toHaveLength(1);
  });

  it('a pack credited before its units were recorded is refused, to be settled by hand', async () => {
    const { businessId, reference } = await creditedPack();
    await ownerDb.execute(sql`UPDATE subscription_charges
      SET credited_units = NULL, credited_unit = NULL, credited_period = NULL WHERE reference = ${reference}`);
    await expect(refund(businessId, reference)).rejects.toThrow(/settle it by hand/);
  });

  it('a pack payment that was never credited (set aside) is refunded with nothing to revoke', async () => {
    const businessId = await seedBusiness();
    await ownerDb.execute(sql`
      INSERT INTO subscription_charges
        (business_id, kind, pack_id, quantity, amount_k, paid_amount_k, status, reference,
         period_start, period_end, paid_at, pricing_source, billing_interval, unapplied_at,
         unapplied_reason)
      VALUES (${businessId}::uuid, 'add_on', 'messages_100', 1, ${PACK_K}, ${PACK_K}, 'paid',
              'RKD-PACK-20261115-DUP001', now(), now() + interval '30 days', now(), 'catalogue',
              'monthly', now(), 'duplicate_purchase')`);
    expect(
      await refund(businessId, 'RKD-PACK-20261115-DUP001', PACK_K, 'duplicate_charge'),
    ).toEqual({
      status: 'refunded',
      refundedK: PACK_K,
      revokedUnits: 0,
    });
  });
});

describe('0230: only the billing operator records a refund', () => {
  it('ATTACK: the application, the worker and settlement cannot run the refund function', async () => {
    const { businessId, reference } = await creditedPack();
    for (const db of [appDb, workerDb, settlementDb] as Db[]) {
      expect(
        await outcome(
          withBusiness(db, businessId, (tx) =>
            tx.execute(sql`SELECT * FROM subscription_record_refund(${businessId}::uuid, ${reference},
                             ${PACK_K}::bigint, 'unused_add_on', 'operator:forged')`),
          ),
        ),
      ).toMatch(/^42501 .*permission denied/);
    }
  });

  it('ATTACK: the application cannot mark a charge refunded or write a refund or credit fact directly', async () => {
    const { businessId, reference } = await creditedPack();
    for (const change of [
      sql`status = 'refunded'`,
      sql`refunded_amount_k = ${PACK_K}`,
      sql`refunded_at = now()`,
      sql`units_revoked_at = now()`,
      sql`credited_units = 1`,
    ]) {
      expect(
        await outcome(
          withBusiness(appDb, businessId, (tx) =>
            tx.execute(
              sql`UPDATE subscription_charges SET ${change} WHERE reference = ${reference}`,
            ),
          ),
        ),
      ).toMatch(/^42501 /);
    }
    expect(await chargeOf(reference)).toMatchObject({ status: 'paid', revoked: false });
  });

  it('refuses another business’s pin, an unknown reason, and more than was charged', async () => {
    const { businessId, reference } = await creditedPack();
    const other = await seedBusiness();
    expect(
      await outcome(
        withBusiness(operatorDb, other, (tx) =>
          tx.execute(sql`SELECT * FROM subscription_record_refund(${businessId}::uuid, ${reference},
                           ${PACK_K}::bigint, 'unused_add_on', 'operator:ada')`),
        ),
      ),
    ).toMatch(/^42501 .*not the pinned tenant/);
    await expect(
      refund(businessId, reference, PACK_K, 'goodwill' as subscriptionsRepo.RefundReason),
    ).rejects.toThrow(/ADR 0024 reasons/);
    await expect(refund(businessId, reference, PACK_K + 1)).rejects.toThrow(
      /cannot be refunded by that amount/,
    );
  });
});
