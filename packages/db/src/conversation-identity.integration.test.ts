/**
 * Conversation identity (Appendix F; PR-058a-1…4): the channel-neutral
 * columns, the classified estate, the resolver, and — since 058a-4 — the
 * two partial constraints that replaced "one thread per business per
 * channel": one MERCHANT thread per channel, and a CUSTOMER thread per
 * (channel asset, participant), which is what lets one merchant WABA
 * carry fifty thousand customers without touching Chat.
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
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481890${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const customerTarget = (
  businessId: string,
  blindIndex: string,
  channelAccountId = 'pn-900',
  keyVersion = 'V1',
): conversationsRepo.ThreadTarget => ({
  kind: 'CUSTOMER',
  businessId,
  channel: 'meta',
  channelAccountId,
  participantBlindIndex: blindIndex,
  participantIndexKeyVersion: keyVersion,
});

describe('the columns and their coherence (PR-058a-1)', () => {
  it('a thread is classified at birth and carries no invented participant', async () => {
    const businessId = await seedBusiness();
    const threadId = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.threadFor(tx, businessId, 'meta'),
    );
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        conversation_kind: string;
        participant_blind_index: string | null;
        status: string;
      }>(sql`
        SELECT conversation_kind, participant_blind_index, status
        FROM conversations WHERE id = ${threadId}::uuid
      `),
    );
    expect([...rows][0]).toEqual({
      conversation_kind: 'MERCHANT',
      participant_blind_index: null,
      status: 'open',
    });
  });

  it('an unclassified thread is unrepresentable now (058a-4)', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`INSERT INTO conversations (business_id, channel) VALUES (${businessId}::uuid, 'meta')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('a blind index travels with its key version or not at all (F.3)', async () => {
    const businessId = await seedBusiness();
    const threadId = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.threadFor(tx, businessId, 'meta'),
    );
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE conversations SET participant_blind_index = 'blind:abc'
                       WHERE id = ${threadId}::uuid`),
      ),
    ).rejects.toThrow();
  });

  it("a thread cannot claim another tenant's customer", async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    const bolaCustomer = await customersRepo.createCustomerWithIdentities(
      db,
      bola,
      `CUSTOMER_XF${seq}`,
      [],
    );
    const adaThread = await withBusiness(db, ada, (tx) =>
      conversationsRepo.threadFor(tx, ada, 'meta'),
    );
    await expect(
      withBusiness(db, ada, (tx) =>
        tx.execute(sql`UPDATE conversations SET customer_id = ${bolaCustomer.id}::uuid
                       WHERE id = ${adaThread}::uuid`),
      ),
    ).rejects.toThrow();
  });
});

describe('two identities, two constraints (F.2; PR-058a-4)', () => {
  it('exactly one MERCHANT thread per business per channel: the correct part of the old rule, kept', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) => conversationsRepo.threadFor(tx, businessId, 'meta'));
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO conversations (business_id, channel, conversation_kind)
          VALUES (${businessId}::uuid, 'meta', 'MERCHANT')
        `),
      ),
    ).rejects.toThrow();
  });

  it('the merchant thread and many customer threads coexist on one channel: the whole point', async () => {
    const businessId = await seedBusiness();
    const merchant = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.threadFor(tx, businessId, 'meta'),
    );
    const ada = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.resolveThread(tx, customerTarget(businessId, 'blind:ada')),
    );
    const chidi = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.resolveThread(tx, customerTarget(businessId, 'blind:chidi')),
    );
    expect(new Set([merchant, ada, chidi]).size).toBe(3);

    /* The same customer writing again lands on their own thread. */
    const adaAgain = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.resolveThread(tx, customerTarget(businessId, 'blind:ada')),
    );
    expect(adaAgain).toBe(ada);

    /* And the merchant thread is untouched by any of it. */
    const merchantAgain = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.threadFor(tx, businessId, 'meta'),
    );
    expect(merchantAgain).toBe(merchant);
  });

  it('messages route to their own threads, never each other', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'sold 2 wigs',
        providerMessageId: `wamid-${seq}-m`,
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      conversationsRepo.recordInbound(
        tx,
        {
          businessId,
          channel: 'meta',
          kind: 'text',
          body: 'do you have the bone-straight in 22 inches?',
          providerMessageId: `wamid-${seq}-c`,
        },
        customerTarget(businessId, 'blind:ada'),
      ),
    );
    const merchantThread = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesForThread(tx, {
        kind: 'MERCHANT',
        businessId,
        channel: 'meta',
      }),
    );
    const customerThread = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesForThread(tx, customerTarget(businessId, 'blind:ada')),
    );
    expect(merchantThread).toHaveLength(1);
    expect(merchantThread[0]!.body).toBe('sold 2 wigs');
    expect(customerThread).toHaveLength(1);
    expect(customerThread[0]!.body).toContain('bone-straight');
  });

  it('a customer thread without its identity is unrepresentable', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO conversations (business_id, channel, conversation_kind)
          VALUES (${businessId}::uuid, 'meta', 'CUSTOMER')
        `),
      ),
    ).rejects.toThrow();
  });

  it('one channel asset carries many customers; two assets keep the same hash apart', async () => {
    const businessId = await seedBusiness();
    /* §10.2's scale gate verbatim: 100+ customer conversations on ONE
     * channel account — the shape the old constraint made impossible. */
    const threads = new Set<string>();
    for (let n = 0; n < 110; n += 1) {
      threads.add(
        await withBusiness(db, businessId, (tx) =>
          conversationsRepo.resolveThread(tx, customerTarget(businessId, `blind:c${n}`)),
        ),
      );
    }
    expect(threads.size).toBe(110);

    /* F.5: the same participant hash on a DIFFERENT channel asset is a
     * different thread — customer identity and WABA identity never merge. */
    const onOtherAsset = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.resolveThread(tx, customerTarget(businessId, 'blind:c0', 'pn-901')),
    );
    expect(threads.has(onOtherAsset)).toBe(false);
  });

  it("merchant A can never resolve merchant B's participant, through RLS not filters (§10.2)", async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    await withBusiness(db, bola, (tx) =>
      conversationsRepo.resolveThread(tx, customerTarget(bola, 'blind:shared')),
    );
    /* Even knowing Bola's exact index value, a session pinned to Ada sees
     * nothing: the tenant policy is the barrier, not a WHERE we remembered
     * to write. */
    const seen = await withBusiness(db, ada, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM conversations
        WHERE participant_blind_index = 'blind:shared'
      `),
    );
    expect([...seen][0]!.n).toBe(0);
  });

  it('key rotation re-derives the lookup and never the identity (F.3)', async () => {
    const businessId = await seedBusiness();
    const v1 = customerTarget(businessId, 'blind:k1-ada');
    const threadId = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.resolveThread(tx, v1),
    );
    await withBusiness(db, businessId, (tx) =>
      conversationsRepo.recordInbound(
        tx,
        {
          businessId,
          channel: 'meta',
          kind: 'text',
          body: 'is the ankara still available?',
          providerMessageId: `wamid-${seq}-rot`,
        },
        v1,
      ),
    );

    /* The background re-index (F.3 steps 3–4): the row's lookup token is
     * re-derived under K2. Conversation.id does not change. */
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE conversations
        SET participant_blind_index = 'blind:k2-ada', participant_index_key_version = 'V2'
        WHERE id = ${threadId}::uuid
      `),
    );

    /* Step 5, completeness PROVEN by count: zero V1 rows remain. */
    const remaining = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM conversations WHERE participant_index_key_version = 'V1'`,
      ),
    );
    expect([...remaining][0]!.n).toBe(0);

    /* The V2 lookup resolves the SAME thread, and every message
     * relationship survived untouched. */
    const v2 = customerTarget(businessId, 'blind:k2-ada', 'pn-900', 'V2');
    const resolved = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.resolveThread(tx, v2),
    );
    expect(resolved).toBe(threadId);
    const messages = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesForThread(tx, v2),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain('ankara');
  });
});
