/**
 * The PR #432 remediation brief §5.6 (migration 0210): the database recomputes every charge it is
 * asked to open from Rekoda's versioned price catalogue, so even the settlement principal (the only
 * role that may open one, 0205) cannot open a charge at a price Rekoda does not sell. Run as
 * `rekoda_settlement` directly: the stolen-or-defective settlement scenario, not the application's
 * own pricing. The parity cases feed `@rekoda/core`'s own figures through the check.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { planChangeCharge, annualPriceK } from '@rekoda/core';
import { withBusiness } from '../client.js';
import { planCatalogueRepo } from '../index.js';
import { resetPlanCatalogue } from '../testing.js';
import {
  outcome,
  ownerDb,
  urls,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();
// The catalogue survives the suite's truncation; leave it as the migrations seeded it.
afterEach(async () => {
  await resetPlanCatalogue(urls);
});

let seq = 0;
const open = (
  businessId: string,
  c: {
    kind: string;
    plan?: string | null;
    pack?: string | null;
    quantity?: number | null;
    amount: number;
    interval?: string;
    currency?: string;
    start?: Date;
    end?: Date;
  },
) => {
  seq += 1;
  return outcome(
    withBusiness(settlementDb, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO subscription_charges
          (business_id, kind, plan, pack_id, quantity, amount_k, currency, reference,
           period_start, period_end, billing_interval)
        VALUES (${businessId}::uuid, ${c.kind}, ${c.plan ?? null}, ${c.pack ?? null},
          ${c.quantity ?? 1}, ${c.amount}, ${c.currency ?? 'NGN'}, ${`RKD-PRICE-${seq}`},
          ${(c.start ?? new Date()).toISOString()}::timestamptz,
          ${(c.end ?? new Date(Date.now() + 30 * 86_400_000)).toISOString()}::timestamptz,
          ${c.interval ?? 'monthly'})`),
    ),
  );
};

const DAY = 86_400_000;

/** A business on a standard monthly cycle of `plan`, started `daysIn` days ago. */
async function onCycle(
  plan: string,
  daysIn: number,
  length = 30,
): Promise<{ id: string; start: Date; end: Date }> {
  const id = await seedBusiness();
  const start = new Date(Date.now() - daysIn * DAY);
  const end = new Date(start.getTime() + length * DAY);
  await ownerDb.execute(sql`UPDATE businesses SET plan = ${plan}, billing_interval = 'monthly',
    cycle_started_at = ${start.toISOString()}::timestamptz,
    plan_expires_at = ${end.toISOString()}::timestamptz,
    plan_version_id = (SELECT id FROM plan_versions WHERE plan_id = ${plan} ORDER BY version DESC LIMIT 1)
    WHERE id = ${id}::uuid`);
  return { id, start, end };
}

describe('only a catalogue price opens a charge, even for settlement (0210)', () => {
  it('a first purchase at the plan price opens; a cheaper or dearer one is refused', async () => {
    const id = await seedBusiness();
    expect(await open(id, { kind: 'first_purchase', plan: 'complete', amount: 1 })).toMatch(
      /42501.*not at the catalogue price for complete \(monthly\): expected 2990000, got 1/,
    );
    expect(await open(id, { kind: 'first_purchase', plan: 'complete', amount: 2_990_001 })).toMatch(
      /42501/,
    );
    expect(await open(id, { kind: 'first_purchase', plan: 'complete', amount: 2_990_000 })).toBe(
      'allowed',
    );
  });

  it('an annual first purchase is the annual price; a monthly price on an annual charge is refused', async () => {
    const id = await seedBusiness();
    expect(
      await open(id, { kind: 'first_purchase', plan: 'chat', interval: 'annual', amount: 990_000 }),
    ).toMatch(/42501/);
    expect(
      await open(id, {
        kind: 'first_purchase',
        plan: 'chat',
        interval: 'annual',
        amount: annualPriceK(990_000),
      }),
    ).toBe('allowed');
  });

  it('a renewal is the price of the plan it renews on, at the grandfathered version when pinned', async () => {
    const { id } = await onCycle('integrate', 29);
    expect(await open(id, { kind: 'renewal', plan: 'integrate', amount: 990_000 })).toMatch(
      /42501/,
    );
    expect(await open(id, { kind: 'renewal', plan: 'integrate', amount: 1_990_000 })).toBe(
      'allowed',
    );
    // A repricing appends a dearer version; the pinned business still renews at its own price,
    // and nobody can open it at the new price for them either.
    const v1 = await onCycle('chat', 29);
    await planCatalogueRepo.publishPlanVersion(ownerDb, {
      planId: 'chat',
      name: 'Rekoda chat',
      seats: 1,
      effectiveFrom: new Date(Date.now() - 60_000),
      entitlements: ['REKODA_CHAT'],
      allowances: { AI_ACTIONS: 300, VOICE_MINUTES: 60, DOCUMENT_GENERATION: 100 },
      prices: [{ currency: 'NGN', billingInterval: 'monthly', amountMinor: 1_490_000 }],
    });
    expect(await open(v1.id, { kind: 'renewal', plan: 'chat', amount: 1_490_000 })).toMatch(
      /42501/,
    );
    expect(await open(v1.id, { kind: 'renewal', plan: 'chat', amount: 990_000 })).toBe('allowed');
  });

  it('a pack is its catalogue price, one at a time; an unknown pack is refused', async () => {
    const id = await seedBusiness();
    expect(await open(id, { kind: 'add_on', pack: 'messages_100', amount: 1 })).toMatch(/42501/);
    expect(
      await open(id, { kind: 'add_on', pack: 'messages_100', quantity: 10, amount: 250_000 }),
    ).toMatch(/42501/);
    expect(await open(id, { kind: 'add_on', pack: 'no_such_pack', amount: 0 })).toMatch(/42501/);
    expect(await open(id, { kind: 'add_on', pack: 'messages_100', amount: 250_000 })).toBe(
      'allowed',
    );
  });

  it('an upgrade is the prorated difference that core computes; under or over is refused', async () => {
    const { id, start, end } = await onCycle('chat', 10);
    const core = planChangeCharge({
      from: 'chat',
      to: 'complete',
      cycleStart: start,
      renewsAt: end,
      now: new Date(),
      pricesK: { from: 990_000, to: 2_990_000 },
    });
    expect(core.kind).toBe('upgrade');
    expect(core.amountK).toBeGreaterThan(0);
    const up = (amount: number) =>
      open(id, { kind: 'upgrade', plan: 'complete', amount, start, end });
    expect(await up(1)).toMatch(/42501.*prorated catalogue price/);
    expect(await up(2_000_000)).toMatch(/42501.*prorated catalogue price/);
    expect(await up(core.amountK)).toBe('allowed');
  });

  it('an upgrade to a cheaper or the same plan, or outside a known cycle, is refused', async () => {
    const { id, start, end } = await onCycle('complete', 5);
    expect(await open(id, { kind: 'upgrade', plan: 'chat', amount: 0, start, end })).toMatch(
      /42501.*dearer plan/,
    );
    expect(await open(id, { kind: 'upgrade', plan: 'complete', amount: 0, start, end })).toMatch(
      /42501.*dearer plan/,
    );
  });

  it('a charge in another currency or of an unknown kind is refused', async () => {
    const id = await seedBusiness();
    expect(
      await open(id, { kind: 'first_purchase', plan: 'chat', amount: 990_000, currency: 'USD' }),
    ).toMatch(/42501.*in NGN/);
    expect(await open(id, { kind: 'gift', plan: 'chat', amount: 0 })).toMatch(/42501|23514/);
  });

  it('the check is installed on INSERT for every role but the owner', async () => {
    const [row] = await ownerDb.execute<{ enabled: string }>(sql`
      SELECT tgenabled::text AS enabled FROM pg_trigger
      WHERE tgname = 'subscription_charges_price_check'
        AND tgrelid = 'public.subscription_charges'::regclass`);
    expect(row?.enabled).toBe('O');
  });
});
