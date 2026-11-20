/**
 * Erasure reaches the text outside the vault (G-136 R4, owner directive on #437,
 * 20 Nov 2026): conversation text stored before G-136 and the sealed bodies of
 * finished WhatsApp messages go with the identities; placeholders, the rows
 * themselves, payment providers' events, events still in flight or open as
 * exceptions, and another business's rows stay exactly as they were.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conversationsRepo,
  createDb,
  customersRepo,
  events,
  identity,
  sql,
  withBusiness,
  type Db,
} from '../index.js';
import { migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

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
  const user = await identity.upsertUserByPhone(db, `+23481852${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function message(businessId: string, body: string) {
  seq += 1;
  await withBusiness(db, businessId, (tx) =>
    conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body,
      providerMessageId: `wamid.E${seq}`,
    }),
  );
}

async function event(
  businessId: string,
  over: {
    provider?: 'meta' | 'paystack';
    eventType?: string;
    processed?: boolean;
    error?: string | null;
  },
) {
  seq += 1;
  const sealed = { v: 1, blob: `sealed-${seq}` };
  await withBusiness(db, businessId, async (tx) => {
    const recorded = await events.recordEvent(tx, {
      provider: over.provider ?? 'meta',
      eventType: over.eventType ?? 'message.text',
      externalId: `ext-${seq}`,
      payload: sealed,
      businessId,
      processed: over.processed ?? true,
    });
    if (over.error && recorded.isNew) {
      await tx.execute(
        sql`UPDATE external_events SET error = ${over.error} WHERE id = ${recorded.id}::uuid`,
      );
    }
  });
}

const bodies = (businessId: string) =>
  withBusiness(db, businessId, async (tx) =>
    [
      ...(await tx.execute<{ body: string }>(
        sql`SELECT body FROM conversation_messages WHERE business_id = ${businessId}::uuid ORDER BY created_at, id`,
      )),
    ].map((r) => r.body),
  );

const payloads = (businessId: string) =>
  withBusiness(db, businessId, async (tx) =>
    [
      ...(await tx.execute<{ provider: string; payload: unknown }>(
        sql`SELECT provider, payload FROM external_events WHERE business_id = ${businessId}::uuid ORDER BY created_at, id`,
      )),
    ].map((r) => r.payload),
  );

describe('erasure reaches the text outside the vault (G-136)', () => {
  it('erases stored text and finished message payloads, and nothing else', async () => {
    const businessId = await seedBusiness();
    const other = await seedBusiness();
    await message(businessId, 'sold Chiamaka Okafor 2 wigs');
    await message(businessId, '[text message]');
    await message(businessId, '[debtors]');
    /* A merchant's own bracketed sentence is text, not a placeholder. */
    await message(businessId, '[Ada owes 5k]');
    /* Bracket-shaped like a placeholder, but no body the product writes (Codex on #437). */
    await message(businessId, '[ada]');
    await message(other, 'sold Bola Ige 2 wigs');
    await event(businessId, {});
    await event(businessId, { processed: false });
    await event(businessId, { error: 'model unavailable' });
    await event(businessId, { provider: 'paystack', eventType: 'charge.success' });
    await event(other, {});

    const dry = await withBusiness(db, businessId, (tx) =>
      Promise.all([
        conversationsRepo.eraseStoredText(tx, businessId, { dryRun: true }),
        events.eraseFinishedMessagePayloads(tx, businessId, { dryRun: true }),
      ]),
    );
    expect(dry).toEqual([3, 1]);
    expect(await bodies(businessId)).toContain('sold Chiamaka Okafor 2 wigs');

    const erased = await withBusiness(db, businessId, (tx) =>
      customersRepo.eraseTextOutsideTheVault(tx, businessId, 'chat'),
    );

    expect(erased).toEqual({ messageText: 3, messagePayloads: 1 });
    expect(await bodies(businessId)).toEqual([
      '[erased]',
      '[text message]',
      '[debtors]',
      '[erased]',
      '[erased]',
    ]);
    const after = await payloads(businessId);
    expect(after[0]).toEqual({ erased: true });
    /* In flight, failed and unresolved, and a payment provider's: untouched. */
    expect(after.slice(1).every((p) => (p as { blob?: string }).blob?.startsWith('sealed-'))).toBe(
      true,
    );
    expect(await bodies(other)).toEqual(['sold Bola Ige 2 wigs']);
    expect((await payloads(other))[0]).toMatchObject({ v: 1 });

    const audit = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ value: unknown }>(sql`
        SELECT new_value AS value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'conversation_messages'`),
    );
    expect([...audit].map((r) => r.value)).toEqual([
      { messageTextErased: 3, messagePayloadsErased: 1 },
    ]);

    /* Running it again changes nothing. */
    expect(
      await withBusiness(db, businessId, (tx) =>
        customersRepo.eraseTextOutsideTheVault(tx, businessId, 'chat'),
      ),
    ).toEqual({ messageText: 0, messagePayloads: 0 });
  });

  it('walks a business in bounded batches, oldest first, before a cutoff', async () => {
    const businessId = await seedBusiness();
    for (let n = 0; n < 5; n += 1) await message(businessId, `note ${n} for Ada`);

    const first = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.eraseStoredText(tx, businessId, { limit: 2 }),
    );
    expect(first).toBe(2);
    expect(await bodies(businessId)).toEqual([
      '[erased]',
      '[erased]',
      'note 2 for Ada',
      'note 3 for Ada',
      'note 4 for Ada',
    ]);
    const none = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.eraseStoredText(tx, businessId, { before: new Date('2000-01-01') }),
    );
    expect(none).toBe(0);
    await expect(
      withBusiness(db, businessId, (tx) =>
        conversationsRepo.eraseStoredText(tx, businessId, { limit: 0 }),
      ),
    ).rejects.toThrow(/positive integer/);
  });
});
