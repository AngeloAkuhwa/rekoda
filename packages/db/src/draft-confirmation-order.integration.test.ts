/**
 * What a merchant's "yes" confirms is decided by a database-assigned ordinal,
 * never by clock resolution or uuid order (migration 0149).
 *
 * `pendingDraft` selects the draft a confirmation executes. It selected by
 * `created_at DESC, id DESC`: 0146 made `created_at` advance between
 * statements, but two inserts can still share a microsecond, and the
 * tiebreaker behind it is a RANDOM uuid - deterministic, yet unrelated to
 * which draft is newer. A transcript can live with that. The selector for
 * which financial command runs cannot, so `insertion_seq` - a bigint
 * identity, GENERATED ALWAYS - becomes the ordering authority, and
 * `created_at` goes back to being time and provenance.
 *
 * The invariant, stated once: for one business, if draft B was inserted
 * after draft A and both remain pending, confirmation selects B - regardless
 * of `created_at` equality and regardless of uuid lexical order.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
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
  const asApp = createDb(urls.app, { max: 4 });
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

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481400${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/**
 * One draft through the REAL path: its own inbound message (one draft per
 * message is a unique), then `recordDraft`, which never mentions
 * `insertion_seq` - the database assigns it.
 */
async function recordOneDraft(businessId: string, note: string): Promise<string> {
  return withBusiness(app, businessId, async (tx: TenantDb) => {
    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: `msg ${note}`,
      providerMessageId: `wamid.SEQ.${businessId.slice(0, 8)}.${note}`,
    });
    const draft = await conversationsRepo.recordDraft(tx, {
      businessId,
      conversationMessageId: message.id,
      intent: 'RecordSale',
      command: { kind: 'RecordSale', note },
      model: null,
    });
    return draft.id;
  });
}

const tieCreatedAt = (businessId: string) =>
  owner.execute(
    sql`UPDATE command_drafts SET created_at = timestamptz '2026-01-01 00:00:00+00'
         WHERE business_id = ${businessId}::uuid`,
  );

const seqOf = async (draftId: string): Promise<number> => {
  const rows = await owner.execute<{ seq: number }>(
    sql`SELECT insertion_seq::int AS seq FROM command_drafts WHERE id = ${draftId}::uuid`,
  );
  const found = [...rows][0];
  if (!found) throw new Error('draft not found');
  return found.seq;
};

describe('the ordinal is the database’s, structurally', () => {
  it('insertion_seq is a bigint identity, GENERATED ALWAYS, not null', async () => {
    const rows = await owner.execute<{ identity: string; type: string; notnull: boolean }>(sql`
      SELECT a.attidentity::text AS identity,
             format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS notnull
        FROM pg_attribute a
       WHERE a.attrelid = 'command_drafts'::regclass AND a.attname = 'insertion_seq'
    `);
    /* 'a' is ALWAYS - not 'd' (BY DEFAULT), which would let a caller supply
     * a value silently. */
    expect([...rows][0]).toEqual({ identity: 'a', type: 'bigint', notnull: true });
  });

  it('a caller who tries to choose the ordinal is refused by PostgreSQL itself', async () => {
    const businessId = await seedBusiness();
    const draftId = await recordOneDraft(businessId, 'host');
    const refusal = await owner
      .execute(
        sql`INSERT INTO command_drafts
              (business_id, conversation_message_id, intent, command, state, insertion_seq)
            SELECT business_id, conversation_message_id, intent, command, 'superseded', 999999
              FROM command_drafts WHERE id = ${draftId}::uuid`,
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );
    expect(refusal, 'an explicit insertion_seq was accepted').not.toBeNull();
    expect(String(refusal?.cause)).toContain(
      'cannot insert a non-DEFAULT value into column "insertion_seq"',
    );
  });
});

describe('confirmation selects the later draft, whatever the clock and the uuids say', () => {
  it('two drafts on one instant: the later insert carries the larger ordinal and wins', async () => {
    const businessId = await seedBusiness();
    const first = await recordOneDraft(businessId, 'first');
    const second = await recordOneDraft(businessId, 'second');
    await tieCreatedAt(businessId);

    expect(await seqOf(second)).toBeGreaterThan(await seqOf(first));

    const pending = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.pendingDraft(tx, businessId),
    );
    expect(pending?.id).toBe(second);
  });

  it('the later draft still wins when the earlier one’s uuid sorts LAST', async () => {
    const businessId = await seedBusiness();
    const first = await recordOneDraft(businessId, 'first');
    const second = await recordOneDraft(businessId, 'second');
    await tieCreatedAt(businessId);

    /* The adversarial construction, and the reason `id` could never be the
     * authority: force the EARLIER draft's uuid to sort after the LATER
     * one's. Under `created_at DESC, id DESC` the earlier draft would now
     * win the merchant's "yes" - deterministically wrong. The ordinal does
     * not care what the uuids look like. */
    await owner.execute(
      sql`UPDATE command_drafts SET id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid
           WHERE id = ${first}::uuid`,
    );
    await owner.execute(
      sql`UPDATE command_drafts SET id = '00000000-0000-4000-8000-000000000000'::uuid
           WHERE id = ${second}::uuid`,
    );

    const pending = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.pendingDraft(tx, businessId),
    );
    expect(pending?.id).toBe('00000000-0000-4000-8000-000000000000');
    expect((pending?.command as { note: string } | undefined)?.note).toBe('second');
  });

  it('each business confirms its own latest, however the inserts interleave', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    await recordOneDraft(mine, 'mine-1');
    await recordOneDraft(theirs, 'theirs-1');
    const mineLatest = await recordOneDraft(mine, 'mine-2');
    const theirsLatest = await recordOneDraft(theirs, 'theirs-2');
    await tieCreatedAt(mine);
    await tieCreatedAt(theirs);

    const [pendingMine, pendingTheirs] = await Promise.all([
      withBusiness(app, mine, (tx) => conversationsRepo.pendingDraft(tx, mine)),
      withBusiness(app, theirs, (tx) => conversationsRepo.pendingDraft(tx, theirs)),
    ]);
    expect(pendingMine?.id).toBe(mineLatest);
    expect(pendingTheirs?.id).toBe(theirsLatest);
  });

  it('a rolled-back insert leaves a gap in the sequence, and the gap changes nothing', async () => {
    const businessId = await seedBusiness();
    const first = await recordOneDraft(businessId, 'first');

    /* Sequences do not roll back - that is the design, not a defect. Burn a
     * value inside an aborted transaction and prove ordering only ever
     * needed ORDER, never density. */
    await withBusiness(app, businessId, async (tx: TenantDb) => {
      const message = await conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'doomed',
        providerMessageId: 'wamid.SEQ.rollback',
      });
      await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: message.id,
        intent: 'RecordSale',
        command: { kind: 'RecordSale', note: 'doomed' },
        model: null,
      });
      throw new Error('deliberate rollback');
    }).catch((error: Error) => {
      if (!error.message.includes('deliberate rollback')) throw error;
    });

    const second = await recordOneDraft(businessId, 'second');
    expect(await seqOf(second)).toBeGreaterThan((await seqOf(first)) + 1);

    await tieCreatedAt(businessId);
    const pending = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.pendingDraft(tx, businessId),
    );
    expect(pending?.id).toBe(second);
  });

  it('the confirmation path claims exactly the selected draft, once', async () => {
    const businessId = await seedBusiness();
    const first = await recordOneDraft(businessId, 'first');
    const second = await recordOneDraft(businessId, 'second');
    await tieCreatedAt(businessId);

    const claimed = await withBusiness(app, businessId, async (tx: TenantDb) => {
      const pending = await conversationsRepo.pendingDraft(tx, businessId);
      if (!pending) throw new Error('no pending draft');
      return { id: pending.id, won: await conversationsRepo.claimDraft(tx, pending.id) };
    });
    expect(claimed.id).toBe(second);
    expect(claimed.won).toBe(true);

    /* Exactly once: the same claim loses the second time, and the draft that
     * was NOT selected is still pending, untouched by the confirmation. */
    const again = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.claimDraft(tx, claimed.id),
    );
    expect(again).toBe(false);

    const rows = await owner.execute<{ state: string }>(
      sql`SELECT state FROM command_drafts WHERE id = ${first}::uuid`,
    );
    expect([...rows][0]?.state).toBe('pending');
  });

  it('draftsFor lists in insertion order under the same adversarial uuids', async () => {
    const businessId = await seedBusiness();
    const first = await recordOneDraft(businessId, 'first');
    const second = await recordOneDraft(businessId, 'second');
    const third = await recordOneDraft(businessId, 'third');
    await tieCreatedAt(businessId);
    /* Reverse the uuid order relative to insertion order entirely. */
    const relabel = [
      { from: first, to: 'cccccccc-0000-4000-8000-000000000003' },
      { from: second, to: 'bbbbbbbb-0000-4000-8000-000000000002' },
      { from: third, to: 'aaaaaaaa-0000-4000-8000-000000000001' },
    ];
    for (const move of relabel) {
      await owner.execute(
        sql`UPDATE command_drafts SET id = ${move.to}::uuid WHERE id = ${move.from}::uuid`,
      );
    }

    const drafts = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.draftsFor(tx, businessId),
    );
    expect(drafts.map((d) => (d.command as { note: string }).note)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
