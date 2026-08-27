/**
 * Conversation identity, step one (Appendix F; PR-058a-1): the
 * channel-neutral columns land additively — nullable, no behaviour
 * change, the old unique untouched — with the two coherence rules the
 * appendix insists on: a blind index travels with its key version or not
 * at all, and the kind vocabulary admits the honest third answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, customersRepo, identity, sql, withBusiness, type Db } from './index.js';
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
