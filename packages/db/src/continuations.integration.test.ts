/**
 * Conversational continuation state, in the database (migration 0154,
 * Build 6).
 *
 * Pins what the handler leans on: a continuation belongs to ONE member of
 * ONE business; the newest one wins; an expired one is absent to every read
 * and claim; a clarification is claimed exactly once with the predicates in
 * the UPDATE itself; it survives the process (a new connection, a new
 * client); and no column can hold a customer's name. Time is injected
 * (`now`), never slept.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CONTINUATION_TTL_SECONDS, type ContinuationState } from '@rekoda/core';
import {
  continuationsRepo,
  conversationsRepo,
  createDb,
  identity,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let app: Db;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const asApp = createDb(urls.app, { max: 10 });
  app = asApp.db;
  closeApp = asApp.close;
});

afterAll(async () => {
  await closeApp();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const TTL_MS = CONTINUATION_TTL_SECONDS * 1000;
/** An hour after the real clock: `created_at` is the database's real clock,
 * and a read requires the row to exist at its instant. Whole seconds. */
const OPENED = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000);
const at = (offsetMs: number) => new Date(OPENED.getTime() + offsetMs);

const PERIOD_QUESTION: ContinuationState = {
  kind: 'clarification',
  expects: 'period',
  topic: 'sales_summary',
};

let seq = 0;
async function seedBusiness(): Promise<{ businessId: string; ownerId: string }> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481600${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return { businessId: business.id, ownerId: user.id };
}

async function addMember(businessId: string, role = 'delegate'): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481700${String(seq).padStart(5, '0')}`);
  await identity.addMembership(app, businessId, user.id, role);
  return user.id;
}

async function message(businessId: string): Promise<string> {
  seq += 1;
  const n = seq;
  return withBusiness(app, businessId, async (tx) => {
    const recorded = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: 'a question',
      providerMessageId: `wamid.cont-${n}`,
    });
    return recorded.id;
  });
}

async function open(
  businessId: string,
  userId: string,
  state: ContinuationState = PERIOD_QUESTION,
  now: Date = OPENED,
) {
  const sourceMessageId = await message(businessId);
  return withBusiness(app, businessId, (tx) =>
    continuationsRepo.openContinuation(tx, { businessId, userId, sourceMessageId, state, now }),
  );
}

const current = (businessId: string, userId: string, now: Date) =>
  withBusiness(app, businessId, (tx) =>
    continuationsRepo.currentContinuation(tx, businessId, userId, { now }),
  );

const consume = (businessId: string, userId: string, id: string, now: Date, db: Db = app) =>
  withBusiness(db, businessId, (tx) =>
    continuationsRepo.consumeContinuation(tx, businessId, userId, id, { now }),
  );

async function states(businessId: string): Promise<string[]> {
  const rows = await withBusiness(app, businessId, (tx) =>
    tx.execute<{ state: string }>(sql`
      SELECT state FROM conversation_continuations WHERE business_id = ${businessId}::uuid
       ORDER BY insertion_seq`),
  );
  return [...rows].map((r) => r.state);
}

describe('the window is the constant, everywhere it is written', () => {
  it('the repository opens it CONTINUATION_TTL_SECONDS after now', async () => {
    const { businessId, ownerId } = await seedBusiness();
    await open(businessId, ownerId);
    const rows = await withBusiness(app, businessId, (tx) =>
      tx.execute<{ expires_at: string }>(sql`
        SELECT expires_at FROM conversation_continuations WHERE business_id = ${businessId}::uuid`),
    );
    expect(new Date([...rows][0]!.expires_at).getTime()).toBe(OPENED.getTime() + TTL_MS);
  });

  it('the migration default is the same number as the constant', () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../migrations/0154_conversation_continuations.sql', import.meta.url)),
      'utf8',
    );
    expect(migration).toContain(
      `DEFAULT (clock_timestamp() + interval '${CONTINUATION_TTL_SECONDS} seconds')`,
    );
  });
});

describe('a continuation belongs to one member of one business', () => {
  it('another member of the same business cannot read or consume it', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const delegateId = await addMember(businessId);
    const opened = await open(businessId, ownerId);

    expect(await current(businessId, delegateId, at(1000))).toBeNull();
    expect(await consume(businessId, delegateId, opened!.id, at(1000))).toBe(false);

    /* Still the owner's, untouched. */
    expect((await current(businessId, ownerId, at(1000)))?.state).toEqual(PERIOD_QUESTION);
    expect(await consume(businessId, ownerId, opened!.id, at(1000))).toBe(true);
  });

  it('a member retiring their own state leaves another member’s alone', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const delegateId = await addMember(businessId);
    await open(businessId, ownerId);
    await open(businessId, delegateId);

    await withBusiness(app, businessId, (tx) =>
      continuationsRepo.retireContinuations(tx, businessId, delegateId, { now: at(1000) }),
    );
    expect(await current(businessId, ownerId, at(1000))).not.toBeNull();
    expect(await current(businessId, delegateId, at(1000))).toBeNull();
  });

  it('another business cannot see or consume it, even naming its id and member', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const opened = await open(a.businessId, a.ownerId);

    /* Pinned to B, the tenant policy hides A's row whatever the predicates say. */
    const seen = await withBusiness(app, b.businessId, (tx) =>
      continuationsRepo.currentContinuation(tx, a.businessId, a.ownerId, { now: at(1000) }),
    );
    expect(seen).toBeNull();
    const claimed = await withBusiness(app, b.businessId, (tx) =>
      continuationsRepo.consumeContinuation(tx, a.businessId, a.ownerId, opened!.id, {
        now: at(1000),
      }),
    );
    expect(claimed).toBe(false);
    expect(await states(a.businessId)).toEqual(['open']);
  });
});

describe('expired is absent', () => {
  it('live strictly before expires_at, absent at the instant itself and after', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const opened = await open(businessId, ownerId);

    expect(await current(businessId, ownerId, at(TTL_MS - 1))).not.toBeNull();
    expect(await current(businessId, ownerId, at(TTL_MS))).toBeNull();
    expect(await consume(businessId, ownerId, opened!.id, at(TTL_MS))).toBe(false);
    expect(await consume(businessId, ownerId, opened!.id, at(TTL_MS + 60_000))).toBe(false);
  });

  it('is marked expired, not superseded, when the member next speaks', async () => {
    const { businessId, ownerId } = await seedBusiness();
    await open(businessId, ownerId);
    await withBusiness(app, businessId, (tx) =>
      continuationsRepo.retireContinuations(tx, businessId, ownerId, { now: at(TTL_MS + 1) }),
    );
    expect(await states(businessId)).toEqual(['expired']);
  });

  it('a reply cannot answer a question written after it was sent', async () => {
    const { businessId, ownerId } = await seedBusiness();
    await open(businessId, ownerId);
    /* `created_at` is the real clock: an instant before it sees nothing. */
    expect(await current(businessId, ownerId, new Date(Date.now() - 60_000))).toBeNull();
  });
});

describe('the newest wins', () => {
  it('opening a second continuation supersedes the first; only the newest is read', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const first = await open(businessId, ownerId);
    const second = await open(businessId, ownerId, {
      kind: 'clarification',
      expects: 'period',
      topic: 'expenses_summary',
    });

    expect(await states(businessId)).toEqual(['superseded', 'open']);
    const live = await current(businessId, ownerId, at(1000));
    expect(live?.id).toBe(second!.id);
    expect(live?.state).toMatchObject({ topic: 'expenses_summary' });
    /* The superseded one can never be claimed. */
    expect(await consume(businessId, ownerId, first!.id, at(1000))).toBe(false);
  });

  it('one open row per member is enforced by the database, not just the code', async () => {
    const { businessId, ownerId } = await seedBusiness();
    await open(businessId, ownerId);
    const sourceMessageId = await message(businessId);
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO conversation_continuations
            (business_id, user_id, source_message_id, kind, expects, topic)
          VALUES (${businessId}::uuid, ${ownerId}::uuid, ${sourceMessageId}::uuid,
                  'clarification', 'period', 'sales_summary')`),
      ),
    ).rejects.toThrow();
  });

  it('a replayed message opens nothing new', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const sourceMessageId = await message(businessId);
    const write = () =>
      withBusiness(app, businessId, (tx) =>
        continuationsRepo.openContinuation(tx, {
          businessId,
          userId: ownerId,
          sourceMessageId,
          state: PERIOD_QUESTION,
          now: OPENED,
        }),
      );
    const first = await write();
    const again = await write();
    expect(first?.isNew).toBe(true);
    expect(again).toEqual({ id: first!.id, isNew: false });
  });
});

describe('a clarification is answered once', () => {
  it('two concurrent claims on separate connections: exactly one wins', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const opened = await open(businessId, ownerId);

    const second = createDb(urls.app, { max: 2 });
    try {
      const results = await Promise.all([
        consume(businessId, ownerId, opened!.id, at(1000), app),
        consume(businessId, ownerId, opened!.id, at(1000), second.db),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      await second.close();
    }
    expect(await states(businessId)).toEqual(['consumed']);
    /* Consumed is final: never answered again, never open again. */
    expect(await current(businessId, ownerId, at(2000))).toBeNull();
    expect(await consume(businessId, ownerId, opened!.id, at(2000))).toBe(false);
  });

  it('many racing claims across many questions: one winner each', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const members = [ownerId, ...(await Promise.all([1, 2, 3].map(() => addMember(businessId))))];
    const opened = await Promise.all(members.map((m) => open(businessId, m)));
    const results = await Promise.all(
      members.flatMap((m, i) =>
        [0, 1, 2, 3].map(async () => ({
          i,
          won: await consume(businessId, m, opened[i]!.id, at(1000)),
        })),
      ),
    );
    for (let i = 0; i < members.length; i += 1) {
      expect(results.filter((r) => r.i === i && r.won)).toHaveLength(1);
    }
  });
});

describe('typed state, and durable', () => {
  it('stores an explicit numbered list exactly as it was shown', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const list: ContinuationState = {
      kind: 'clarification',
      expects: 'choice',
      topic: 'customer_balance',
      options: [
        { ordinal: 1, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000001' } },
        { ordinal: 2, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000004' } },
      ],
    };
    await open(businessId, ownerId, list);
    expect((await current(businessId, ownerId, at(1000)))?.state).toEqual(list);
  });

  it('survives the process: a brand new client reads what another wrote', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const query: ContinuationState = {
      kind: 'query',
      topic: 'customer_balance',
      period: null,
      customerToken: 'CUSTOMER_7K2',
      documentRef: null,
    };
    await open(businessId, ownerId, query);

    const fresh = createDb(urls.app, { max: 1 });
    try {
      const seen = await withBusiness(fresh.db, businessId, (tx) =>
        continuationsRepo.currentContinuation(tx, businessId, ownerId, { now: at(1000) }),
      );
      expect(seen?.state).toEqual(query);
    } finally {
      await fresh.close();
    }
  });

  it('the database refuses a customer name, a free-text period or an unknown topic', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const insert = async (columns: ReturnType<typeof sql>) => {
      const sourceMessageId = await message(businessId);
      return withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO conversation_continuations
            (business_id, user_id, source_message_id, kind, topic, customer_token, period)
          VALUES (${businessId}::uuid, ${ownerId}::uuid, ${sourceMessageId}::uuid, 'query', ${columns})`),
      );
    };
    await expect(insert(sql`'customer_balance', 'Ada Obi', NULL`)).rejects.toThrow();
    await expect(insert(sql`'sales_summary', NULL, 'the month Ada paid'`)).rejects.toThrow();
    await expect(insert(sql`'transfer_money', NULL, NULL`)).rejects.toThrow();
    /* And the repository refuses before the database has to. */
    const sourceMessageId = await message(businessId);
    await expect(
      withBusiness(app, businessId, (tx) =>
        continuationsRepo.openContinuation(tx, {
          businessId,
          userId: ownerId,
          sourceMessageId,
          state: {
            kind: 'query',
            topic: 'customer_balance',
            period: null,
            customerToken: 'Ada Obi',
            documentRef: null,
          },
        }),
      ),
    ).rejects.toThrow(/vault token/);
  });

  it('the application can retire a row but never delete one', async () => {
    const { businessId, ownerId } = await seedBusiness();
    await open(businessId, ownerId);
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(
          sql`DELETE FROM conversation_continuations WHERE business_id = ${businessId}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });
});
