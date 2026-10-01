/**
 * A preview is a question with a time limit (G-23, migration 0153).
 *
 * A draft may execute only while `state = 'pending' AND now < expires_at`,
 * and the claim ITSELF carries that predicate: there is no read of the age
 * followed by a write that trusts it. These pin the window, its boundary,
 * the one-way transition to `expired`, races on both sides of the boundary,
 * that a redelivered message never reopens a window, that the lazy expiry
 * touches only what it should, and that the migration's number is the
 * constant's.
 *
 * Time is injected (`now`), never slept: the boundary is an instant, and a
 * test that waits five minutes proves nothing a clock it controls cannot.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CONFIRMATION_TTL_SECONDS } from '@rekoda/core';
import {
  conversationsRepo,
  createDb,
  identity,
  withBusiness,
  type Db,
  type TenantDb,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let owner: Db;
let app: Db;
let closeOwner: () => Promise<void>;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const asOwner = createDb(urls.owner, { max: 2 });
  owner = asOwner.db;
  closeOwner = asOwner.close;
  const asApp = createDb(urls.app, { max: 10 });
  app = asApp.db;
  closeApp = asApp.close;
});

afterAll(async () => {
  await closeApp();
  await closeOwner();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const TTL_MS = CONFIRMATION_TTL_SECONDS * 1000;
/**
 * The instant every window below opens at: pinned, but an hour AFTER the
 * real clock, never a calendar date. A claim requires the draft to exist at
 * its instant (`created_at <= now`), and `created_at` is the database's real
 * clock, so a fixed date would turn these into failures once the day passed
 * it. Whole seconds, so the arithmetic below stays exact.
 */
const OPENED = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000);
const CLOSES = new Date(OPENED.getTime() + TTL_MS);
const at = (offsetMs: number) => new Date(CLOSES.getTime() + offsetMs);

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481500${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** One draft through the real path, its window opened at `now`. */
async function draftAt(
  businessId: string,
  note: string,
  /* null: no injected clock, the database decides. */
  now: Date | null = OPENED,
): Promise<{ id: string; isNew: boolean; messageId: string }> {
  return withBusiness(app, businessId, async (tx: TenantDb) => {
    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: `msg ${note}`,
      providerMessageId: `wamid.EXP.${businessId.slice(0, 8)}.${note}`,
    });
    const draft = await conversationsRepo.recordDraft(tx, {
      businessId,
      conversationMessageId: message.id,
      intent: 'RecordSale',
      command: { intent: 'RecordSale', note },
      model: null,
      ...(now ? { now } : {}),
    });
    return { ...draft, messageId: message.id };
  });
}

async function rowOf(draftId: string) {
  const rows = await owner.execute<{ state: string; expires_at: Date; updated_at: Date }>(
    sql`SELECT state, expires_at, updated_at FROM command_drafts WHERE id = ${draftId}::uuid`,
  );
  const found = [...rows][0];
  if (!found) throw new Error('draft not found');
  return {
    ...found,
    expires_at: new Date(found.expires_at),
    updated_at: new Date(found.updated_at),
  };
}

const claim = (businessId: string, draftId: string, now: Date) =>
  withBusiness(app, businessId, (tx) => conversationsRepo.claimDraft(tx, draftId, { now }));

describe('the window is the constant, everywhere it is written', () => {
  it('a new draft closes exactly CONFIRMATION_TTL_SECONDS after it opens', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'window');
    expect((await rowOf(draft.id)).expires_at.toISOString()).toBe(CLOSES.toISOString());
  });

  it('on the database clock, a new draft closes TTL after it was created', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'db-clock', null);
    const rows = await owner.execute<{ gap: number }>(sql`
      SELECT extract(epoch FROM expires_at - created_at)::float8 AS gap
        FROM command_drafts WHERE id = ${draft.id}::uuid`);
    /* Same statement, same clock: within a millisecond of exactly the TTL. */
    expect([...rows][0]!.gap).toBeGreaterThan(CONFIRMATION_TTL_SECONDS - 0.001);
    expect([...rows][0]!.gap).toBeLessThan(CONFIRMATION_TTL_SECONDS + 0.001);
  });

  it('the column default and the migration name the same number as the constant', async () => {
    const rows = await owner.execute<{ def: string }>(sql`
      SELECT column_default AS def FROM information_schema.columns
       WHERE table_name = 'command_drafts' AND column_name = 'expires_at'`);
    const minutes = CONFIRMATION_TTL_SECONDS / 60;
    expect([...rows][0]!.def).toBe(
      `(clock_timestamp() + '00:${String(minutes).padStart(2, '0')}:00'::interval)`,
    );
    const file = readFileSync(
      fileURLToPath(new URL('../migrations/0153_command_draft_expiry.sql', import.meta.url)),
      'utf8',
    );
    const intervals = file.match(/interval '(\d+) seconds'/g) ?? [];
    /* The backfill and the default, and nothing else. */
    expect(intervals).toEqual([
      `interval '${CONFIRMATION_TTL_SECONDS} seconds'`,
      `interval '${CONFIRMATION_TTL_SECONDS} seconds'`,
    ]);
  });

  it('expired is a state of its own, beside the four that existed', async () => {
    const rows = await owner.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'command_drafts_state_check'`);
    for (const state of ['pending', 'superseded', 'confirmed', 'abandoned', 'expired']) {
      expect([...rows][0]!.def).toContain(`'${state}'`);
    }
  });
});

describe('the boundary is an instant: valid iff now < expires_at', () => {
  it('one millisecond before the window closes, the claim succeeds', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'before');
    expect(await claim(businessId, draft.id, at(-1))).toEqual({ outcome: 'claimed' });
    expect((await rowOf(draft.id)).state).toBe('confirmed');
  });

  it('at the instant the window closes, the draft has expired', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'exactly');
    expect(await claim(businessId, draft.id, at(0))).toEqual({ outcome: 'expired' });
    expect((await rowOf(draft.id)).state).toBe('expired');
  });

  it('after the window closes, the draft has expired', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'after');
    expect(await claim(businessId, draft.id, at(3 * 86_400_000))).toEqual({ outcome: 'expired' });
    expect((await rowOf(draft.id)).state).toBe('expired');
  });
});

describe('expiry is one-way and happens once', () => {
  it('an expired draft never becomes confirmed, even with a clock that says it is fresh', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'one-way');
    expect(await claim(businessId, draft.id, at(1))).toEqual({ outcome: 'expired' });
    const first = await rowOf(draft.id);

    /* A later claim, whatever its clock, finds it expired and changes nothing. */
    expect(await claim(businessId, draft.id, at(-60_000))).toEqual({ outcome: 'expired' });
    expect(await claim(businessId, draft.id, at(1))).toEqual({ outcome: 'expired' });
    const after = await rowOf(draft.id);
    expect(after.state).toBe('expired');
    expect(after.updated_at.getTime()).toBe(new Date(first.updated_at).getTime());
  });

  it('a confirmed draft is not_pending to a second claim, never expired', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'confirmed');
    expect(await claim(businessId, draft.id, at(-1))).toEqual({ outcome: 'claimed' });
    expect(await claim(businessId, draft.id, at(60_000))).toEqual({ outcome: 'not_pending' });
    expect((await rowOf(draft.id)).state).toBe('confirmed');
  });

  it('a corrected (superseded) draft is not_pending, and stays superseded past its window', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'corrected');
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.supersedePendingDrafts(tx, businessId),
    );
    expect(await claim(businessId, draft.id, at(60_000))).toEqual({ outcome: 'not_pending' });
    expect((await rowOf(draft.id)).state).toBe('superseded');
  });
});

describe('races, on both sides of the boundary', () => {
  it('eight claims inside the window: exactly one wins', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'race-before');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claim(businessId, draft.id, at(-1))),
    );
    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'not_pending')).toHaveLength(7);
    expect((await rowOf(draft.id)).state).toBe('confirmed');
  });

  it('eight claims after the window: none wins, every one is told it expired', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'race-after');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claim(businessId, draft.id, at(0))),
    );
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ outcome: 'expired' })));
    expect((await rowOf(draft.id)).state).toBe('expired');
  });

  it('claims racing across the boundary: the database decides, and never both ways', async () => {
    for (let round = 0; round < 6; round += 1) {
      const businessId = await seedBusiness();
      const draft = await draftAt(businessId, `race-edge-${round}`);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => claim(businessId, draft.id, at(i % 2 ? 0 : -1))),
      );
      const claimed = results.filter((r) => r.outcome === 'claimed').length;
      const expired = results.filter((r) => r.outcome === 'expired').length;
      const { state } = await rowOf(draft.id);
      /* Either one fresh claim won and everyone after it lost to a confirmed
       * draft, or an expired claim landed first and nobody ever confirmed. */
      if (claimed === 1) {
        expect(state).toBe('confirmed');
        expect(expired).toBe(0);
      } else {
        expect(claimed).toBe(0);
        expect(state).toBe('expired');
        expect(expired).toBe(8);
      }
    }
  });
});

describe('a redelivered message never reopens a window', () => {
  it('recordDraft for the same message keeps the window its first delivery opened', async () => {
    const businessId = await seedBusiness();
    const first = await draftAt(businessId, 'replay');
    const replayed = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: first.messageId,
        intent: 'RecordSale',
        command: { intent: 'RecordSale', note: 'replay' },
        model: null,
        now: new Date(OPENED.getTime() + 2 * 86_400_000),
      }),
    );
    expect(replayed).toMatchObject({ id: first.id, isNew: false });
    expect((await rowOf(first.id)).expires_at.toISOString()).toBe(CLOSES.toISOString());
    /* And so a claim two days later is still refused. */
    expect(await claim(businessId, first.id, at(2 * 86_400_000))).toEqual({ outcome: 'expired' });
  });
});

describe('the lazy expiry touches only lapsed pending drafts, of this business only', () => {
  it('expires what has lapsed and leaves everything else exactly as it was', async () => {
    const businessId = await seedBusiness();
    const stale = await draftAt(businessId, 'stale', OPENED);
    const fresh = await draftAt(businessId, 'fresh', new Date(OPENED.getTime() + 60_000));
    const confirmed = await draftAt(businessId, 'confirmed', OPENED);
    const retired = await draftAt(businessId, 'retired', OPENED);
    expect(await claim(businessId, confirmed.id, at(-1))).toEqual({ outcome: 'claimed' });
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.retireDraft(tx, businessId, retired.id),
    );
    const theirs = await seedBusiness();
    const theirStale = await draftAt(theirs, 'their-stale', OPENED);

    /* One second after the first window closes: the fresh one has 59 left. */
    const expired = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.expireStaleDrafts(tx, businessId, { now: at(1000) }),
    );
    expect(expired).toBe(1);
    expect((await rowOf(stale.id)).state).toBe('expired');
    expect((await rowOf(fresh.id)).state).toBe('pending');
    expect((await rowOf(confirmed.id)).state).toBe('confirmed');
    /* A retired G-61 question is not a window, and is never "expired". */
    expect((await rowOf(retired.id)).state).toBe('abandoned');
    expect((await rowOf(theirStale.id)).state).toBe('pending');

    /* Run again: nothing left to do. */
    expect(
      await withBusiness(app, businessId, (tx) =>
        conversationsRepo.expireStaleDrafts(tx, businessId, { now: at(1000) }),
      ),
    ).toBe(0);
  });

  it('the latest draft in any state still names an expired preview as the last thing shown', async () => {
    const businessId = await seedBusiness();
    await draftAt(businessId, 'older', OPENED);
    const newest = await draftAt(businessId, 'newest', OPENED);
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.expireStaleDrafts(tx, businessId, { now: at(0) }),
    );
    const latest = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.latestDraft(tx, businessId),
    );
    expect(latest).toMatchObject({ id: newest.id, state: 'expired' });
    /* And no pending draft is left behind it to fall through to. */
    expect(
      await withBusiness(app, businessId, (tx) => conversationsRepo.pendingDraft(tx, businessId)),
    ).toBeNull();
  });
});

describe('the migration, run as it ships, against drafts written before it', () => {
  /**
   * Put the table back the way 0152 left it, write drafts the old code would
   * have written, run 0153 verbatim, and read the result. All in ONE
   * transaction on the owner connection, so a failure leaves the schema
   * exactly as it was (PostgreSQL DDL is transactional).
   */
  it('gives every existing draft created_at + TTL, keeps its state, and an old pending one is refused', async () => {
    const businessId = await seedBusiness();
    const seeded = [
      ['pending', '2026-09-01T10:00:00.000Z'],
      ['confirmed', '2026-09-02T11:30:00.000Z'],
      ['superseded', '2026-09-03T12:45:00.000Z'],
      ['abandoned', '2026-09-04T13:15:00.000Z'],
    ] as const;
    /* One draft per message, so each old draft gets a message of its own. */
    const messageIds = await withBusiness(app, businessId, async (tx: TenantDb) => {
      const ids: string[] = [];
      for (const [state] of seeded) {
        const m = await conversationsRepo.recordInbound(tx, {
          businessId,
          channel: 'meta',
          kind: 'text',
          body: `old ${state}`,
          providerMessageId: `wamid.OLD.${businessId.slice(0, 8)}.${state}`,
        });
        ids.push(m.id);
      }
      return ids;
    });
    const file = readFileSync(
      fileURLToPath(new URL('../migrations/0153_command_draft_expiry.sql', import.meta.url)),
      'utf8',
    );
    const client = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      await client.begin(async (tx) => {
        await tx.unsafe(`
          ALTER TABLE command_drafts DROP CONSTRAINT command_drafts_state_check;
          ALTER TABLE command_drafts ADD CONSTRAINT command_drafts_state_check
            CHECK (state IN ('pending', 'superseded', 'confirmed', 'abandoned'));
          ALTER TABLE command_drafts DROP COLUMN expires_at;
          ALTER TABLE command_drafts DROP COLUMN previewed;
          ALTER TABLE external_events DROP COLUMN reserved_units;`);
        for (const [i, [state, createdAt]] of seeded.entries()) {
          await tx`
            INSERT INTO command_drafts
              (business_id, conversation_message_id, intent, command, state, created_at)
            VALUES (${businessId}::uuid, ${messageIds[i]!}::uuid, 'RecordSale', '{}'::jsonb,
                    ${state}, ${createdAt}::timestamptz)`;
        }
        await tx.unsafe(file);
      });
    } finally {
      await client.end();
    }

    const rows = [
      ...(await owner.execute<{ id: string; state: string; created: string; expires: string }>(sql`
        SELECT id, state, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS created,
               to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS expires
          FROM command_drafts WHERE business_id = ${businessId}::uuid ORDER BY created_at`)),
    ];
    /* Deterministic: exactly five minutes after each one was written, and
     * every state as it was. */
    expect(rows.map(({ state, created, expires }) => ({ state, created, expires }))).toEqual([
      { state: 'pending', created: '2026-09-01 10:00:00', expires: '2026-09-01 10:05:00' },
      { state: 'confirmed', created: '2026-09-02 11:30:00', expires: '2026-09-02 11:35:00' },
      { state: 'superseded', created: '2026-09-03 12:45:00', expires: '2026-09-03 12:50:00' },
      { state: 'abandoned', created: '2026-09-04 13:15:00', expires: '2026-09-04 13:20:00' },
    ]);

    /* No old draft is claimed to have been a preview: that was never recorded. */
    const flags = await owner.execute<{ previewed: boolean }>(sql`
      SELECT previewed FROM command_drafts WHERE business_id = ${businessId}::uuid`);
    expect([...flags].map((r) => r.previewed)).toEqual([false, false, false, false]);

    /* A preview left pending before this release cannot be confirmed by a
     * "yes" now, on the real clock. */
    const oldPending = rows[0]!;
    expect(
      await withBusiness(app, businessId, (tx) => conversationsRepo.claimDraft(tx, oldPending.id)),
    ).toEqual({ outcome: 'expired' });
  });
});

describe('a message acts only on drafts that existed when it arrived', () => {
  it('a claim, a pending lookup and the latest lookup at an instant before the draft see nothing', async () => {
    const businessId = await seedBusiness();
    const draft = await draftAt(businessId, 'later', null);
    const before = new Date(Date.now() - 60_000);

    expect(await claim(businessId, draft.id, before)).toEqual({ outcome: 'not_pending' });
    expect((await rowOf(draft.id)).state).toBe('pending');
    const seen = await withBusiness(app, businessId, async (tx) => ({
      pending: await conversationsRepo.pendingDraft(tx, businessId, { asOf: before }),
      latest: await conversationsRepo.latestDraft(tx, businessId, { asOf: before }),
      superseded: await conversationsRepo.supersedePendingDrafts(tx, businessId, { asOf: before }),
    }));
    expect(seen).toEqual({ pending: null, latest: null, superseded: 0 });
    expect((await rowOf(draft.id)).state).toBe('pending');

    /* And the same draft, seen from now, is there and claimable. */
    expect(await claim(businessId, draft.id, new Date())).toEqual({ outcome: 'claimed' });
  });
});
