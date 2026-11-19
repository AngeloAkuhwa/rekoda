/**
 * Owner review of PR #432, item 5 (migration 0204): the cross-tenant event privilege is a READ.
 *
 * Migration 0130's `worker_reads_the_estate` had no `FOR` clause, so it let the worker credential
 * INSERT, UPDATE and DELETE any business's `external_events` rows with no tenant pin, and the generic
 * operator resolve used that to stamp any event resolved with no pin, no exception check and no
 * audit row. These tests run as the real worker role, on a live connection, and fail on 0130's
 * policy (each was run against it before 0204 was written).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { events, identity } from '../index.js';
import { migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 2 });
    set(db);
    closers.push(close);
  }
});
afterAll(async () => {
  for (const c of closers) await c();
});
beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function business(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+2348170000${String(seq).padStart(3, '0')}`,
  );
  return (
    await identity.createBusinessWithOwner(appDb, {
      name: 'Ada',
      businessType: null,
      ownerUserId: user.id,
    })
  ).id;
}

/** An event attributed to `businessId`, recorded as ingress records it (application credential). */
async function eventOf(businessId: string | null, error: string | null = null): Promise<string> {
  seq += 1;
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: 'charge.success',
    externalId: `evt-${seq}`,
    payload: { sealed: true },
    businessId: null,
  });
  if (!recorded.isNew) throw new Error('fixture event already existed');
  if (businessId) await events.attributeEvent(workerDb, recorded.id, businessId);
  if (error) {
    await ownerDb.execute(
      sql`UPDATE external_events SET processed_at = now(), error = ${error} WHERE id = ${recorded.id}::uuid`,
    );
  }
  return recorded.id;
}

const rowOf = async (id: string) =>
  [
    ...(await ownerDb.execute<{
      business_id: string | null;
      resolved_at: string | null;
      resolved_by: string | null;
      error: string | null;
      payload: unknown;
    }>(
      sql`SELECT business_id, resolved_at, resolved_by, error, payload FROM external_events WHERE id = ${id}::uuid`,
    )),
  ][0];

const state = (run: Promise<unknown>) =>
  run.then(
    () => 'allowed',
    (e: { cause?: { code?: string } }) => e.cause?.code ?? 'error',
  );

describe("the worker credential reads the estate but cannot write another business's events", () => {
  it('cannot re-point, resolve, rewrite or delete an attributed event, with or without its own pin', async () => {
    const victim = await business();
    const other = await business();
    const id = await eventOf(victim, 'unknown_reference');
    // Unpinned: the estate policy is SELECT only now; an UPDATE finds no row it may change.
    // Re-pointing is refused outright: the worker holds no UPDATE of business_id at all.
    expect(
      await state(
        workerDb.execute(
          sql`UPDATE external_events SET business_id = ${other}::uuid WHERE id = ${id}::uuid`,
        ),
      ),
    ).toBe('42501');
    expect(await events.attributeEvent(workerDb, id, other)).toBe(false);
    for (const change of [sql`error = NULL`, sql`processed_at = NULL`]) {
      const result = await workerDb.execute<{ id: string }>(
        sql`UPDATE external_events SET ${change} WHERE id = ${id}::uuid RETURNING id`,
      );
      expect([...result]).toHaveLength(0);
    }
    // Columns it never writes are refused outright, even under the business's own pin.
    expect(
      await state(
        withBusiness(workerDb, victim, (tx) =>
          tx.execute(
            sql`UPDATE external_events SET payload = '{"forged":true}'::jsonb WHERE id = ${id}::uuid`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await state(
        withBusiness(workerDb, victim, (tx) =>
          tx.execute(sql`UPDATE external_events SET resolved_at = now() WHERE id = ${id}::uuid`),
        ),
      ),
    ).toBe('42501');
    expect(
      await state(
        workerDb.execute(
          sql`UPDATE external_events SET resolved_at = now(), resolved_by = 'operator:mallory', resolution = 'gone' WHERE id = ${id}::uuid`,
        ),
      ),
    ).toBe('42501');
    expect(
      await state(workerDb.execute(sql`DELETE FROM external_events WHERE id = ${id}::uuid`)),
    ).toBe('42501');
    expect(
      await state(
        workerDb.execute(sql`
          INSERT INTO external_events (business_id, provider, event_type, external_id, payload, signature_valid)
          VALUES (${victim}::uuid, 'paystack', 'charge.success', 'forged', '{}'::jsonb, 1)`),
      ),
    ).toBe('42501');
    expect(await rowOf(id)).toMatchObject({
      business_id: victim,
      resolved_at: null,
      error: 'unknown_reference',
      payload: { sealed: true },
    });
  });

  it('still does its own work: attributes an unattributed event once and marks one processed', async () => {
    const owner = await business();
    const stray = await eventOf(null);
    expect(await events.attributeEvent(workerDb, stray, owner)).toBe(true);
    expect(await events.attributeEvent(workerDb, stray, await business())).toBe(false);
    // Only to a business that exists.
    const another = await eventOf(null);
    expect(
      await events.attributeEvent(workerDb, another, '2b0f9b6a-0000-4000-8000-000000000000'),
    ).toBe(false);
    const unmatched = await eventOf(null);
    await events.markProcessed(workerDb, unmatched, 'unknown_reference');
    const [row] = await ownerDb.execute<{ error: string | null; processed: boolean }>(
      sql`SELECT error, processed_at IS NOT NULL AS processed FROM external_events WHERE id = ${unmatched}::uuid`,
    );
    expect(row).toEqual({ error: 'unknown_reference', processed: true });
    // And it still reads every business's events (attribution and the exception queue need it).
    expect((await events.exceptionQueue(workerDb)).flagged.map((r) => r.id)).toEqual([unmatched]);
  });
});

describe("the operator resolve is pinned to the event's business and audited (ADR 0035 Amendment 2 rule 4)", () => {
  it("writes the resolution under the event's own business, with an audit row there and nowhere else", async () => {
    const a = await business();
    const b = await business();
    const id = await eventOf(a, 'foreign_reference');
    expect(
      await events.resolveExceptionAsOperator(appDb, workerDb, id, 'not ours', 'operator:ada'),
    ).toBe('resolved');
    expect(await rowOf(id)).toMatchObject({ business_id: a, resolved_by: 'operator:ada' });
    const audit = await ownerDb.execute<{
      business_id: string;
      actor: string;
      entity_id: string;
      action: string;
    }>(
      sql`SELECT business_id, actor, entity_id, action FROM audit_events WHERE action = 'exception_resolved'`,
    );
    expect([...audit]).toEqual([
      { business_id: a, actor: 'operator:ada', entity_id: id, action: 'exception_resolved' },
    ]);
    expect([...audit].some((r) => r.business_id === b)).toBe(false);
    // Once worked, it is gone: a second resolve finds no open exception.
    expect(
      await events.resolveExceptionAsOperator(appDb, workerDb, id, 'again', 'operator:bo'),
    ).toBe('not_found');
  });

  it('refuses a healthy (processed, unflagged) event: only an open exception can be resolved', async () => {
    const a = await business();
    const id = await eventOf(a);
    await withBusiness(appDb, a, (tx) => events.markProcessed(tx, id, null, a));
    expect(
      await events.resolveExceptionAsOperator(appDb, workerDb, id, 'tidy', 'operator:ada'),
    ).toBe('not_found');
    expect((await rowOf(id))?.resolved_at).toBeNull();
  });

  it('resolves an unattributed (stuck) event on the application credential; the event row is its record', async () => {
    const id = await eventOf(null);
    expect(
      await events.resolveExceptionAsOperator(appDb, workerDb, id, 'never ours', 'operator:ada'),
    ).toBe('resolved');
    expect(await rowOf(id)).toMatchObject({ business_id: null, resolved_by: 'operator:ada' });
  });
});
