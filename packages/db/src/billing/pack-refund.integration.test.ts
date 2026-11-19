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
import { randomUUID } from 'node:crypto';
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
    providerRefundId: `rf-${globalThis.crypto.randomUUID()}`,
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
      replayed: false,
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
          providerRefundId: expect.stringMatching(/^rf-/),
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
      replayed: false,
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
                             ${PACK_K}::bigint, 'unused_add_on', 'operator:forged', 'rf-forged')`),
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
                           ${PACK_K}::bigint, 'unused_add_on', 'operator:ada', 'rf-other-pin')`),
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

/* ── Second independent review of PR #432 (migration 0235) ──────────────────────────────────── */

/** A paid, never-credited plan charge (a duplicate payment set aside): refundable in parts. */
async function paidPlanCharge(businessId: string, amountK = 990_000): Promise<string> {
  seq += 1;
  const reference = `RKD-SUB-20261115-P${String(seq).padStart(5, '0')}`;
  await ownerDb.execute(sql`
    INSERT INTO subscription_charges
      (business_id, kind, plan, amount_k, paid_amount_k, status, reference, period_start,
       period_end, paid_at, pricing_source, billing_interval, unapplied_at, unapplied_reason)
    VALUES (${businessId}::uuid, 'renewal', 'chat', ${amountK}, ${amountK}, 'paid', ${reference},
            now() - interval '400 days', now() - interval '370 days', now(), 'catalogue',
            'monthly', now(), 'duplicate_payment')`);
  return reference;
}
const record = (
  businessId: string,
  reference: string,
  providerRefundId: string,
  amountK: number,
  reason: subscriptionsRepo.RefundReason = 'duplicate_charge',
  actor = 'operator:ada@rekoda.test',
) =>
  subscriptionsRepo.recordRefund(operatorDb, {
    businessId,
    reference,
    amountK,
    reason,
    actor,
    providerRefundId,
  });
const refundRows = async (businessId: string) => [
  ...(await ownerDb.execute<{ provider_refund_id: string; amount_k: string }>(sql`
      SELECT provider_refund_id, amount_k::text FROM subscription_refunds
      WHERE business_id = ${businessId}::uuid ORDER BY recorded_at`)),
];

describe('R06 (0235): one provider refund is recorded once', () => {
  it('a sequential replay of the same partial refund changes nothing and says so', async () => {
    const businessId = await seedBusiness();
    const reference = await paidPlanCharge(businessId);
    const first = await record(businessId, reference, 'rf-1001', 300_000);
    expect(first).toEqual({ status: 'paid', refundedK: 300_000, revokedUnits: 0, replayed: false });
    /* The operator's first call timed out after the provider refund succeeded: they record it again. */
    const again = await record(businessId, reference, 'rf-1001', 300_000);
    expect(again).toEqual({ status: 'paid', refundedK: 300_000, revokedUnits: 0, replayed: true });
    expect(await chargeOf(reference)).toMatchObject({
      refunded_amount_k: '300000',
      status: 'paid',
    });
    expect(await refundRows(businessId)).toEqual([
      { provider_refund_id: 'rf-1001', amount_k: '300000' },
    ]);
    expect(await refundAudits(businessId)).toHaveLength(1);
  });

  it('two genuine partial refunds are both recorded, up to the charge and no further', async () => {
    const businessId = await seedBusiness();
    const reference = await paidPlanCharge(businessId);
    await record(businessId, reference, 'rf-2001', 400_000);
    const second = await record(businessId, reference, 'rf-2002', 590_000);
    expect(second).toMatchObject({ status: 'refunded', refundedK: 990_000, replayed: false });
    await expect(record(businessId, reference, 'rf-2003', 1)).rejects.toThrow(
      /cannot be refunded by that amount/,
    );
    expect((await refundRows(businessId)).map((r) => r.amount_k)).toEqual(['400000', '590000']);
  });

  it('refuses the same provider refund with another amount, another charge or another business', async () => {
    const businessId = await seedBusiness();
    const reference = await paidPlanCharge(businessId);
    const otherCharge = await paidPlanCharge(businessId);
    const otherBusiness = await seedBusiness();
    const foreign = await paidPlanCharge(otherBusiness);
    await record(businessId, reference, 'rf-3001', 100_000);
    await expect(record(businessId, reference, 'rf-3001', 100_001)).rejects.toThrow(
      /already recorded with another charge or amount/,
    );
    await expect(record(businessId, otherCharge, 'rf-3001', 100_000)).rejects.toThrow(
      /already recorded with another charge or amount/,
    );
    await expect(record(otherBusiness, foreign, 'rf-3001', 100_000)).rejects.toThrow(
      /already recorded with another charge or amount/,
    );
    expect(await chargeOf(otherCharge)).toMatchObject({ refunded_amount_k: '0' });
    expect(await chargeOf(foreign)).toMatchObject({ refunded_amount_k: '0' });
    expect(await refundRows(otherBusiness)).toEqual([]);
  });

  it('refuses a reference of another business, under that other business’s pin, writing nothing', async () => {
    const businessId = await seedBusiness();
    const reference = await paidPlanCharge(businessId);
    const other = await seedBusiness();
    await expect(record(other, reference, 'rf-4001', 1_000)).rejects.toThrow(
      /cannot be refunded by that amount/,
    );
    expect(await chargeOf(reference)).toMatchObject({ refunded_amount_k: '0' });
    expect(await refundRows(other)).toEqual([]);
  });

  it('a concurrent replay of one provider refund records it once', async () => {
    const businessId = await seedBusiness();
    const reference = await paidPlanCharge(businessId);
    const id = `rf-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => record(businessId, reference, id, 250_000)),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(3);
    expect(await chargeOf(reference)).toMatchObject({ refunded_amount_k: '250000' });
    expect(await refundRows(businessId)).toHaveLength(1);
    expect(await refundAudits(businessId)).toHaveLength(1);
  });

  it('a credited pack replayed after its refund is answered as recorded, its units revoked once', async () => {
    const { businessId, reference } = await creditedPack();
    const first = await record(businessId, reference, 'rf-5001', PACK_K, 'unused_add_on');
    expect(first).toMatchObject({ status: 'refunded', revokedUnits: UNITS, replayed: false });
    const again = await record(businessId, reference, 'rf-5001', PACK_K, 'unused_add_on');
    expect(again).toMatchObject({ status: 'refunded', revokedUnits: UNITS, replayed: true });
    expect(await bonus(businessId)).toBe(0);
  });

  it('a malformed provider refund id is refused, writing nothing', async () => {
    const businessId = await seedBusiness();
    const reference = await paidPlanCharge(businessId);
    for (const bad of ['', 'has space', 'x'.repeat(101), "rf'1"]) {
      await expect(record(businessId, reference, bad, 1_000)).rejects.toThrow(/provider refund id/);
    }
    expect(await refundRows(businessId)).toEqual([]);
  });
});

describe('R04 (0235): the refund actor follows the operator contract', () => {
  it('accepts a 255-character operator subject and refuses a 256-character or malformed one', async () => {
    const businessId = await seedBusiness();
    const reference = await paidPlanCharge(businessId);
    const longest = `operator:${'s'.repeat(255)}`;
    await record(businessId, reference, 'rf-6001', 1_000, 'duplicate_charge', longest);
    const [audit] = await ownerDb.execute<{ actor: string }>(sql`
      SELECT actor FROM audit_events WHERE business_id = ${businessId}::uuid AND action = 'refunded'`);
    expect(audit!.actor).toBe(longest);
    for (const bad of [`operator:${'s'.repeat(256)}`, 'alice', 'operator:', 'operator:a b']) {
      await expect(
        record(businessId, reference, `rf-${randomUUID()}`, 1_000, 'duplicate_charge', bad),
      ).rejects.toThrow(/operator:<subject> actor/);
    }
  });
});

describe('R09 (0235): a pack judged unused only against the allowance it was credited beside', () => {
  it('a pack consumed before an upgrade does not look unused after it', async () => {
    const { businessId, reference } = await creditedPack();
    /* Consumption on Chat needed 30 of the pack's units... */
    await withBusiness(ownerDb, businessId, (tx) =>
      tx.execute(sql`UPDATE usage_counters SET used = usage_entitlement(${businessId}::uuid, 'AI_ACTIONS') + 30
                     WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS'`),
    );
    /* ...then the merchant upgrades: Complete's larger allowance would cover that consumption. */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(
        sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'complete', now() + interval '25 days')`,
      ),
    );
    await expect(refund(businessId, reference)).rejects.toThrow(
      /needs an owner decision \(OD-55\)/,
    );
    expect(await bonus(businessId)).toBe(UNITS);
    expect(await chargeOf(reference)).toMatchObject({ status: 'paid', revoked: false });
  });

  /* A-1 (independent review of the remediation, 0240): equal now is not unchanged throughout. */
  it('a pack consumed while the plan was lower is not unused after the plan returns', async () => {
    const { businessId, reference } = await creditedPack(); // credited on Chat
    /* Down to the trial-sized plan... (any lower allowance) */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(
        sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'expired', now() + interval '25 days')`,
      ),
    );
    /* ...consumption that needed the pack's units while it was lower... */
    await withBusiness(ownerDb, businessId, (tx) =>
      tx.execute(sql`UPDATE usage_counters SET used = usage_entitlement(${businessId}::uuid, 'AI_ACTIONS') + 40
                     WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS'`),
    );
    /* ...and back to Chat: the allowance is equal again, the consumption looks covered. */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(
        sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'chat', now() + interval '25 days')`,
      ),
    );
    await expect(refund(businessId, reference)).rejects.toThrow(
      /needs an owner decision \(OD-55\)/,
    );
    expect(await bonus(businessId)).toBe(UNITS);
    expect(await chargeOf(reference)).toMatchObject({ status: 'paid', revoked: false });
  });

  /* Final review of PR #432 (head 0b4956a, F-1): a trial's allowance also follows its expiry
   * (`usage_entitlement` reads `plan_expires_at` for a trial), so an expiry moved past and back with
   * `plan` unchanged (the staging date tool, or a re-posted trial) left no history row, and a pack
   * that paid for the consumption while the trial read expired was refunded in full as unused. 0241
   * records a trial's expiry change as an allowance change. */
  it('a pack consumed while a trial read expired is not unused after the expiry returns', async () => {
    const businessId = await seedBusiness();
    const setTrial = (expires: ReturnType<typeof sql>) =>
      withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`SELECT test_fixture_set_plan(${businessId}::uuid, 'trial', ${expires})`),
      );
    await setTrial(sql`now() + interval '7 days'`);
    seq += 1;
    const reference = `RKD-PACK-20261118-T${String(seq).padStart(5, '0')}`;
    await ownerDb.execute(sql`
      INSERT INTO subscription_charges
        (business_id, kind, plan, pack_id, quantity, amount_k, paid_amount_k, status, reference,
         period_start, period_end, paid_at, pricing_source, billing_interval)
      VALUES (${businessId}::uuid, 'add_on', NULL, 'messages_100', 1, ${PACK_K}, ${PACK_K}, 'paid',
              ${reference}, now(), now() + interval '30 days', now(), 'catalogue', 'monthly')`);
    await withBusiness(settlementDb, businessId, (tx) =>
      tx.execute(
        sql`SELECT usage_credit_pack(${businessId}::uuid, ${reference}, 'TRIAL00', 'AI_ACTIONS', ${UNITS}::int)`,
      ),
    );
    /* The trial reads expired (allowance 0); 40 actions can only be paid for by the pack... */
    await setTrial(sql`now() - interval '1 hour'`);
    await withBusiness(ownerDb, businessId, (tx) =>
      tx.execute(sql`UPDATE usage_counters SET used = 40
                     WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS'`),
    );
    /* ...and the expiry comes back with the plan unchanged: the allowance is equal again. */
    await setTrial(sql`now() + interval '7 days'`);
    await expect(refund(businessId, reference)).rejects.toThrow(
      /needs an owner decision \(OD-55\)/,
    );
    expect(await bonus(businessId)).toBe(UNITS);
    expect(await chargeOf(reference)).toMatchObject({ status: 'paid', revoked: false });
  });

  it('an add-on holding changed after the credit also leaves the decision to the owner', async () => {
    const { businessId, reference } = await creditedPack();
    await ownerDb.execute(sql`INSERT INTO business_add_ons (business_id, add_on_id, version, started_at)
                              VALUES (${businessId}::uuid, 'developer_api_starter', 1, now())`);
    await ownerDb.execute(
      sql`DELETE FROM business_add_ons WHERE business_id = ${businessId}::uuid`,
    );
    await expect(refund(businessId, reference)).rejects.toThrow(
      /needs an owner decision \(OD-55\)/,
    );
  });

  it('records the allowance at the credit, and refunds an unused pack while it is unchanged', async () => {
    const { businessId, reference } = await creditedPack();
    const [snap] = await ownerDb.execute<{ entitlement: number; unit: string }>(sql`
      SELECT e.entitlement, e.unit FROM pack_credit_entitlements e
      JOIN subscription_charges c ON c.id = e.charge_id WHERE c.reference = ${reference}`);
    const [now] = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT usage_entitlement(${businessId}::uuid, 'AI_ACTIONS') AS n`,
      ),
    );
    expect(snap).toEqual({ entitlement: now!.n, unit: 'AI_ACTIONS' });
    expect((await refund(businessId, reference)).revokedUnits).toBe(UNITS);
  });

  it('ATTACK: no runtime role writes the recorded allowance or a refund row', async () => {
    const { businessId, reference } = await creditedPack();
    for (const db of [appDb, workerDb, settlementDb, operatorDb] as Db[]) {
      for (const write of [
        sql`UPDATE pack_credit_entitlements SET entitlement = 0`,
        sql`DELETE FROM pack_credit_entitlements`,
        sql`INSERT INTO subscription_refunds (business_id, charge_id, provider_refund_id, amount_k, reason, actor)
            SELECT business_id, id, 'rf-forged', 1, 'duplicate_charge', 'operator:x'
            FROM subscription_charges WHERE reference = ${reference}`,
      ]) {
        expect(await outcome(withBusiness(db, businessId, (tx) => tx.execute(write)))).toMatch(
          /^42501 /,
        );
      }
    }
  });
});

describe('G1-1 (0235): the application never presets a credit or revocation fact', () => {
  it('ATTACK: a new pending charge with credited_* or units_revoked_at set is refused', async () => {
    const businessId = await seedBusiness();
    for (const [column, value] of [
      ['credited_units', sql`1`],
      ['credited_unit', sql`'AI_ACTIONS'`],
      ['credited_period', sql`'2026-11'`],
      ['units_revoked_at', sql`now()`],
    ] as const) {
      seq += 1;
      expect(
        await outcome(
          withBusiness(appDb, businessId, (tx) =>
            tx.execute(sql`
              INSERT INTO subscription_charges
                (business_id, kind, pack_id, quantity, amount_k, status, reference, period_start,
                 period_end, pricing_source, billing_interval, ${sql.raw(column)})
              VALUES (${businessId}::uuid, 'add_on', 'messages_100', 1, ${PACK_K}, 'pending',
                      ${`RKD-PACK-20261115-G${String(seq).padStart(5, '0')}`}, now(),
                      now() + interval '30 days', 'catalogue', 'monthly', ${value})`),
          ),
        ),
      ).toMatch(/^42501 .*opens only a new pending charge/);
    }
  });
});
