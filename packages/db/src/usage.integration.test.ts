/**
 * The usage meter (docs/metering-v1.md), against real PostgreSQL.
 *
 * The claim that matters is the race: N concurrent consumers against an
 * allowance of K get exactly K grants, decided by the database. Everything
 * else — zero allowances refusing the first unit, bonus raising the ceiling
 * the way a billing top-up will, refunds flooring at zero — exists so the
 * commercial rules in the doc are enforced shapes, not intentions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { billingRepo, identity, usageRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';
import { USAGE_UNITS, allowanceFor } from '@rekoda/core';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 10 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348140000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const PERIOD = '2026-08';

const consume = (businessId: string, allowance: number, n = 1) =>
  withBusiness(db, businessId, (tx) =>
    usageRepo.consumeUnit(tx, businessId, PERIOD, 'AI_ACTIONS', allowance, n),
  );

describe('the atomic gate', () => {
  it('grants exactly K of N concurrent consumes against an allowance of K', async () => {
    const businessId = await seedBusiness();

    // Eight messages arrive together against the last five units. A
    // read-then-write meter grants all eight; this one cannot.
    const results = await Promise.all(Array.from({ length: 8 }, () => consume(businessId, 5)));

    expect(results.filter(Boolean)).toHaveLength(5);
    const [row] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(row?.used).toBe(5);
  });

  it('refuses the FIRST unit of a zero allowance — orders on Chat is not "one free"', async () => {
    const businessId = await seedBusiness();
    expect(await consume(businessId, 0)).toBe(false);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(rows).toHaveLength(0); // refused consumes leave no residue
  });

  it('lets a billing top-up raise the ceiling through bonus, and only through bonus', async () => {
    const businessId = await seedBusiness();
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(false); // exhausted at plan allowance

    // What the M4 billing event will do after a VERIFIED top-up payment.
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE usage_counters SET bonus = 3
        WHERE business_id = ${businessId}::uuid AND period = ${PERIOD} AND unit = 'AI_ACTIONS'
      `),
    );

    expect(await consume(businessId, 2)).toBe(true); // doorway reopened
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(false); // and closes again at plan+bonus
  });

  it('refunds floor at zero and give back exactly what was taken', async () => {
    const businessId = await seedBusiness();
    await consume(businessId, 5);
    await consume(businessId, 5);

    await withBusiness(db, businessId, (tx) =>
      usageRepo.refundUnit(tx, businessId, PERIOD, 'AI_ACTIONS'),
    );
    const [row] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(row?.used).toBe(1);

    // Refunding more than was ever taken cannot mint credit.
    await withBusiness(db, businessId, (tx) =>
      usageRepo.refundUnit(tx, businessId, PERIOD, 'AI_ACTIONS', 99),
    );
    const [floored] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(floored?.used).toBe(0);
  });

  it('keeps months separate — a new period is a fresh meter', async () => {
    const businessId = await seedBusiness();
    expect(await consume(businessId, 1)).toBe(true);
    expect(await consume(businessId, 1)).toBe(false);

    const nextMonth = await withBusiness(db, businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, '2026-09', 'AI_ACTIONS', 1),
    );
    expect(nextMonth).toBe(true);
  });
});

describe('the trial clock (docs/pricing-model.md)', () => {
  /** Move a business's plan and expiry directly, as an operator or time would. */
  async function setPlanRow(businessId: string, plan: string, expiresAt: Date | null) {
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE businesses
        SET plan = ${plan}, plan_expires_at = ${expiresAt ? expiresAt.toISOString() : null}::timestamptz
        WHERE id = ${businessId}::uuid
      `),
    );
  }

  const planOf = (businessId: string, now?: Date) =>
    withBusiness(db, businessId, (tx) => usageRepo.planFor(tx, businessId, now));

  it('gives a new business a 30-day trial, dated at creation', async () => {
    const businessId = await seedBusiness();
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ plan: string; plan_expires_at: string | null }>(
        sql`SELECT plan, plan_expires_at FROM businesses WHERE id = ${businessId}::uuid`,
      ),
    );
    const row = [...rows][0];
    expect(row?.plan).toBe('trial');
    expect(row?.plan_expires_at).not.toBeNull();

    const days = (new Date(row!.plan_expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('answers "expired" once the trial date passes, and "trial" before it', async () => {
    const businessId = await seedBusiness();
    expect(await planOf(businessId)).toBe('trial');

    // A minute before the date, still a trial; a minute after, expired.
    const expiry = new Date(Date.now() + 60_000);
    await setPlanRow(businessId, 'trial', expiry);
    expect(await planOf(businessId)).toBe('trial');
    expect(await planOf(businessId, new Date(expiry.getTime() + 1_000))).toBe('expired');
  });

  it('NEVER expires a paid plan, even with a date in the past', async () => {
    const businessId = await seedBusiness();
    // A late billing job must not cut off a merchant who is paying us.
    await setPlanRow(businessId, 'chat', new Date(Date.now() - 86_400_000));
    expect(await planOf(businessId)).toBe('chat');
  });

  it('refuses the first message once expired — zero allowance, not a special case', async () => {
    const businessId = await seedBusiness();
    await setPlanRow(businessId, 'trial', new Date(Date.now() - 1_000));
    expect(await planOf(businessId)).toBe('expired');
    // allowanceFor('expired', 'AI_ACTIONS') is 0, and a zero allowance refuses.
    expect(await consume(businessId, 0)).toBe(false);
  });
});

describe('plan changes and upgrade requests', () => {
  it('moves a business onto a plan and records who did it', async () => {
    const businessId = await seedBusiness();
    const expiresAt = new Date(Date.now() + 365 * 86_400_000);

    const changed = await billingRepo.setPlan(db, {
      businessId,
      plan: 'chat',
      expiresAt,
      actor: 'operator:angelo',
    });
    expect(changed).toBe(true);
    expect(await withBusiness(db, businessId, (tx) => usageRepo.planFor(tx, businessId))).toBe(
      'chat',
    );

    const audit = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ actor: string; action: string; old_value: { plan: string } }>(sql`
        SELECT actor, action, old_value FROM audit_events WHERE action = 'plan_changed'
      `),
    );
    const row = [...audit][0];
    expect(row?.actor).toBe('operator:angelo');
    // The previous plan is kept: "what were they on before" is the question
    // a billing dispute actually asks.
    expect(row?.old_value.plan).toBe('trial');
  });

  it('answers false for a business that does not exist, changing nothing', async () => {
    const changed = await billingRepo.setPlan(db, {
      businessId: '2b0f9b6a-0000-4000-8000-000000000000',
      plan: 'complete',
      expiresAt: null,
      actor: 'operator:typo',
    });
    expect(changed).toBe(false);
  });

  it('records every upgrade request with the plan it came from', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      billingRepo.recordUpgradeRequest(tx, businessId, 'expired'),
    );
    await withBusiness(db, businessId, (tx) =>
      billingRepo.recordUpgradeRequest(tx, businessId, 'expired'),
    );

    const requests = await withBusiness(db, businessId, (tx) =>
      billingRepo.upgradeRequestsFor(tx, businessId),
    );
    // Two asks are two rows: a merchant who repeats themselves is information.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.fromPlan).toBe('expired');
  });
});

/**
 * Reservation, for the one unit whose size is not known before it is spent.
 *
 * Spec §4.3 rule 3 forbids paying a transcriber before the merchant is
 * authorised, and rule 4 names the way out: reserve, then refund what was
 * not used. Everything below is about the reservation never handing out more
 * than the plan holds, and never refusing a merchant who still has some.
 */
describe('reserving an amount nobody knows in advance', () => {
  let businessId: string;

  beforeEach(async () => {
    businessId = await seedBusiness();
  });

  const reserve = (allowance: number, want: number) =>
    withBusiness(db, businessId, (tx) =>
      usageRepo.reserveUpTo(tx, businessId, PERIOD, 'VOICE_MINUTES', allowance, want),
    );

  const used = async () => {
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    return rows.find((row) => row.unit === 'VOICE_MINUTES')?.used ?? 0;
  };

  it('gives the whole ask when the allowance covers it', async () => {
    expect(await reserve(600, 120)).toBe(120);
    expect(await used()).toBe(120);
  });

  /* The case the all-or-nothing consume gets wrong: a merchant with eighty
   * seconds left, sending a twenty-second note, must not be refused. */
  it('gives what is left rather than refusing', async () => {
    expect(await reserve(600, 520)).toBe(520);
    expect(await reserve(600, 120)).toBe(80);
    expect(await used()).toBe(600);
  });

  it('gives nothing once the allowance is gone, and takes nothing', async () => {
    expect(await reserve(600, 600)).toBe(600);
    expect(await reserve(600, 120)).toBe(0);
    expect(await used()).toBe(600);
  });

  it('refuses a zero allowance without creating capacity', async () => {
    expect(await reserve(0, 120)).toBe(0);
    expect(await used()).toBe(0);
  });

  it('counts bought capacity toward the ceiling', async () => {
    await withBusiness(db, businessId, (tx) =>
      usageRepo.creditBonus(tx, businessId, PERIOD, 'VOICE_MINUTES', 100),
    );
    expect(await reserve(600, 700)).toBe(700);
    expect(await used()).toBe(700);
  });

  /**
   * The claim that matters, and the reason the clamp is recomputed inside a
   * locked row rather than in TypeScript: ten simultaneous voice notes
   * against six hundred seconds hand out six hundred seconds between them,
   * not six hundred each.
   */
  it('never hands out more than the allowance under concurrency', async () => {
    const granted = await Promise.all(Array.from({ length: 10 }, () => reserve(600, 120)));
    expect(granted.reduce((a, b) => a + b, 0)).toBe(600);
    expect(await used()).toBe(600);
  });

  it('gives back what the work did not need', async () => {
    expect(await reserve(600, 120)).toBe(120);
    await withBusiness(db, businessId, (tx) =>
      usageRepo.refundUnit(tx, businessId, PERIOD, 'VOICE_MINUTES', 120 - 17),
    );
    expect(await used()).toBe(17);
  });
});

/**
 * The vocabulary, enforced by the column rather than by the type system.
 *
 * `usage_counters.unit` is text with a CHECK, so TypeScript's UsageUnit is
 * only half the guard: a job written in SQL, a fixture, or a hand-run
 * correction can put anything in this column. The CHECK is what makes the
 * canonical seventeen the whole set the meter can hold, and the retired five
 * unwritable, so a half-applied deployment cannot leave a business metered
 * under two names for the same thing.
 */
describe('the metered vocabulary (spec 4.2)', () => {
  let businessId: string;

  beforeEach(async () => {
    businessId = await seedBusiness();
  });

  const write = (unit: string) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO usage_counters (business_id, period, unit, used)
        VALUES (${businessId}::uuid, ${PERIOD}, ${unit}, 1)
      `),
    );

  it('holds every one of the canonical seventeen', async () => {
    expect(USAGE_UNITS).toHaveLength(17);
    for (const unit of USAGE_UNITS) {
      await expect(write(unit), `${unit} is writable`).resolves.toBeDefined();
    }
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM usage_counters WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...rows][0]?.n).toBe(17);
  });

  it.each(['messages', 'voice_seconds', 'documents', 'documents_understood', 'orders'])(
    'refuses the retired name %s',
    async (retired) => {
      await expect(write(retired)).rejects.toThrow();
    },
  );

  it('refuses a name nobody has ever metered', async () => {
    await expect(write('TOKENS')).rejects.toThrow();
  });

  /**
   * The vocabulary migration switches row-level security off for the length
   * of its backfill, because `usage_counters` is FORCE ROW LEVEL SECURITY
   * and a migration has no `app.business_id` to pin: without that the UPDATE
   * matches zero rows and reports success. Switching it off is safe. Leaving
   * it off would put every business's meter in front of every other tenant,
   * and a migration that forgot the last line would look exactly like one
   * that did not. So the state is asserted rather than assumed.
   */
  it('still has row-level security enabled and forced after the backfill', async () => {
    const rows = await db.execute<{ enabled: boolean; forced: boolean }>(sql`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = 'usage_counters'
    `);
    expect([...rows][0]).toEqual({ enabled: true, forced: true });
  });

  /**
   * Voice is counted in seconds under a name that says minutes, so the two
   * halves have to be checked together: the plan sells sixty minutes, the
   * meter is handed three thousand six hundred, and a one hundred and
   * thirty-seven second voice note spends one hundred and thirty-seven of
   * them. Dividing at any point in that chain would either give a merchant
   * sixty times the voice they bought or a sixtieth of it.
   */
  it('spends voice a second at a time against a minute allowance', async () => {
    const allowance = allowanceFor('chat', 'VOICE_MINUTES');
    expect(allowance).toBe(3_600);

    const granted = await withBusiness(db, businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, PERIOD, 'VOICE_MINUTES', allowance, 137),
    );
    expect(granted).toBe(true);

    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(rows.find((row) => row.unit === 'VOICE_MINUTES')?.used).toBe(137);
  });
});
