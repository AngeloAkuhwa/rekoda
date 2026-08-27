/**
 * Conversation identity, step one (Appendix F; PR-058a-1): the
 * channel-neutral columns land additively — nullable, no behaviour
 * change, the old unique untouched — with the two coherence rules the
 * appendix insists on: a blind index travels with its key version or not
 * at all, and the kind vocabulary admits the honest third answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conversationsRepo,
  createDb,
  customersRepo,
  identity,
  sql,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedConversation(): Promise<{ businessId: string; conversationId: string }> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481890${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const rows = await withBusiness(db, business.id, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO conversations (business_id, channel) VALUES (${business.id}::uuid, 'meta')
      RETURNING id
    `),
  );
  return { businessId: business.id, conversationId: [...rows][0]!.id };
}

describe('additive and honest (PR-058a-1)', () => {
  it('a new thread carries the new columns, null until the backfill classifies it', async () => {
    const { businessId, conversationId } = await seedConversation();
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        conversation_kind: string | null;
        channel_account_id: string | null;
        participant_blind_index: string | null;
        status: string;
      }>(sql`
        SELECT conversation_kind, channel_account_id, participant_blind_index, status
        FROM conversations WHERE id = ${conversationId}::uuid
      `),
    );
    expect([...rows][0]).toEqual({
      conversation_kind: null,
      channel_account_id: null,
      participant_blind_index: null,
      status: 'open',
    });
  });

  it('the kind vocabulary admits MERCHANT, CUSTOMER and the honest LEGACY_THREAD — and nothing else', async () => {
    const { businessId, conversationId } = await seedConversation();
    for (const kind of ['MERCHANT', 'CUSTOMER', 'LEGACY_THREAD']) {
      await withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE conversations SET conversation_kind = ${kind}
                       WHERE id = ${conversationId}::uuid`),
      );
    }
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE conversations SET conversation_kind = 'GROUP_CHAT'
                       WHERE id = ${conversationId}::uuid`),
      ),
    ).rejects.toThrow();
  });

  it('a blind index travels with its key version or not at all (F.3)', async () => {
    const { businessId, conversationId } = await seedConversation();
    /* An index nobody can rotate is permanent cryptographic debt. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE conversations SET participant_blind_index = 'blind:abc'
                       WHERE id = ${conversationId}::uuid`),
      ),
    ).rejects.toThrow();
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`UPDATE conversations
                     SET participant_blind_index = 'blind:abc',
                         participant_index_key_version = 'V1'
                     WHERE id = ${conversationId}::uuid`),
    );
  });

  it("a thread cannot claim another tenant's customer", async () => {
    const ada = await seedConversation();
    const bolaUser = await identity.upsertUserByPhone(db, '+2348189999901');
    const bola = await identity.createBusinessWithOwner(db, {
      name: 'Bola Threads',
      businessType: null,
      ownerUserId: bolaUser.id,
    });
    const bolaCustomer = await customersRepo.createCustomerWithIdentities(
      db,
      bola.id,
      'CUSTOMER_XF1',
      [],
    );
    await expect(
      withBusiness(db, ada.businessId, (tx) =>
        tx.execute(sql`UPDATE conversations SET customer_id = ${bolaCustomer.id}::uuid
                       WHERE id = ${ada.conversationId}::uuid`),
      ),
    ).rejects.toThrow();
  });

  it('nothing about the old world changed: one thread per business per channel still holds', async () => {
    const { businessId } = await seedConversation();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`INSERT INTO conversations (business_id, channel) VALUES (${businessId}::uuid, 'meta')`,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('the backfill and classification at birth (F.6; PR-058a-2)', () => {
  it('a thread minted by threadFor is MERCHANT from its first breath', async () => {
    seq += 1;
    const user = await identity.upsertUserByPhone(db, `+23481895${String(seq).padStart(4, '0')}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const threadId = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.threadFor(tx, business.id, 'meta'),
    );
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ conversation_kind: string | null; participant_blind_index: string | null }>(
        sql`SELECT conversation_kind, participant_blind_index FROM conversations
            WHERE id = ${threadId}::uuid`,
      ),
    );
    expect([...rows][0]).toEqual({
      conversation_kind: 'MERCHANT',
      /* And STOP: no fabricated participant. There was no customer on the
       * other end; there was Rekoda. */
      participant_blind_index: null,
    });
  });

  it('the migration file replays over a pre-backfill estate and classifies it, inventing nothing', async () => {
    const { businessId, conversationId } = await seedConversation();
    /* seedConversation inserts raw, kind NULL — exactly the legacy shape. */
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const migration = readFileSync(
      join(
        fileURLToPath(import.meta.url),
        '..',
        '..',
        'migrations',
        '0086_conversation_backfill.sql',
      ),
      'utf8',
    );
    const postgres = (await import('postgres')).default;
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      await owner.unsafe(migration);
      /* Idempotent: a second run changes nothing and still validates. */
      await owner.unsafe(migration);
    } finally {
      await owner.end();
    }
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ conversation_kind: string | null; participant_blind_index: string | null }>(
        sql`SELECT conversation_kind, participant_blind_index FROM conversations
            WHERE id = ${conversationId}::uuid`,
      ),
    );
    expect([...rows][0]).toEqual({
      conversation_kind: 'MERCHANT',
      participant_blind_index: null,
    });
  });
});

describe('the resolver (F.2; PR-058a-3)', () => {
  async function freshBusiness(): Promise<string> {
    seq += 1;
    const user = await identity.upsertUserByPhone(db, `+23481897${String(seq).padStart(4, '0')}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    return business.id;
  }

  it('a MERCHANT target is the old rule, verbatim: same function, same row', async () => {
    const businessId = await freshBusiness();
    const viaThreadFor = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.threadFor(tx, businessId, 'meta'),
    );
    const viaResolver = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.resolveThread(tx, { kind: 'MERCHANT', businessId, channel: 'meta' }),
    );
    expect(viaResolver).toBe(viaThreadFor);
  });

  it('a writer given the explicit identity lands in the same thread as one that assumed it', async () => {
    const businessId = await freshBusiness();
    const assumed = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'sold 2 wigs',
        providerMessageId: `wamid-${seq}-a`,
      }),
    );
    const explicit = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.recordInbound(
        tx,
        {
          businessId,
          channel: 'meta',
          kind: 'text',
          body: 'and one gele',
          providerMessageId: `wamid-${seq}-b`,
        },
        { kind: 'MERCHANT', businessId, channel: 'meta' },
      ),
    );
    expect(assumed.isNew && explicit.isNew).toBe(true);

    const scoped = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesForThread(tx, { kind: 'MERCHANT', businessId, channel: 'meta' }),
    );
    const broad = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesFor(tx, businessId),
    );
    expect(scoped.map((m) => m.id)).toEqual(broad.map((m) => m.id));
    expect(scoped).toHaveLength(2);
  });

  it('a CUSTOMER thread cannot be created early: it would occupy the broad unique and lock the merchant out', async () => {
    const businessId = await freshBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        conversationsRepo.resolveThread(tx, {
          kind: 'CUSTOMER',
          businessId,
          channel: 'meta',
          channelAccountId: 'pn-900',
          participantBlindIndex: 'blind:xyz',
          participantIndexKeyVersion: 'V1',
        }),
      ),
    ).rejects.toBeInstanceOf(conversationsRepo.CustomerThreadsNotYetEnabled);
  });
});
