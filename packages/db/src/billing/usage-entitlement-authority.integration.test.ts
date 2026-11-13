/**
 * MVP readiness review of PR #432 (migration 0222): the database, not the caller, decides how much a
 * business may spend and on which meter row.
 *
 * Before 0222, `usage_reserve` checked `used + n <= p_allowance + bonus` with the allowance and the
 * period both supplied by the caller, and it is executable by `rekoda_app` and `rekoda_worker`. A
 * holder of either credential could call it directly with any allowance, or name a month nobody has
 * spent in. Every attack below runs on a live `rekoda_app` (or `rekoda_worker`) connection, never as
 * the owner; the owner is used only to arrange state and to read it back.
 *
 * Also covered: an unbound reservation is refundable only while its request can still be running
 * (15 minutes). The job and event guards for an inheriting login (the review's MINOR residuals 10
 * and 11) and the settlement-job withholding attacks are in `usage-job-guards.integration.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { allowanceFor, isConsumable, usagePeriod, USAGE_UNITS, type UsageUnit } from '@rekoda/core';
import { withBusiness, type Db } from '../client.js';
import { events, usageRepo } from '../index.js';
import {
  appDb,
  outcome,
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
  workerDb,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const NOW_MONTH = () => usagePeriod(new Date());
const UNIT: UsageUnit = 'AI_ACTIONS';
/** What the trial sells of AI actions (PLAN_ALLOWANCES.trial, catalogue version 1). */
const TRIAL_AI = 50;

const counters = async (businessId: string, unit: string = UNIT) => [
  ...(await ownerDb.execute<{ period: string; used: number; bonus: number }>(
    sql`SELECT period, used, bonus FROM usage_counters
        WHERE business_id = ${businessId}::uuid AND unit = ${unit} ORDER BY period`,
  )),
];
const usedTotal = async (businessId: string, unit: string = UNIT) =>
  (await counters(businessId, unit)).reduce((sum, row) => sum + row.used, 0);
const reservations = async (businessId: string) =>
  Number(
    [
      ...(await ownerDb.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM usage_reservations WHERE business_id = ${businessId}::uuid`,
      )),
    ][0]!.n,
  );

/** A raw call of the database function, exactly as a holder of the credential could make it. */
const rawReserve = (
  db: Db,
  pin: string,
  args: {
    business: string;
    period: string;
    unit?: string;
    allowance: number;
    n: number;
    refundable?: boolean;
  },
) =>
  withBusiness(db, pin, async (tx) => {
    const rows = await tx.execute<{ granted: boolean; reservation: string | null }>(
      sql`SELECT granted, reservation FROM usage_reserve(
            ${args.business}::uuid, ${args.period}::text, ${args.unit ?? UNIT}::text,
            ${args.allowance}::int, ${args.n}::int, ${args.refundable ?? false}::boolean)`,
    );
    return [...rows][0]!;
  });

const entitlement = (db: Db, businessId: string, unit: string) =>
  withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ e: number }>(
      sql`SELECT usage_entitlement(${businessId}::uuid, ${unit}::text) AS e`,
    );
    return Number([...rows][0]!.e);
  });

/** A stored inbound message event for the business, as the webhook records it. */
async function storedEvent(businessId: string): Promise<string> {
  const recorded = await withBusiness(appDb, businessId, (tx) =>
    events.recordEvent(tx, {
      provider: 'meta',
      eventType: 'message',
      externalId: `wamid.${randomUUID()}`,
      payload: { sealed: 'opaque' },
      businessId,
    }),
  );
  if (!recorded.isNew) throw new Error('the event was not stored');
  return recorded.id;
}

/** Arrange a plan as the owner (the application cannot write these columns: 0196, 0207). */
const setPlan = (businessId: string, plan: string, expiresAt: Date | null) =>
  ownerDb.execute(sql`UPDATE businesses SET plan = ${plan},
      plan_expires_at = ${expiresAt ? expiresAt.toISOString() : null}::timestamptz
      WHERE id = ${businessId}::uuid`);

describe('0222: the ceiling is the database’s, whatever allowance the caller passes', () => {
  it('a valid trial spends up to what it was sold, and the unit past it is refused', async () => {
    const businessId = await seedBusiness();
    expect(await entitlement(appDb, businessId, UNIT)).toBe(TRIAL_AI);
    const ok = await rawReserve(appDb, businessId, {
      business: businessId,
      period: NOW_MONTH(),
      allowance: TRIAL_AI,
      n: TRIAL_AI,
    });
    expect(ok.granted).toBe(true);
    expect((await counters(businessId)).map((r) => r.period)).toEqual(['TRIAL00']);
    const past = await rawReserve(appDb, businessId, {
      business: businessId,
      period: NOW_MONTH(),
      allowance: TRIAL_AI,
      n: 1,
    });
    expect(past.granted).toBe(false);
    expect(await usedTotal(businessId)).toBe(TRIAL_AI);
  });

  it('ATTACK: rekoda_app passes an inflated allowance directly and is refused past the plan', async () => {
    const businessId = await seedBusiness();
    /* The pre-0222 reproduction: 5,000 granted against a trial that sells 50. */
    const attack = await rawReserve(appDb, businessId, {
      business: businessId,
      period: 'TRIAL00',
      allowance: 1_000_000,
      n: 5_000,
    });
    expect(attack.granted).toBe(false);
    expect(await usedTotal(businessId)).toBe(0);
    /* Unit by unit, the inflated allowance buys exactly the plan's units and no more. */
    let granted = 0;
    for (let i = 0; i < TRIAL_AI + 5; i += 1) {
      const r = await rawReserve(appDb, businessId, {
        business: businessId,
        period: 'TRIAL00',
        allowance: 1_000_000,
        n: 1,
      });
      if (r.granted) granted += 1;
    }
    expect(granted).toBe(TRIAL_AI);
    expect(await usedTotal(businessId)).toBe(TRIAL_AI);
  });

  it('ATTACK: the worker credential is held to the same ceiling', async () => {
    const businessId = await seedBusiness();
    const attack = await rawReserve(workerDb, businessId, {
      business: businessId,
      period: NOW_MONTH(),
      allowance: 1_000_000,
      n: TRIAL_AI + 1,
    });
    expect(attack.granted).toBe(false);
    /* WEBHOOK_DELIVERIES is sold only by the Developer API Starter holding: none is held. */
    const deliveries = await rawReserve(workerDb, businessId, {
      business: businessId,
      period: NOW_MONTH(),
      unit: 'WEBHOOK_DELIVERIES',
      allowance: 1_000_000,
      n: 1,
    });
    expect(deliveries.granted).toBe(false);
    expect(await usedTotal(businessId, 'WEBHOOK_DELIVERIES')).toBe(0);
  });

  it('the argument still LOWERS the ceiling: an honest caller’s stricter answer holds', async () => {
    const businessId = await seedBusiness();
    const consume = () =>
      withBusiness(appDb, businessId, (tx) =>
        usageRepo.consumeUnit(tx, businessId, NOW_MONTH(), UNIT, 2),
      );
    expect(await consume()).toBe(true);
    expect(await consume()).toBe(true);
    expect(await consume()).toBe(false);
    expect(await usedTotal(businessId)).toBe(2);
  });

  it('a refused spend consumes nothing and records no reservation', async () => {
    const businessId = await seedBusiness();
    const refused = await rawReserve(appDb, businessId, {
      business: businessId,
      period: NOW_MONTH(),
      allowance: 1_000_000,
      n: TRIAL_AI + 1,
      refundable: true,
    });
    expect(refused).toMatchObject({ granted: false, reservation: null });
    expect(await counters(businessId)).toEqual([]);
    expect(await reservations(businessId)).toBe(0);
  });

  it('concurrent spenders with an inflated allowance cannot together exceed the plan', async () => {
    const businessId = await seedBusiness();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        rawReserve(appDb, businessId, {
          business: businessId,
          period: NOW_MONTH(),
          allowance: 1_000_000,
          n: 5,
        }),
      ),
    );
    expect(results.filter((r) => r.granted)).toHaveLength(TRIAL_AI / 5);
    expect(await usedTotal(businessId)).toBe(TRIAL_AI);
  });
});

describe('0222: the meter row is the database’s, so no period label resets the allowance', () => {
  it('ATTACK: a trial naming a month (current, future or past) spends on its one trial row', async () => {
    const businessId = await seedBusiness();
    for (const period of [NOW_MONTH(), '2099-12', '2020-01']) {
      await rawReserve(appDb, businessId, {
        business: businessId,
        period,
        allowance: 1_000_000,
        n: TRIAL_AI,
      });
    }
    expect(await counters(businessId)).toEqual([
      expect.objectContaining({ period: 'TRIAL00', used: TRIAL_AI }),
    ]);
  });

  it('ATTACK: a paid business naming an unused month, or the trial row, spends on this month', async () => {
    const businessId = await seedBusiness();
    await setPlan(businessId, 'chat', new Date(Date.now() + 20 * 86_400_000));
    const chatAi = allowanceFor('chat', UNIT);
    for (const period of ['2099-12', '2020-01', 'TRIAL00', NOW_MONTH()]) {
      const r = await rawReserve(appDb, businessId, {
        business: businessId,
        period,
        allowance: 1_000_000,
        n: 1,
      });
      expect(r.granted).toBe(true);
    }
    expect(await counters(businessId)).toEqual([
      expect.objectContaining({ period: NOW_MONTH(), used: 4 }),
    ]);
    /* And the month's ceiling is the plan's: an unused label never adds a second allowance. */
    const rest = await rawReserve(appDb, businessId, {
      business: businessId,
      period: '2098-01',
      allowance: 1_000_000,
      n: chatAi - 4 + 1,
    });
    expect(rest.granted).toBe(false);
  });

  it('the meter row rule: last month is honoured only in a month’s first seven days', async () => {
    const businessId = await seedBusiness();
    await setPlan(businessId, 'chat', new Date(Date.now() + 20 * 86_400_000));
    const rows = await withBusiness(ownerDb, businessId, (tx) =>
      tx.execute<{ day: number; previous: string; chosen: string }>(sql`
        SELECT extract(day FROM now() AT TIME ZONE 'Africa/Lagos')::int AS day,
               to_char(date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') - interval '1 month',
                       'YYYY-MM') AS previous,
               rekoda_private.usage_meter_row(${businessId}::uuid,
                 to_char(date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') - interval '1 month',
                         'YYYY-MM'), ${UNIT}) AS chosen`),
    );
    const { day, previous, chosen } = [...rows][0]!;
    expect(chosen).toBe(day <= 7 ? previous : NOW_MONTH());
  });
});

describe('0222: the plan the database records is the plan that is metered', () => {
  it('an expired trial, and a lapsed paid plan, obtain nothing whatever they pass', async () => {
    const lapsedTrial = await seedBusiness();
    await setPlan(lapsedTrial, 'trial', new Date(Date.now() - 60_000));
    const lapsedPaid = await seedBusiness();
    await setPlan(lapsedPaid, 'expired', null);
    for (const businessId of [lapsedTrial, lapsedPaid]) {
      expect(await entitlement(appDb, businessId, UNIT)).toBe(0);
      const r = await rawReserve(appDb, businessId, {
        business: businessId,
        period: NOW_MONTH(),
        allowance: 1_000_000,
        n: 1,
      });
      expect(r.granted).toBe(false);
      expect(await usedTotal(businessId)).toBe(0);
    }
  });

  it('every consumable unit’s ceiling equals the plan table, on every plan (seconds for voice)', async () => {
    const businessId = await seedBusiness();
    for (const plan of ['trial', 'chat', 'integrate', 'complete', 'expired'] as const) {
      await setPlan(
        businessId,
        plan,
        plan === 'expired' ? null : new Date(Date.now() + 86_400_000),
      );
      for (const unit of USAGE_UNITS.filter(isConsumable)) {
        expect([plan, unit, await entitlement(appDb, businessId, unit)]).toEqual([
          plan,
          unit,
          allowanceFor(plan, unit),
        ]);
      }
    }
    /* Capacity units never go through the meter. */
    expect(await entitlement(appDb, businessId, 'API_APPLICATIONS')).toBe(0);
  });

  it('an upgrade recorded by the database raises the ceiling to the new plan’s', async () => {
    const businessId = await seedBusiness();
    await rawReserve(appDb, businessId, {
      business: businessId,
      period: NOW_MONTH(),
      allowance: 1_000_000,
      n: TRIAL_AI,
    });
    await setPlan(businessId, 'complete', new Date(Date.now() + 25 * 86_400_000));
    const complete = allowanceFor('complete', UNIT);
    expect(await entitlement(appDb, businessId, UNIT)).toBe(complete);
    /* The paid month is a fresh budget of the new plan's size (trial usage stays on its row). */
    const r = await rawReserve(appDb, businessId, {
      business: businessId,
      period: NOW_MONTH(),
      allowance: 1_000_000,
      n: complete,
    });
    expect(r.granted).toBe(true);
    expect((await counters(businessId)).map((row) => [row.period, row.used])).toEqual([
      [NOW_MONTH(), complete],
      ['TRIAL00', TRIAL_AI],
    ]);
    expect(
      (
        await rawReserve(appDb, businessId, {
          business: businessId,
          period: NOW_MONTH(),
          allowance: 1_000_000,
          n: 1,
        })
      ).granted,
    ).toBe(false);
  });

  it('a credited pack (bonus) and a held add-on’s monthly grant are respected', async () => {
    const businessId = await seedBusiness();
    /* A pack's units: `bonus`, raised in production only by usage_credit_pack (settlement). */
    await ownerDb.execute(sql`INSERT INTO usage_counters (business_id, period, unit, bonus)
                              VALUES (${businessId}::uuid, 'TRIAL00', ${UNIT}, 20)`);
    const pack = await rawReserve(appDb, businessId, {
      business: businessId,
      period: NOW_MONTH(),
      allowance: 1_000_000,
      n: TRIAL_AI + 20,
    });
    expect(pack.granted).toBe(true);
    expect(
      (
        await rawReserve(appDb, businessId, {
          business: businessId,
          period: NOW_MONTH(),
          allowance: 1_000_000,
          n: 1,
        })
      ).granted,
    ).toBe(false);

    /* The Developer API Starter grants 25,000 API requests a month, held by settlement's write. */
    await ownerDb.execute(sql`INSERT INTO business_add_ons (business_id, add_on_id, version, started_at)
                              VALUES (${businessId}::uuid, 'developer_api_starter', 1,
                                      now() - interval '1 day')`);
    expect(await entitlement(appDb, businessId, 'API_REQUEST_UNITS')).toBe(25_000);
    const api = await rawReserve(appDb, businessId, {
      business: businessId,
      period: NOW_MONTH(),
      unit: 'API_REQUEST_UNITS',
      allowance: 1_000_000,
      n: 25_001,
    });
    expect(api.granted).toBe(false);
    /* Ended holdings grant nothing. */
    await ownerDb.execute(sql`UPDATE business_add_ons SET ends_at = now() - interval '1 second'
                              WHERE business_id = ${businessId}::uuid`);
    expect(await entitlement(appDb, businessId, 'API_REQUEST_UNITS')).toBe(0);
  });

  it('an idempotent retry of the same event does not spend twice', async () => {
    const businessId = await seedBusiness();
    const recorded = { id: await storedEvent(businessId) };
    const attempt = () =>
      withBusiness(appDb, businessId, (tx) =>
        events.reserveUnitForEvent(tx, businessId, recorded.id, UNIT, () =>
          usageRepo.reserveUnit(tx, businessId, NOW_MONTH(), UNIT, TRIAL_AI),
        ),
      );
    expect(await attempt()).toBe(true);
    expect(await attempt()).toBe(true);
    expect(await usedTotal(businessId)).toBe(1);
  });
});

describe('0222: tenant context', () => {
  it('a reservation, entitlement read or refund for a business other than the pinned one is refused', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    expect(
      await outcome(
        rawReserve(appDb, mine, { business: theirs, period: NOW_MONTH(), allowance: 10, n: 1 }),
      ),
    ).toMatch(/^42501 .*not the pinned tenant/);
    expect(await outcome(entitlement(appDb, mine, UNIT).then(() => null))).toBe('allowed');
    expect(
      await outcome(
        withBusiness(appDb, mine, (tx) =>
          tx.execute(sql`SELECT usage_entitlement(${theirs}::uuid, ${UNIT})`),
        ),
      ),
    ).toMatch(/^42501 .*not the pinned tenant/);
    /* A refund of their reservation under my pin: refused; their counter unchanged. */
    const spent = await withBusiness(appDb, theirs, (tx) =>
      usageRepo.reserveUnit(tx, theirs, NOW_MONTH(), UNIT, 10),
    );
    expect(
      await outcome(
        withBusiness(appDb, mine, (tx) => usageRepo.refundUnit(tx, theirs, spent.meter, UNIT)),
      ),
    ).toMatch(/^42501 .*not the pinned tenant/);
    expect(
      await withBusiness(appDb, mine, (tx) => usageRepo.refundUnit(tx, mine, spent.meter, UNIT)),
    ).toBe(0);
    expect(await usedTotal(theirs)).toBe(1);
  });

  it('re-pinning mid-transaction by plain SQL gains nothing beyond the re-pinned tenant’s own plan', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    /* `app.business_id` is a session setting any role may set: the pin is a defect guard, not an
     * authentication of the caller (docs/REKODA_LAUNCH_READINESS.md, OD-51). What 0222 guarantees is
     * that whichever tenant is pinned, nothing exceeds THAT tenant's recorded plan. */
    const result = await withBusiness(appDb, mine, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.business_id', ${theirs}, true)`);
      const rows = await tx.execute<{ granted: boolean }>(
        sql`SELECT granted FROM usage_reserve(${theirs}::uuid, 'TRIAL00', ${UNIT}, 1000000, ${TRIAL_AI + 1}, false)`,
      );
      return [...rows][0]!.granted;
    });
    expect(result).toBe(false);
    expect(await usedTotal(theirs)).toBe(0);
    expect(await usedTotal(mine)).toBe(0);
  });
});

describe('0222: an unbound reservation is refundable only while its request can be running', () => {
  const backdate = (meter: usageRepo.MeterRow, minutes: number) =>
    ownerDb.execute(sql`UPDATE usage_reservations
        SET created_at = now() - make_interval(mins => ${minutes})
        WHERE id = ${usageRepo.reservationOf(meter)}::uuid`);

  it('a failed operation within the window gives its unit back, once', async () => {
    const businessId = await seedBusiness();
    const spent = await withBusiness(appDb, businessId, (tx) =>
      usageRepo.reserveUnit(tx, businessId, NOW_MONTH(), UNIT, TRIAL_AI),
    );
    await backdate(spent.meter, 14);
    const refund = () =>
      withBusiness(appDb, businessId, (tx) =>
        usageRepo.refundUnit(tx, businessId, spent.meter, UNIT),
      );
    expect(await refund()).toBe(1);
    expect(await refund()).toBe(0);
    expect(await usedTotal(businessId)).toBe(0);
  });

  it('ATTACK: a handle kept past the request (a successful send, order or export) returns nothing', async () => {
    const businessId = await seedBusiness();
    const spent = await withBusiness(appDb, businessId, (tx) =>
      usageRepo.reserveUnit(tx, businessId, NOW_MONTH(), UNIT, TRIAL_AI),
    );
    await backdate(spent.meter, 16);
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        usageRepo.refundUnit(tx, businessId, spent.meter, UNIT),
      ),
    ).toBe(0);
    expect(await usedTotal(businessId)).toBe(1);
  });

  it('a reservation bound to an unfinished job stays refundable past the window (0218 rule)', async () => {
    const businessId = await seedBusiness();
    const recorded = { id: await storedEvent(businessId) };
    const meter = await withBusiness(appDb, businessId, async (tx) => {
      const spent = await usageRepo.reserveUnit(tx, businessId, NOW_MONTH(), UNIT, TRIAL_AI);
      await events.noteReservedUnit(tx, businessId, recorded.id, UNIT, spent.meter);
      return spent.meter;
    });
    await backdate(meter, 120);
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        usageRepo.refundUnit(tx, businessId, meter, UNIT),
      ),
    ).toBe(1);
  });

  it('concurrent refunds of one reservation give back exactly once', async () => {
    const businessId = await seedBusiness();
    const spent = await withBusiness(appDb, businessId, (tx) =>
      usageRepo.reserveUnit(tx, businessId, NOW_MONTH(), UNIT, TRIAL_AI, 3),
    );
    const back = await Promise.all(
      Array.from({ length: 4 }, () =>
        withBusiness(appDb, businessId, (tx) =>
          usageRepo.refundUnit(tx, businessId, spent.meter, UNIT, 3),
        ),
      ),
    );
    expect(back.reduce((a, b) => a + b, 0)).toBe(3);
    expect(await usedTotal(businessId)).toBe(0);
  });
});
