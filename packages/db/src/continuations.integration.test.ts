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
let owner: Db;
let closeApp: () => Promise<void>;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const asApp = createDb(urls.app, { max: 10 });
  app = asApp.db;
  closeApp = asApp.close;
  const asOwner = createDb(urls.owner, { max: 2 });
  owner = asOwner.db;
  closeOwner = asOwner.close;
});

afterAll(async () => {
  await closeApp();
  await closeOwner();
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

  it('a message received before a question was written does not retire it', async () => {
    const { businessId, ownerId } = await seedBusiness();
    await open(businessId, ownerId);
    /* `created_at` is the real clock; this message arrived a minute before. */
    const retired = await withBusiness(app, businessId, (tx) =>
      continuationsRepo.retireContinuations(tx, businessId, ownerId, {
        now: new Date(Date.now() - 60_000),
      }),
    );
    expect(retired).toBe(0);
    expect(await states(businessId)).toEqual(['open']);
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

  it('a reply that never reached the member retires only what its message opened', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const delegate = await addMember(businessId);
    const sourceMessageId = await message(businessId);
    await withBusiness(app, businessId, (tx) =>
      continuationsRepo.openContinuation(tx, {
        businessId,
        userId: ownerId,
        sourceMessageId,
        state: PERIOD_QUESTION,
        now: OPENED,
      }),
    );
    await open(businessId, delegate);
    const retire = () =>
      withBusiness(app, businessId, (tx) =>
        continuationsRepo.retireContinuationOpenedBy(tx, businessId, sourceMessageId),
      );
    expect(await retire()).toBe(1);
    expect(await retire()).toBe(0);
    expect(await current(businessId, ownerId, at(1000))).toBeNull();
    expect(await current(businessId, delegate, at(1000))).not.toBeNull();
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
    /* The replay did not retire the row it opened the first time. */
    expect(await states(businessId)).toEqual(['open']);
    expect((await current(businessId, ownerId, at(1000)))?.id).toBe(first!.id);
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

  it('a claim that waits on a committed claim gets false (forced interleaving)', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const opened = await open(businessId, ownerId);
    const second = createDb(urls.app, { max: 1 });
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let firstClaimed!: (won: boolean) => void;
      const claimedInside = new Promise<boolean>((resolve) => (firstClaimed = resolve));

      /* Claim 1 runs its UPDATE and keeps its transaction open. */
      const first = withBusiness(app, businessId, async (tx) => {
        const won = await continuationsRepo.consumeContinuation(
          tx,
          businessId,
          ownerId,
          opened!.id,
          { now: at(1000) },
        );
        firstClaimed(won);
        await held;
        return won;
      });
      expect(await claimedInside).toBe(true);

      /* Claim 2 starts while claim 1 is uncommitted: it must block on the row. */
      const later = consume(businessId, ownerId, opened!.id, at(1000), second.db);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i += 1) {
        const rows = await owner.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        blocked = ([...rows][0]?.n ?? 0) > 0;
        if (!blocked) await new Promise((resolve) => setImmediate(resolve));
      }
      expect(blocked).toBe(true);

      /* Claim 1 commits; claim 2 re-checks `state = 'open'` and loses. */
      release();
      expect(await first).toBe(true);
      expect(await later).toBe(false);
    } finally {
      await second.close();
    }
    expect(await states(businessId)).toEqual(['consumed']);
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

  it('the database refuses a numbered list that is anything but invoice numbers', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const insert = async (options: unknown) => {
      const sourceMessageId = await message(businessId);
      return withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO conversation_continuations
            (business_id, user_id, source_message_id, kind, expects, topic, options)
          VALUES (${businessId}::uuid, ${ownerId}::uuid, ${sourceMessageId}::uuid,
                  'clarification', 'choice', 'customer_balance',
                  ${JSON.stringify(options)}::jsonb)`),
      );
    };
    const line = (ordinal: unknown, invoiceNumber: unknown = 'INV-2026-000001') => ({
      ordinal,
      ref: { kind: 'invoice', invoiceNumber },
    });
    const refused = /conversation_continuations_options_check/;
    const why = (p: Promise<unknown>) =>
      p.then(
        () => 'accepted',
        (error: Error & { cause?: unknown }) => String(error.cause ?? error),
      );
    /* A customer's name, as the whole element or beside a valid one. */
    expect(await why(insert([{ customerName: 'Ada' }]))).toMatch(refused);
    expect(await why(insert([{ ...line(1), customerName: 'Ada' }]))).toMatch(refused);
    expect(
      await why(
        insert([
          { ordinal: 1, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000001', name: 'Ada' } },
        ]),
      ),
    ).toMatch(refused);
    /* A number that is not a document number, or a reference of another kind. */
    expect(await why(insert([line(1, 'Ada Obi')]))).toMatch(refused);
    expect(await why(insert([line(1, 'INV-26-1')]))).toMatch(refused);
    expect(
      await why(
        insert([{ ordinal: 1, ref: { kind: 'customer', invoiceNumber: 'INV-2026-000001' } }]),
      ),
    ).toMatch(refused);
    /* Ordinals 1..n, each once; 1 to 9 lines; an array. */
    expect(await why(insert([line(1), line(1, 'INV-2026-000002')]))).toMatch(refused);
    expect(await why(insert([line(2)]))).toMatch(refused);
    expect(await why(insert([line('1')]))).toMatch(refused);
    expect(await why(insert([]))).toMatch(refused);
    expect(await why(insert(Array.from({ length: 10 }, (_, i) => line(i + 1))))).toMatch(refused);
    expect(await why(insert({ ordinal: 1 }))).toMatch(refused);
    expect(await why(insert(['INV-2026-000001']))).toMatch(refused);
    /* The exact shape core writes is accepted, in any order. */
    expect(await why(insert([line(2, 'INV-2026-000004'), line(1)]))).toBe('accepted');
  });

  it('cannot point at another tenant’s message, even as the owner outside RLS', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const theirMessage = await message(b.businessId);
    /* The owner credential bypasses RLS, so only the composite key refuses. */
    const refusal = await owner
      .execute(
        sql`
        INSERT INTO conversation_continuations
          (business_id, user_id, source_message_id, kind, expects, topic)
        VALUES (${a.businessId}::uuid, ${a.ownerId}::uuid, ${theirMessage}::uuid,
                'clarification', 'period', 'sales_summary')`,
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );
    expect(String(refusal?.cause)).toContain('conversation_continuations_message_business_fk');
    /* The same row naming its own tenant's message is accepted. */
    const ours = await message(a.businessId);
    await owner.execute(sql`
      INSERT INTO conversation_continuations
        (business_id, user_id, source_message_id, kind, expects, topic)
      VALUES (${a.businessId}::uuid, ${a.ownerId}::uuid, ${ours}::uuid,
              'clarification', 'period', 'sales_summary')`);
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

/**
 * Which draft lookups skip a read-only Query's draft (Build 6), pinned per
 * function so a change to one cannot silently move another. What a "yes",
 * a "no" or a correction is about skips it; the erasure ceremony, expiry and
 * supersession count it exactly as before.
 */
describe('a question to the books, among the drafts', () => {
  async function draftsWithAQuestionLast(businessId: string) {
    const saleMessage = await message(businessId);
    const questionMessage = await message(businessId);
    return withBusiness(app, businessId, async (tx) => {
      const sale = await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: saleMessage,
        intent: 'RecordSale',
        command: { intent: 'RecordSale' },
        model: null,
        previewed: true,
      });
      const question = await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: questionMessage,
        intent: 'Query',
        command: { intent: 'Query', topic: 'sales_summary' },
        model: null,
      });
      return { sale: sale.id, question: question.id };
    });
  }

  it('what a yes, a no or a correction is about skips it', async () => {
    const { businessId } = await seedBusiness();
    const { sale } = await draftsWithAQuestionLast(businessId);
    await withBusiness(app, businessId, async (tx) => {
      expect((await conversationsRepo.pendingDraftToAnswer(tx, businessId))?.id).toBe(sale);
      expect((await conversationsRepo.latestDraftToAnswer(tx, businessId))?.id).toBe(sale);
    });
  });

  it('a question asked after a preview is retired, never the preview', async () => {
    const { businessId } = await seedBusiness();
    const { sale, question } = await draftsWithAQuestionLast(businessId);
    const retire = () =>
      withBusiness(app, businessId, (tx) =>
        conversationsRepo.retireNewestReadAfter(tx, businessId, sale),
      );
    expect(await retire()).toBe(1);
    expect(await retire()).toBe(0);
    const states = await withBusiness(app, businessId, (tx) =>
      tx.execute<{ id: string; state: string }>(sql`
        SELECT id, state FROM command_drafts WHERE business_id = ${businessId}::uuid`),
    );
    const byId = new Map([...states].map((r) => [r.id, r.state]));
    expect(byId.get(sale)).toBe('pending');
    expect(byId.get(question)).toBe('superseded');
    /* Nothing newer than the question: retiring after it moves nothing. */
    expect(
      await withBusiness(app, businessId, (tx) =>
        conversationsRepo.retireNewestReadAfter(tx, businessId, question),
      ),
    ).toBe(0);
  });

  it('retires one question per call, newest first, as a yes claimed them before Build 6', async () => {
    const { businessId } = await seedBusiness();
    const { sale, question: first } = await draftsWithAQuestionLast(businessId);
    const secondMessage = await message(businessId);
    const second = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: secondMessage,
        intent: 'Query',
        command: { intent: 'Query', topic: 'expenses_summary' },
        model: null,
      }),
    );
    const retire = () =>
      withBusiness(app, businessId, (tx) =>
        conversationsRepo.retireNewestReadAfter(tx, businessId, sale),
      );
    const stateOf = async () => {
      const rows = await withBusiness(app, businessId, (tx) =>
        tx.execute<{ id: string; state: string }>(sql`
          SELECT id, state FROM command_drafts WHERE business_id = ${businessId}::uuid`),
      );
      return new Map([...rows].map((r) => [r.id, r.state]));
    };
    expect(await retire()).toBe(1);
    let states = await stateOf();
    expect(states.get(second.id)).toBe('superseded');
    expect(states.get(first)).toBe('pending');
    expect(await retire()).toBe(1);
    states = await stateOf();
    expect(states.get(first)).toBe('superseded');
    expect(states.get(sale)).toBe('pending');
    expect(await retire()).toBe(0);
  });

  it('tells whether a question was asked since a draft, changing nothing', async () => {
    const { businessId } = await seedBusiness();
    const { sale, question } = await draftsWithAQuestionLast(businessId);
    const since = (id: string) =>
      withBusiness(app, businessId, (tx) => conversationsRepo.hasReadsAfter(tx, businessId, id));
    expect(await since(sale)).toBe(true);
    expect(await since(sale)).toBe(true);
    expect(await since(question)).toBe(false);
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.retireNewestReadAfter(tx, businessId, sale),
    );
    expect(await since(sale)).toBe(false);
  });

  it("a question's draft never stores the merchant's words for the window", async () => {
    const { businessId } = await seedBusiness();
    const questionMessage = await message(businessId);
    const stored = await withBusiness(app, businessId, async (tx) => {
      await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: questionMessage,
        intent: 'Query',
        command: {
          intent: 'Query',
          topic: 'sales_summary',
          customer: null,
          period: 'custom',
          periodText: 'the month I sold to Ada',
          format: null,
        },
        model: null,
      });
      return tx.execute<{ command: Record<string, unknown> }>(sql`
        SELECT command FROM command_drafts WHERE business_id = ${businessId}::uuid`);
    });
    const command = [...stored][0]!.command;
    expect(command['periodText']).toBeNull();
    expect(JSON.stringify(command)).not.toContain('Ada');
    expect(command['topic']).toBe('sales_summary');
  });

  it('the erasure ceremony, expiry and supersession still count it', async () => {
    const { businessId } = await seedBusiness();
    const { question } = await draftsWithAQuestionLast(businessId);
    await withBusiness(app, businessId, async (tx) => {
      expect((await conversationsRepo.pendingDraft(tx, businessId))?.id).toBe(question);
      expect((await conversationsRepo.latestDraft(tx, businessId))?.id).toBe(question);
    });
    const expired = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.expireStaleDrafts(tx, businessId, { now: at(10 * TTL_MS) }),
    );
    expect(expired).toBe(2);

    const other = await seedBusiness();
    await draftsWithAQuestionLast(other.businessId);
    const superseded = await withBusiness(app, other.businessId, (tx) =>
      conversationsRepo.supersedePendingDrafts(tx, other.businessId),
    );
    expect(superseded).toBe(2);
  });
});

/**
 * Migration 0155 (G-68 Phase 2): the G-61 funding-source question as a
 * continuation. It names ONE retired purchase draft of its own business,
 * and nothing else; no other row names a draft.
 */
describe('the funding-source question (migration 0155)', () => {
  async function retiredPurchase(businessId: string): Promise<string> {
    const asked = await message(businessId);
    return withBusiness(app, businessId, async (tx) => {
      const draft = await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: asked,
        intent: 'RecordPurchase',
        command: { intent: 'RecordPurchase', amount: 180_000, paymentMethod: 'pos' },
        model: null,
      });
      await conversationsRepo.retireDraft(tx, businessId, draft.id);
      return draft.id;
    });
  }

  const raw = (
    businessId: string,
    userId: string,
    sourceMessageId: string,
    expects: string,
    draftId: string | null,
    topic: string | null = null,
  ) =>
    owner
      .execute(
        sql`
        INSERT INTO conversation_continuations
          (business_id, user_id, source_message_id, kind, expects, topic, draft_id)
        VALUES (${businessId}::uuid, ${userId}::uuid, ${sourceMessageId}::uuid,
                'clarification', ${expects}, ${topic}, ${draftId}::uuid)`,
      )
      .then(
        () => 'accepted',
        (error: Error & { cause?: unknown }) => String(error.cause ?? error.message),
      );

  it('opens, reads back and is claimed once, naming its retired draft', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const draftId = await retiredPurchase(businessId);
    const opened = await open(businessId, ownerId, {
      kind: 'clarification',
      expects: 'funding_source',
      draftId,
    });
    const live = await current(businessId, ownerId, at(1000));
    expect(live?.state).toEqual({ kind: 'clarification', expects: 'funding_source', draftId });
    expect(await consume(businessId, ownerId, opened!.id, at(1000))).toBe(true);
    expect(await consume(businessId, ownerId, opened!.id, at(1000))).toBe(false);
    expect(await states(businessId)).toEqual(['consumed']);
  });

  it('reads the retired purchase back without claiming or reviving it', async () => {
    const { businessId } = await seedBusiness();
    const draftId = await retiredPurchase(businessId);
    const read = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.retiredPurchaseDraft(tx, businessId, draftId),
    );
    expect(read?.id).toBe(draftId);
    const after = await withBusiness(app, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts WHERE id = ${draftId}::uuid`),
    );
    expect([...after][0]?.state).toBe('abandoned');
    /* Closed by "no", it rebuilds nothing. */
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.closeRetiredDraft(tx, businessId, draftId),
    );
    expect(
      await withBusiness(app, businessId, (tx) =>
        conversationsRepo.retiredPurchaseDraft(tx, businessId, draftId),
      ),
    ).toBeNull();
  });

  it('the database refuses a funding question without a draft, and a draft on anything else', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const draftId = await retiredPurchase(businessId);
    expect(
      await raw(businessId, ownerId, await message(businessId), 'funding_source', null),
    ).toContain('conversation_continuations_funding_shape_check');
    expect(
      await raw(businessId, ownerId, await message(businessId), 'period', draftId, 'sales_summary'),
    ).toContain('conversation_continuations_funding_shape_check');
    expect(
      await raw(
        businessId,
        ownerId,
        await message(businessId),
        'funding_source',
        draftId,
        'debtors',
      ),
    ).toContain('conversation_continuations_funding_shape_check');
    expect(
      await raw(businessId, ownerId, await message(businessId), 'transfer_money', null),
    ).toContain('conversation_continuations_expects_check');
    expect(
      await raw(businessId, ownerId, await message(businessId), 'funding_source', draftId),
    ).toBe('accepted');
  });

  it('cannot name another tenant’s draft, even as the owner outside RLS', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const theirs = await retiredPurchase(b.businessId);
    expect(
      await raw(a.businessId, a.ownerId, await message(a.businessId), 'funding_source', theirs),
    ).toContain('conversation_continuations_draft_business_fk');
  });
});
