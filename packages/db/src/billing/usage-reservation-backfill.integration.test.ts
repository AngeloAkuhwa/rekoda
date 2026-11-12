/**
 * OD-51.4 (migration 0216): a message that reserved a unit BEFORE the migration can still give it
 * back after it.
 *
 * The previous release recorded a reservation on the message's event as a unit name (optionally
 * with a quantity, "VOICE_MINUTES:7") and the counter row it was spent on. Refunds now need a
 * reservation, so the migration gives each recorded entry one and rewrites the stored handle to
 * carry it. This runs the migration's own SQL again over rows shaped as the old release left them.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { events, identity, usageRepo } from '../index.js';
import { MIGRATIONS_DIR } from '../migrate.js';
import { migrate, requireUrls, setPlanAsOwner, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let db: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (db = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const made = createDb(url, { max: 4 });
    set(made.db);
    closers.push(made.close);
  }
});

afterAll(async () => {
  for (const close of closers) await close();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function rerunMigration(): Promise<void> {
  const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await owner
      .unsafe(await readFile(join(MIGRATIONS_DIR, '0216_usage_meter_boundary.sql'), 'utf8'))
      .simple();
  } finally {
    await owner.end();
  }
}

async function paidBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348140000077');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await setPlanAsOwner(urls, business.id, { plan: 'chat' });
  return business.id;
}

/** An event as the previous release left it: units reserved, the counter already moved. */
async function oldReleaseEvent(
  businessId: string,
  units: string[],
  meters: Record<string, string>,
): Promise<string> {
  const recorded = await withBusiness(db, businessId, (tx) =>
    events.recordEvent(tx, {
      provider: 'meta',
      eventType: 'messages',
      externalId: `od51-${Math.random()}`,
      payload: {},
      businessId,
    }),
  );
  if (!recorded.isNew) throw new Error('event not recorded');
  await ownerDb.execute(sql`
    UPDATE external_events
       SET reserved_units = ${`{${units.join(',')}}`}::text[], reserved_meters = ${JSON.stringify(meters)}::jsonb,
           created_at = '2026-11-03T09:00:00Z'
     WHERE id = ${recorded.id}::uuid`);
  return recorded.id;
}

const setUsed = (businessId: string, period: string, unit: string, used: number) =>
  ownerDb.execute(sql`
    INSERT INTO usage_counters (business_id, period, unit, used)
    VALUES (${businessId}::uuid, ${period}, ${unit}, ${used})`);
const usedOf = async (businessId: string, period: string, unit: string) =>
  [
    ...(await ownerDb.execute<{ used: number }>(
      sql`SELECT used FROM usage_counters WHERE business_id = ${businessId}::uuid AND period = ${period} AND unit = ${unit}`,
    )),
  ][0]?.used;
const metersOf = async (eventId: string) =>
  [
    ...(await ownerDb.execute<{ m: Record<string, string> }>(
      sql`SELECT reserved_meters AS m FROM external_events WHERE id = ${eventId}::uuid`,
    )),
  ][0]!.m;
const reservations = async (businessId: string) => [
  ...(await ownerDb.execute<{ period: string; unit: string; quantity: number; refunded: number }>(
    sql`SELECT period, unit, quantity, refunded FROM usage_reservations WHERE business_id = ${businessId}::uuid ORDER BY unit`,
  )),
];

describe('reservations recorded before migration 0216 keep their way back (OD-51.4)', () => {
  it('gives each recorded unit a reservation on its own row, and changes no counter', async () => {
    const businessId = await paidBusiness();
    await setUsed(businessId, '2026-11', 'AI_ACTIONS', 3);
    await setUsed(businessId, '2026-11', 'VOICE_MINUTES', 20);
    /* The message unit names its row; the voice seconds predate the row being recorded, so they
     * were spent in the month the message arrived (3 November, Lagos). */
    const eventId = await oldReleaseEvent(businessId, ['AI_ACTIONS', 'VOICE_MINUTES:7'], {
      AI_ACTIONS: '2026-11',
    });

    await rerunMigration();

    const meters = await metersOf(eventId);
    expect(meters['AI_ACTIONS']).toMatch(/^2026-11#[0-9a-f-]{36}$/);
    expect(meters['VOICE_MINUTES']).toMatch(/^2026-11#[0-9a-f-]{36}$/);
    expect(await reservations(businessId)).toEqual([
      { period: '2026-11', unit: 'AI_ACTIONS', quantity: 1, refunded: 0 },
      { period: '2026-11', unit: 'VOICE_MINUTES', quantity: 7, refunded: 0 },
    ]);
    expect(await usedOf(businessId, '2026-11', 'AI_ACTIONS')).toBe(3);
    expect(await usedOf(businessId, '2026-11', 'VOICE_MINUTES')).toBe(20);
  });

  it('a retry after the migration gives the units back exactly once, through the application', async () => {
    const businessId = await paidBusiness();
    await setUsed(businessId, '2026-11', 'AI_ACTIONS', 3);
    await setUsed(businessId, '2026-11', 'VOICE_MINUTES', 20);
    const eventId = await oldReleaseEvent(businessId, ['AI_ACTIONS', 'VOICE_MINUTES:7'], {
      AI_ACTIONS: '2026-11',
      VOICE_MINUTES: '2026-11',
    });
    await rerunMigration();

    /* What the inbound-message handler does when a retry executes nothing. */
    const giveBack = () =>
      withBusiness(db, businessId, async (tx) => {
        const taken = await events.takeReservedUnits(tx, businessId, eventId);
        let returned = 0;
        for (const t of taken) {
          const [unit, quantity] = t.unit.split(':');
          returned += await usageRepo.refundUnit(
            tx,
            businessId,
            usageRepo.storedMeter(t.meter, '2026-12'),
            unit as usageRepo.UsageUnit,
            quantity ? Number(quantity) : 1,
          );
        }
        return returned;
      });
    expect(await giveBack()).toBe(8);
    expect(await giveBack()).toBe(0);
    expect(await usedOf(businessId, '2026-11', 'AI_ACTIONS')).toBe(2);
    expect(await usedOf(businessId, '2026-11', 'VOICE_MINUTES')).toBe(13);
  });

  it('a trial reservation keeps the trial row, and a second run adds nothing', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348140000078');
    const { id: businessId } = await identity.createBusinessWithOwner(db, {
      name: 'Bola Stores',
      businessType: null,
      ownerUserId: user.id,
    });
    await setUsed(businessId, 'TRIAL00', 'AI_ACTIONS', 2);
    const eventId = await oldReleaseEvent(businessId, ['AI_ACTIONS'], { AI_ACTIONS: 'TRIAL00' });

    await rerunMigration();
    const first = await metersOf(eventId);
    expect(first['AI_ACTIONS']).toMatch(/^TRIAL00#[0-9a-f-]{36}$/);

    await rerunMigration();
    expect(await metersOf(eventId)).toEqual(first);
    expect(await reservations(businessId)).toHaveLength(1);
    expect(await usedOf(businessId, 'TRIAL00', 'AI_ACTIONS')).toBe(2);
  });
});
