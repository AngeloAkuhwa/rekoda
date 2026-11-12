/**
 * OD-51.7 (migration 0214), in the database: a charge's purchase identity and the one-credit rule
 * hold whatever code or credential runs the settlement.
 *
 *   * `purchase_id` is set at the insert and never changes for a runtime role;
 *   * a charge may name an existing purchase only as a replacement for the same pack, and never one
 *     that is already credited;
 *   * at most one charge of a purchase can carry `units_credited_at`, settlement included.
 *
 * Every assertion runs on a live connection as that principal. The settlement behaviour built on
 * this (second payment set aside, sibling links retired) is in
 * `apps/api/src/billing/pack-purchase-identity.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness, type Db } from '../client.js';
import { usageRepo } from '../index.js';
import {
  appDb,
  outcome,
  ownerDb,
  PRINCIPALS,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

let seq = 0;
const nextReference = () => {
  seq += 1;
  return `RKD-PACK-20261112-${String(seq).padStart(6, '0')}`;
};

/** A pending pack charge, opened by the application as production does. */
async function openPack(
  businessId: string,
  opts: { purchaseId?: string; pack?: string; quantity?: number; db?: Db; kind?: string } = {},
): Promise<string> {
  const reference = nextReference();
  await withBusiness(opts.db ?? appDb, businessId, (tx) =>
    tx.execute(sql`
      INSERT INTO subscription_charges
        (business_id, kind, plan, pack_id, quantity, amount_k, reference, purchase_id)
      VALUES (${businessId}::uuid, ${opts.kind ?? 'add_on'},
        ${opts.kind && opts.kind !== 'add_on' ? 'chat' : null},
        ${opts.kind && opts.kind !== 'add_on' ? null : (opts.pack ?? 'documents_50')},
        ${opts.quantity ?? 1}, 200000, ${reference},
        COALESCE(${opts.purchaseId ?? null}::uuid, gen_random_uuid()))`),
  );
  return reference;
}

const purchaseOf = async (reference: string): Promise<string> => {
  const [row] = await ownerDb.execute<{ purchase_id: string }>(
    sql`SELECT purchase_id FROM subscription_charges WHERE reference = ${reference}`,
  );
  return row!.purchase_id;
};

const retire = (reference: string) =>
  ownerDb.execute(
    sql`UPDATE subscription_charges SET superseded_at = now(), abandoned_at = now() WHERE reference = ${reference}`,
  );

/** Settlement's own writes: paid, then credited through the pack-credit function (0216). */
const credit = (businessId: string, reference: string) =>
  withBusiness(settlementDb, businessId, async (tx) => {
    await tx.execute(
      sql`UPDATE subscription_charges SET status = 'paid', paid_at = now(), paid_amount_k = amount_k WHERE reference = ${reference}`,
    );
    await usageRepo.creditPack(tx, businessId, reference, '2026-11', 'DOCUMENT_GENERATION', 50);
  });

describe('OD-51.7: a pack charge carries the identity of its purchase (0214)', () => {
  it('every charge gets its own purchase unless it names the one it replaces', async () => {
    const businessId = await seedBusiness();
    const first = await openPack(businessId);
    await retire(first);
    const fresh = await openPack(businessId);
    expect(await purchaseOf(fresh)).not.toBe(await purchaseOf(first));
    await retire(fresh);
    const replacement = await openPack(businessId, { purchaseId: await purchaseOf(first) });
    expect(await purchaseOf(replacement)).toBe(await purchaseOf(first));
  });

  it('no runtime role can move a charge to another purchase', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    const before = await purchaseOf(reference);
    for (const principal of ['app', 'worker', 'settlement', 'operator'] as const) {
      expect(
        await outcome(
          withBusiness(PRINCIPALS[principal](), businessId, (tx) =>
            tx.execute(
              sql`UPDATE subscription_charges SET purchase_id = gen_random_uuid() WHERE reference = ${reference}`,
            ),
          ),
        ),
      ).toMatch(/^42501 /);
    }
    expect(await purchaseOf(reference)).toBe(before);
  });

  it('a purchase is continued only by a replacement for the same pack and quantity', async () => {
    const businessId = await seedBusiness();
    const first = await openPack(businessId);
    await retire(first);
    const purchaseId = await purchaseOf(first);
    expect(await outcome(openPack(businessId, { purchaseId, pack: 'messages_100' }))).toMatch(
      /^42501 .*only as a replacement for the same pack/,
    );
    expect(await outcome(openPack(businessId, { purchaseId, quantity: 2 }))).toMatch(
      /^42501 .*only as a replacement for the same pack/,
    );
    expect(await outcome(openPack(businessId, { purchaseId, kind: 'first_purchase' }))).toMatch(
      /^42501 .*only as a replacement for the same pack/,
    );
  });

  it('a credited purchase cannot be continued: buying again is a new purchase', async () => {
    const businessId = await seedBusiness();
    const first = await openPack(businessId);
    await credit(businessId, first);
    expect(await outcome(openPack(businessId, { purchaseId: await purchaseOf(first) }))).toMatch(
      /^42501 .*already credited; a new purchase gets a new identity/,
    );
    /* A new identity is fine. */
    expect(await outcome(openPack(businessId))).toBe('allowed');
  });

  it('only one charge of a purchase can ever be credited, even by settlement itself', async () => {
    const businessId = await seedBusiness();
    const first = await openPack(businessId);
    await retire(first);
    const second = await openPack(businessId, { purchaseId: await purchaseOf(first) });

    await credit(businessId, second);
    expect(await outcome(credit(businessId, first))).toMatch(
      /^23505 .*subscription_charges_one_credit_per_purchase_ux/,
    );

    const rows = await ownerDb.execute<{ reference: string; credited: boolean; status: string }>(
      sql`SELECT reference, units_credited_at IS NOT NULL AS credited, status FROM subscription_charges
          WHERE business_id = ${businessId}::uuid ORDER BY created_at`,
    );
    /* The refused transaction rolled back whole: the old link is still an unpaid, retired charge. */
    expect([...rows]).toEqual([
      { reference: first, credited: false, status: 'pending' },
      { reference: second, credited: true, status: 'paid' },
    ]);
  });

  it("another business's purchase id is its own purchase here, and credits independently", async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    const theirCharge = await openPack(theirs);
    await credit(theirs, theirCharge);
    const purchaseId = await purchaseOf(theirCharge);
    /* Naming it from another tenant neither fails nor links the two. */
    const myCharge = await openPack(mine, { purchaseId });
    expect(await outcome(credit(mine, myCharge))).toBe('allowed');
  });
});
