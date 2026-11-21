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
    await event(businessId, { eventType: 'status.delivered' });
    await event(other, {});

    const dry = await withBusiness(db, businessId, (tx) =>
      Promise.all([
        conversationsRepo.eraseStoredText(tx, businessId, { dryRun: true }),
        events.eraseFinishedMessagePayloads(tx, businessId, { dryRun: true }),
      ]),
    );
    expect(dry.map((d) => d.count)).toEqual([3, 2]);
    expect(await bodies(businessId)).toContain('sold Chiamaka Okafor 2 wigs');

    const erased = await withBusiness(db, businessId, (tx) =>
      customersRepo.eraseTextOutsideTheVault(tx, businessId, 'chat'),
    );

    expect(erased).toEqual({ messageText: 3, messagePayloads: 2 });
    expect(await bodies(businessId)).toEqual([
      '[erased]',
      '[text message]',
      '[debtors]',
      '[erased]',
      '[erased]',
    ]);
    const after = await payloads(businessId);
    /* Finished, with or without an error: erased. In flight, a payment provider's and a
     * delivery status: untouched. */
    expect(after[0]).toEqual({ erased: true });
    expect(after[2]).toEqual({ erased: true });
    for (const kept of [after[1], after[3], after[4]]) {
      expect((kept as { blob?: string }).blob).toMatch(/^sealed-/);
    }
    expect(await bodies(other)).toEqual(['sold Bola Ige 2 wigs']);
    expect((await payloads(other))[0]).toMatchObject({ v: 1 });

    const audit = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ value: unknown }>(sql`
        SELECT new_value AS value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'conversation_messages'`),
    );
    expect([...audit].map((r) => r.value)).toEqual([
      { messageTextErased: 3, messagePayloadsErased: 2 },
    ]);

    /* Running it again changes nothing. */
    expect(
      await withBusiness(db, businessId, (tx) =>
        customersRepo.eraseTextOutsideTheVault(tx, businessId, 'chat'),
      ),
    ).toEqual({ messageText: 0, messagePayloads: 0 });
  });

  it('walks a business in bounded passes, each starting after the last, before a cutoff', async () => {
    const businessId = await seedBusiness();
    for (let n = 0; n < 5; n += 1) await message(businessId, `note ${n} for Ada`);

    /* The dry run is the exact figure, whatever the pass size. */
    const dry = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.eraseStoredText(tx, businessId, { dryRun: true, limit: 2 }),
    );
    expect(dry).toEqual({ count: 5, last: null });

    const passes: number[] = [];
    let after: string | null = null;
    for (;;) {
      const pass = await withBusiness(db, businessId, (tx) =>
        conversationsRepo.eraseStoredText(tx, businessId, { limit: 2, after }),
      );
      passes.push(pass.count);
      if (pass.last === null) break;
      expect(after === null || pass.last > after).toBe(true);
      after = pass.last;
    }
    expect(passes).toEqual([2, 2, 1, 0]);
    expect(await bodies(businessId)).toEqual(Array(5).fill('[erased]'));

    await message(businessId, 'note 5 for Ada');
    const none = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.eraseStoredText(tx, businessId, { before: new Date('2000-01-01') }),
    );
    expect(none).toEqual({ count: 0, last: null });
    await expect(
      withBusiness(db, businessId, (tx) =>
        conversationsRepo.eraseStoredText(tx, businessId, { limit: 0 }),
      ),
    ).rejects.toThrow(/positive integer/);
  });
});

/** A row as stored before G-136 in either direction, written by SQL so its body is exact. */
async function stored(businessId: string, direction: 'inbound' | 'outbound', body: string) {
  seq += 1;
  await withBusiness(db, businessId, async (tx) => {
    const thread = await conversationsRepo.resolveThread(tx, {
      kind: 'MERCHANT',
      businessId,
      channel: 'meta',
    });
    await tx.execute(sql`
      INSERT INTO conversation_messages
        (business_id, conversation_id, direction, kind, body, provider_message_id)
      VALUES (${businessId}::uuid, ${thread}::uuid, ${direction}, 'text', ${body},
              ${`wamid.S${seq}`})`);
  });
}

describe('what counts as a label the product writes (owner review of #437)', () => {
  it('keeps only exact labels of their own direction and erases everything shaped like one', async () => {
    const businessId = await seedBusiness();
    const kept: Array<['inbound' | 'outbound', string]> = [
      ['inbound', '[text message]'],
      ['inbound', '[number:2]'],
      ['inbound', '[image message]'],
      ['inbound', '[message withheld: it held a protected detail]'],
      ['outbound', '[reply]'],
      ['outbound', '[erased]'],
    ];
    const erased: Array<['inbound' | 'outbound', string]> = [
      /* Outbound labels typed by a merchant are their words. */
      ['inbound', '[template chiamaka_okafor]'],
      ['inbound', '[reply]'],
      /* Bracketed names, case, Unicode, punctuation, padding, a second line. */
      ['inbound', '[Chiamaka Okafor]'],
      ['inbound', '[AFFIRM]'],
      ['inbound', '[Adébáyọ̀]'],
      ['inbound', '[text message] Bola owes 5k'],
      ['inbound', '[text message]!'],
      ['inbound', ' [text message]'],
      ['inbound', '[text message]\nBola Ige'],
      ['inbound', '[number:2a]'],
      ['inbound', '[]'],
      ['outbound', '[template Ada Obi]'],
      /* Shaped like a template label, which proves nothing about who wrote it. */
      ['outbound', '[template rekoda_trial_ending]'],
      ['outbound', '[template ada_obi]'],
      ['outbound', '[text message]'],
      ['outbound', 'Saved: 2 wigs for Chiamaka'],
    ];
    for (const [direction, body] of [...kept, ...erased]) await stored(businessId, direction, body);

    const { count } = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.eraseStoredText(tx, businessId, { limit: 1_000 }),
    );

    expect(count).toBe(erased.length);
    expect(await bodies(businessId)).toEqual([
      ...kept.map(([, body]) => body),
      ...erased.map(() => '[erased]'),
    ]);
  });

  it("erases a customer's finished message whose outcome the handler wrote as a note", async () => {
    const businessId = await seedBusiness();
    await event(businessId, { error: 'assistant answered' });
    await event(businessId, { error: 'handed off to a human' });
    await event(businessId, {
      error: 'not processed: its job died; drafts pending then were retired',
    });

    const erased = await withBusiness(db, businessId, (tx) =>
      events.eraseFinishedMessagePayloads(tx, businessId),
    );

    expect(erased.count).toBe(3);
    expect(await payloads(businessId)).toEqual([
      { erased: true },
      { erased: true },
      { erased: true },
    ]);
  });
});

/**
 * A business with many messages (owner review of #437): seeded in bulk so the batches
 * really repeat (5,000 rows each), then erased in one transaction exactly as DELETE MY
 * DATA runs it.
 */
describe('erasure of a large history', () => {
  const ROWS = 12_345;

  async function bulk(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const thread = await conversationsRepo.resolveThread(tx, {
        kind: 'MERCHANT',
        businessId,
        channel: 'meta',
      });
      await tx.execute(sql`
        INSERT INTO conversation_messages
          (business_id, conversation_id, direction, kind, body, provider_message_id)
        SELECT ${businessId}::uuid, ${thread}::uuid, 'inbound', 'text',
               'sold Chiamaka Okafor ' || n || ' wigs', ${businessId} || '.wamid.' || n
          FROM generate_series(1, ${ROWS}) n`);
      await tx.execute(sql`
        INSERT INTO external_events
          (provider, event_type, external_id, payload, signature_valid, business_id, processed_at)
        SELECT 'meta', 'message.text', ${businessId} || '.ext.' || n,
               jsonb_build_object('v', 1, 'blob', repeat('x', 1500)), 1, ${businessId}::uuid, now()
          FROM generate_series(1, ${ROWS}) n`);
    });
  }

  const left = (businessId: string) =>
    withBusiness(db, businessId, async (tx) => {
      const [row] = [
        ...(await tx.execute<{ text: number; payloads: number }>(sql`
          SELECT
            (SELECT count(*)::int FROM conversation_messages
              WHERE business_id = ${businessId}::uuid AND body <> '[erased]') AS text,
            (SELECT count(*)::int FROM external_events
              WHERE business_id = ${businessId}::uuid AND payload <> '{"erased": true}'::jsonb) AS payloads`)),
      ];
      return row!;
    });

  it('erases every row across batches, once, and leaves another business alone', async () => {
    const businessId = await seedBusiness();
    const other = await seedBusiness();
    await bulk(businessId);
    await bulk(other);

    const started = Date.now();
    const erased = await withBusiness(db, businessId, (tx) =>
      customersRepo.eraseTextOutsideTheVault(tx, businessId, 'chat'),
    );
    const elapsedMs = Date.now() - started;

    expect(erased).toEqual({ messageText: ROWS, messagePayloads: ROWS });
    expect(await left(businessId)).toEqual({ text: 0, payloads: 0 });
    expect(await left(other)).toEqual({ text: ROWS, payloads: ROWS });
    /* Well inside the 30 s statement timeout each batch runs under. */
    expect(elapsedMs).toBeLessThan(30_000);

    /* A retry after it committed finds nothing left and changes nothing. */
    expect(
      await withBusiness(db, businessId, (tx) =>
        customersRepo.eraseTextOutsideTheVault(tx, businessId, 'chat'),
      ),
    ).toEqual({ messageText: 0, messagePayloads: 0 });
  });

  it('erases nothing when the transaction it runs in fails, and a retry then erases it all', async () => {
    const businessId = await seedBusiness();
    await bulk(businessId);

    await expect(
      withBusiness(db, businessId, async (tx) => {
        await customersRepo.eraseTextOutsideTheVault(tx, businessId, 'chat');
        throw new Error('the job failed after the erasure');
      }),
    ).rejects.toThrow(/after the erasure/);
    expect(await left(businessId)).toEqual({ text: ROWS, payloads: ROWS });
    const audit = await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`SELECT 1 FROM audit_events
                      WHERE business_id = ${businessId}::uuid AND entity = 'conversation_messages'`),
    );
    expect([...audit]).toHaveLength(0);

    expect(
      await withBusiness(db, businessId, (tx) =>
        customersRepo.eraseTextOutsideTheVault(tx, businessId, 'chat'),
      ),
    ).toEqual({ messageText: ROWS, messagePayloads: ROWS });
  });
});
