/**
 * G-119 / OWN-77 (PR B item 6; migration 0197): the database half of the staging tools.
 *
 * Nothing acts on a database without the staging marker, nothing acts on a business that is not a
 * designated test business, date moves go through the OD-37 sanctioned writer with a compare-before
 * value and 90-day bounds, every action is audited append-only, a revert is compare-and-revert and
 * happens once, and an armed send fault is consumed by exactly one send.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { identity, stagingToolsRepo, subscriptionsRepo } from '../index.js';
import { applyFixtureCycle, migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];
const DAY = 86_400_000;
const OPERATOR = 'operator:alice@rekoda.app';

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 4 });
    set(db);
    closers.push(close);
  }
});

afterAll(async () => {
  for (const close of closers) await close();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const markStaging = () =>
  ownerDb.execute(sql`INSERT INTO staging_environment (marked_by) VALUES ('owner:test')`);

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23480700000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Test Shop',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const designate = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    stagingToolsRepo.designateTestBusiness(tx, {
      businessId,
      operator: OPERATOR,
      reason: 'acceptance walkthrough 22',
    }),
  );

const current = (businessId: string, field: stagingToolsRepo.StagingDateField = 'trial_end') =>
  withBusiness(appDb, businessId, (tx) => stagingToolsRepo.currentDate(tx, businessId, field));

const move = (
  businessId: string,
  input: {
    field?: stagingToolsRepo.StagingDateField;
    expected: Date | null;
    to: Date;
    reverts?: string;
  },
) =>
  withBusiness(appDb, businessId, (tx) =>
    stagingToolsRepo.moveDate(tx, {
      businessId,
      field: input.field ?? 'trial_end',
      expected: input.expected,
      to: input.to,
      operator: OPERATOR,
      reason: 'walkthrough step',
      ...(input.reverts ? { reverts: input.reverts } : {}),
    }),
  );

/** The Postgres error behind drizzle's wrapper, or 'allowed'. */
const outcome = (run: Promise<unknown>) =>
  run.then(
    () => 'allowed',
    (error: { cause?: { message?: string; code?: string } }) =>
      `${error.cause?.code ?? ''} ${error.cause?.message ?? String(error)}`,
  );

const actions = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => stagingToolsRepo.actionsFor(tx, businessId));

describe('OWN-77: without the staging marker nothing acts', () => {
  it('refuses designation, date moves and faults, and writes nothing', async () => {
    const businessId = await seedBusiness();
    expect(await designate(businessId)).toBe('not_staging');
    const before = await current(businessId);
    expect(
      await outcome(move(businessId, { expected: before!.value, to: new Date(Date.now() + DAY) })),
    ).toMatch(/not marked as staging/);
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        stagingToolsRepo.armFault(tx, {
          businessId,
          kind: 'send_timeout',
          operator: OPERATOR,
          reason: 'step 19',
        }),
      ),
    ).toBe('not_staging');
    expect(await current(businessId)).toEqual(before);
    expect(await actions(businessId)).toEqual([]);
  });

  it('the marker is the owner’s alone: neither application role can write it', async () => {
    for (const db of [appDb, workerDb]) {
      expect(
        await outcome(db.execute(sql`INSERT INTO staging_environment (marked_by) VALUES ('me')`)),
      ).toMatch(/permission denied/);
    }
  });
});

describe('OWN-77: on a staging database', () => {
  beforeEach(markStaging);

  it('refuses a business that is not designated', async () => {
    const businessId = await seedBusiness();
    const before = await current(businessId);
    expect(
      await outcome(move(businessId, { expected: before!.value, to: new Date(Date.now() + DAY) })),
    ).toMatch(/not a designated test business/);
    expect(await current(businessId)).toEqual(before);
  });

  it('moves a designated trial’s end, audited with operator, before, after, reason and outcome', async () => {
    const businessId = await seedBusiness();
    expect(await designate(businessId)).toBe('designated');
    expect(await designate(businessId)).toBe('already');
    const before = await current(businessId);
    const to = new Date(Date.now() - DAY);

    const actionId = await move(businessId, { expected: before!.value, to });

    expect((await current(businessId))?.value?.toISOString()).toBe(to.toISOString());
    const log = await actions(businessId);
    expect(log.map((a) => a.action)).toEqual(['move_date', 'designate']);
    expect(log[0]).toMatchObject({
      id: actionId,
      operator: OPERATOR,
      field: 'trial_end',
      reason: 'walkthrough step',
      outcome: 'applied',
    });
    expect(log[0]?.before?.toISOString()).toBe(before!.value!.toISOString());
    expect(log[0]?.after?.toISOString()).toBe(to.toISOString());
  });

  it('refuses a stale compare-before value, a value past 90 days, and a field that does not fit the plan', async () => {
    const businessId = await seedBusiness();
    await designate(businessId);
    const before = await current(businessId);

    expect(
      await outcome(move(businessId, { expected: new Date(0), to: new Date(Date.now() + DAY) })),
    ).toMatch(/^40001 .*changed since it was read/);
    expect(
      await outcome(
        move(businessId, { expected: before!.value, to: new Date(Date.now() + 91 * DAY) }),
      ),
    ).toMatch(/within 90 days/);
    expect(
      await outcome(
        move(businessId, { expected: before!.value, to: new Date(Date.now() - 91 * DAY) }),
      ),
    ).toMatch(/within 90 days/);
    expect(
      await outcome(
        move(businessId, { field: 'paid_to', expected: before!.value, to: new Date() }),
      ),
    ).toMatch(/paid_to needs a dated paid plan/);
    expect(
      await outcome(move(businessId, { field: 'grace_clock', expected: null, to: new Date() })),
    ).toMatch(/grace_clock needs a renewal in grace/);
    expect(await current(businessId)).toEqual(before);
    expect((await actions(businessId)).map((a) => a.action)).toEqual(['designate']);
  });

  it('moves a paid plan’s paid-to date through the OD-37 writer, and a grace clock', async () => {
    const businessId = await seedBusiness();
    const renewsAt = new Date(Date.now() + 20 * DAY);
    await withBusiness(appDb, businessId, (tx) =>
      applyFixtureCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: new Date(Date.now() - 10 * DAY),
        renewsAt,
        anchorDay: renewsAt.getUTCDate(),
      }),
    );
    await designate(businessId);
    const to = new Date(Date.now() - 2 * DAY);
    await move(businessId, { field: 'paid_to', expected: renewsAt, to });
    expect((await current(businessId, 'paid_to'))?.value?.toISOString()).toBe(to.toISOString());

    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.markRenewalFailed(tx, businessId, to),
    );
    const graceTo = new Date(Date.now() - 8 * DAY);
    await move(businessId, { field: 'grace_clock', expected: to, to: graceTo });
    expect((await current(businessId, 'grace_clock'))?.value?.toISOString()).toBe(
      graceTo.toISOString(),
    );
  });

  it('reverts a move only while the value is what the move wrote, and only once', async () => {
    const businessId = await seedBusiness();
    await designate(businessId);
    const before = (await current(businessId))!.value!;
    const to = new Date(Date.now() - DAY);
    const moved = await move(businessId, { expected: before, to });

    // Compare-and-revert: expected is what the move wrote, the target is what it replaced.
    await move(businessId, { expected: to, to: before, reverts: moved });
    expect((await current(businessId))?.value?.toISOString()).toBe(before.toISOString());

    expect(
      await outcome(move(businessId, { expected: before, to: before, reverts: moved })),
    ).toMatch(/not a revert of that move|duplicate key/);
    const log = await actions(businessId);
    expect(log.filter((a) => a.action === 'revert_date')).toHaveLength(1);
  });

  it('reverts a move of a date that was unset back to unset', async () => {
    const businessId = await seedBusiness();
    await designate(businessId);
    await ownerDb.execute(
      sql`UPDATE businesses SET plan_expires_at = NULL WHERE id = ${businessId}::uuid`,
    );
    const to = new Date(Date.now() + DAY);
    const moved = await move(businessId, { expected: null, to });
    await withBusiness(appDb, businessId, (tx) =>
      stagingToolsRepo.moveDate(tx, {
        businessId,
        field: 'trial_end',
        expected: to,
        to: null,
        operator: OPERATOR,
        reason: 'cleanup',
        reverts: moved,
      }),
    );
    expect((await current(businessId))?.value).toBeNull();
  });

  it('a date stored with microseconds matches its millisecond read, and reverts exactly', async () => {
    const businessId = await seedBusiness();
    await designate(businessId);
    await ownerDb.execute(
      sql`UPDATE businesses SET plan_expires_at = '2026-12-01T10:00:00.123456Z' WHERE id = ${businessId}::uuid`,
    );
    const read = (await current(businessId))!.value!;
    const to = new Date(Date.now() + DAY);
    const moved = await move(businessId, { expected: read, to });
    await move(businessId, { expected: to, to: read, reverts: moved });
    const exact = await ownerDb.execute<{ v: string }>(
      sql`SELECT to_char(plan_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS v
          FROM businesses WHERE id = ${businessId}::uuid`,
    );
    expect([...exact][0]?.v).toBe('2026-12-01T10:00:00.123456');
  });

  it('a revert refuses a value changed within the same millisecond as the move wrote', async () => {
    const businessId = await seedBusiness();
    await designate(businessId);
    const read = (await current(businessId))!.value!;
    const to = new Date(Date.now() + DAY);
    const moved = await move(businessId, { expected: read, to });
    const nudged = new Date(to.getTime()).toISOString().replace('Z', '456Z');
    await ownerDb.execute(
      sql`UPDATE businesses SET plan_expires_at = ${nudged}::timestamptz WHERE id = ${businessId}::uuid`,
    );
    expect(await outcome(move(businessId, { expected: to, to: read, reverts: moved }))).toMatch(
      /value changed/,
    );
  });

  it('another business cannot move this business’s dates', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await designate(a);
    await designate(b);
    const before = await current(a);
    expect(
      await outcome(
        withBusiness(appDb, b, (tx) =>
          stagingToolsRepo.moveDate(tx, {
            businessId: a,
            field: 'trial_end',
            expected: before!.value,
            to: new Date(),
            operator: OPERATOR,
            reason: 'cross-tenant attempt',
          }),
        ),
      ),
    ).toMatch(/not the pinned tenant/);
    expect(await current(a)).toEqual(before);
  });

  it('the audit log is append-only for the application', async () => {
    const businessId = await seedBusiness();
    await designate(businessId);
    for (const statement of [
      sql`UPDATE staging_tool_actions SET outcome = 'erased'`,
      sql`DELETE FROM staging_tool_actions`,
      sql`DELETE FROM staging_test_businesses`,
    ]) {
      expect(await outcome(withBusiness(appDb, businessId, (tx) => tx.execute(statement)))).toMatch(
        /permission denied/,
      );
    }
  });

  it('the application cannot plant a move row that a revert would trust', async () => {
    const businessId = await seedBusiness();
    await designate(businessId);
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(sql`
            INSERT INTO staging_tool_actions
              (business_id, operator, action, field, before_value, after_value, reason, outcome)
            VALUES (${businessId}::uuid, 'operator:x', 'move_date', 'trial_end',
                    now() + interval '2 years', now(), 'planted', 'applied')`),
        ),
      ),
    ).toMatch(/recorded only by staging_move_date/);
  });

  it('once the owner removes the marker, nothing acts again', async () => {
    const businessId = await seedBusiness();
    await designate(businessId);
    await ownerDb.execute(sql`DELETE FROM staging_environment`);
    const before = await current(businessId);
    expect(await outcome(move(businessId, { expected: before!.value, to: new Date() }))).toMatch(
      /not marked as staging/,
    );
  });
});

describe('OWN-77: one-shot send faults', () => {
  beforeEach(markStaging);

  const arm = (businessId: string, kind: stagingToolsRepo.StagingFaultKind = 'send_timeout') =>
    withBusiness(appDb, businessId, (tx) =>
      stagingToolsRepo.armFault(tx, { businessId, kind, operator: OPERATOR, reason: 'step 19' }),
    );
  const consume = (businessId: string) =>
    withBusiness(appDb, businessId, (tx) => stagingToolsRepo.consumeFault(tx, businessId));

  it('needs a designated business, arms one at a time, and is consumed by exactly one send', async () => {
    const businessId = await seedBusiness();
    expect(await arm(businessId)).toBe('not_test_business');
    await designate(businessId);
    expect(await arm(businessId)).toBe('armed');
    expect(await arm(businessId, 'sender_refused')).toBe('already_armed');

    expect(await consume(businessId)).toBe('send_timeout');
    expect(await consume(businessId)).toBeNull();
    expect((await actions(businessId)).map((a) => a.action)).toEqual([
      'consume_fault',
      'arm_fault',
      'designate',
    ]);
  });

  it('two sends racing for one armed fault: exactly one gets it', async () => {
    const businessId = await seedBusiness();
    await designate(businessId);
    await arm(businessId, 'sender_refused');
    const results = await Promise.all([
      consume(businessId),
      consume(businessId),
      consume(businessId),
    ]);
    expect(results.filter((r) => r === 'sender_refused')).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(2);
  });

  it('a fault armed for one business is never consumed by another', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await designate(a);
    await designate(b);
    await arm(a);
    expect(await consume(b)).toBeNull();
    expect(await consume(a)).toBe('send_timeout');
  });
});
