/**
 * One real purchase, one financial truth, in the database (migration 0158,
 * G-81, OD-23).
 *
 * Pins what the handler and the purchase work lean on: a HELD purchase is a
 * state of its own that no claim, sweep or "pending" read can reach; the
 * identity question is a continuation that names its held draft and nothing
 * else; `purchaseRecords` returns exactly the purchases of one total that a
 * new one may be (waiting previews, and bookings inside 24 hours, never a
 * lapsed preview, a voided booking or another business's); and the identity
 * lock serialises one business's purchases of one total, on separate
 * connections, and nothing else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  continuationsRepo,
  conversationsRepo,
  createDb,
  identity,
  purchaseIdentityRepo,
  spendRepo,
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

const MILO = {
  intent: 'RecordPurchase',
  supplierMention: null,
  description: '10 cartons of Milo',
  amount: 100_000,
  reportedPayment: 100_000,
  paymentMethod: 'cash',
  productMention: 'Milo',
  quantity: 10,
};

let seq = 0;
async function seedBusiness(): Promise<{ businessId: string; ownerId: string }> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481800${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Provisions',
    businessType: null,
    ownerUserId: user.id,
  });
  return { businessId: business.id, ownerId: user.id };
}

async function draft(
  businessId: string,
  command: Record<string, unknown> = MILO,
  options: { held?: boolean; requestedBy?: string | null; separateFrom?: string } = {},
): Promise<{ id: string; messageId: string }> {
  seq += 1;
  const n = seq;
  return withBusiness(app, businessId, async (tx) => {
    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: 'a purchase',
      providerMessageId: `wamid.pid-${n}`,
    });
    const recorded = await conversationsRepo.recordDraft(tx, {
      businessId,
      conversationMessageId: message.id,
      intent: 'RecordPurchase',
      command,
      model: null,
      previewed: true,
      requestedBy: options.requestedBy ?? null,
      held: options.held ?? false,
      separateFrom: options.separateFrom ?? null,
    });
    return { id: recorded.id, messageId: message.id };
  });
}

async function book(businessId: string, sourceId: string, amountK = 10_000_000) {
  return withBusiness(app, businessId, (tx) =>
    spendRepo.recordPurchase(tx, {
      businessId,
      description: '10 cartons of Milo',
      amountK,
      paidK: 0,
      method: null,
      sourceType: 'chat',
      sourceId,
      supplierId: null,
    }),
  );
}

async function stateOf(businessId: string, id: string): Promise<string | undefined> {
  return withBusiness(app, businessId, async (tx) => {
    const row = await conversationsRepo.draftStateOf(tx, businessId, id);
    return row?.state;
  });
}

describe('a held purchase (0158)', () => {
  it('is never claimed by a yes, never moved by the expiry sweep, never "pending"', async () => {
    const { businessId } = await seedBusiness();
    const held = await draft(businessId, MILO, { held: true });
    await withBusiness(app, businessId, async (tx) => {
      expect(await conversationsRepo.claimDraft(tx, held.id)).toEqual({ outcome: 'not_pending' });
      await conversationsRepo.expireStaleDrafts(tx, businessId, {
        now: new Date(Date.now() + 86_400_000),
      });
      expect(await conversationsRepo.pendingDraftToAnswer(tx, businessId)).toBeNull();
      expect((await conversationsRepo.latestDraftToAnswer(tx, businessId))?.state).toBe('held');
      expect(
        await conversationsRepo.latestDraftToAnswer(tx, businessId, { skipHeld: true }),
      ).toBeNull();
    });
    expect(await stateOf(businessId, held.id)).toBe('held');
  });

  it('is closed once: two answers racing release it exactly once', async () => {
    const { businessId } = await seedBusiness();
    const held = await draft(businessId, MILO, { held: true });
    const released = await Promise.all([
      withBusiness(app, businessId, (tx) => conversationsRepo.releaseHeld(tx, businessId, held.id)),
      withBusiness(app, businessId, (tx) => conversationsRepo.releaseHeld(tx, businessId, held.id)),
    ]);
    expect(released.filter(Boolean)).toHaveLength(1);
    expect(await stateOf(businessId, held.id)).toBe('superseded');
  });

  it('a refused yes turns its confirmed claim into a held question, and only a confirmed one', async () => {
    const { businessId } = await seedBusiness();
    const pending = await draft(businessId);
    await withBusiness(app, businessId, async (tx) => {
      expect(
        await conversationsRepo.holdRefusedPurchase(tx, businessId, pending.id, []),
      ).toBeNull();
      expect((await conversationsRepo.claimDraft(tx, pending.id)).outcome).toBe('claimed');
      expect(
        await conversationsRepo.holdRefusedPurchase(tx, businessId, pending.id, []),
      ).toMatchObject({ previousExpiresAt: expect.any(Date) });
    });
    expect(await stateOf(businessId, pending.id)).toBe('held');
  });

  it('an undelivered question is withdrawn, and an undelivered "separate" puts the question back', async () => {
    const { businessId } = await seedBusiness();
    const held = await draft(businessId, MILO, { held: true });
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.withdrawHeld(tx, businessId, held.id),
    );
    expect(await stateOf(businessId, held.id)).toBe('superseded');

    const asked = await draft(businessId, MILO, { held: true });
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.releaseHeld(tx, businessId, asked.id),
    );
    const fresh = await draft(businessId, MILO, { separateFrom: asked.id });
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.undoSeparate(tx, businessId, fresh.messageId, asked.id),
    );
    expect(await stateOf(businessId, asked.id)).toBe('held');
    expect(await stateOf(businessId, fresh.id)).toBe('superseded');
  });

  it('"separate" may only name another purchase draft, never itself or a non-purchase', async () => {
    const { businessId } = await seedBusiness();
    const held = await draft(businessId, MILO, { held: true });
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`UPDATE command_drafts SET separate_from = id WHERE id = ${held.id}::uuid`),
      ),
    ).rejects.toThrow();
    const expense = await draft(businessId);
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET intent = 'RecordExpense', separate_from = ${held.id}::uuid
           WHERE id = ${expense.id}::uuid`),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET separate_from = ${held.id}::uuid WHERE id = ${expense.id}::uuid`),
      ),
    ).resolves.toBeDefined();
  });
});

describe('the identity question as a continuation (0158)', () => {
  it('names its held draft, and nothing else', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const held = await draft(businessId, MILO, { held: true, requestedBy: ownerId });
    await withBusiness(app, businessId, async (tx) => {
      await continuationsRepo.openContinuation(tx, {
        businessId,
        userId: ownerId,
        sourceMessageId: held.messageId,
        state: { kind: 'clarification', expects: 'purchase_identity', draftId: held.id },
      });
      const open = await continuationsRepo.currentContinuation(tx, businessId, ownerId);
      expect(open?.state).toEqual({
        kind: 'clarification',
        expects: 'purchase_identity',
        draftId: held.id,
      });
      expect(await continuationsRepo.wasAskedAbout(tx, businessId, ownerId, held.id)).toBe(true);
    });
    /* A row that names no draft, or carries a topic, is refused by CHECK. */
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO conversation_continuations
            (business_id, user_id, source_message_id, kind, expects)
          VALUES (${businessId}::uuid, ${ownerId}::uuid, ${held.messageId}::uuid,
                  'clarification', 'purchase_identity')`),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO conversation_continuations
            (business_id, user_id, source_message_id, kind, expects, draft_id, topic)
          VALUES (${businessId}::uuid, ${ownerId}::uuid, ${held.messageId}::uuid,
                  'clarification', 'purchase_identity', ${held.id}::uuid, 'debtors')`),
      ),
    ).rejects.toThrow();
  });
});

describe('the purchases one total may be (purchaseRecords)', () => {
  it('waiting previews and bookings of that total, inside 24 hours, with their owner and bill', async () => {
    const { businessId, ownerId } = await seedBusiness();
    const waiting = await draft(businessId, MILO, { requestedBy: ownerId });
    await draft(businessId, { ...MILO, amount: 100_001 });
    const booked = await draft(businessId);
    await withBusiness(app, businessId, async (tx) => {
      await conversationsRepo.claimDraft(tx, booked.id);
    });
    const recorded = await book(businessId, booked.id);
    const { records } = await withBusiness(app, businessId, (tx) =>
      purchaseIdentityRepo.purchaseRecords(tx, businessId, 10_000_000),
    );
    expect(records.map((r) => [r.state, r.id])).toEqual([
      ['pending', waiting.id],
      ['booked', recorded.expenseId],
    ]);
    expect(records[0]!.requestedBy).toBe(ownerId);
    expect(records[1]!.billNumber).toBe(recorded.billNumber);
    expect(records[1]!.billNumber).toMatch(/^BILL-/);
  });

  it('never a lapsed preview, a held one, a voided or old booking, or the purchase itself', async () => {
    const { businessId } = await seedBusiness();
    const lapsed = await draft(businessId);
    await draft(businessId, MILO, { held: true });
    const self = await draft(businessId);
    await withBusiness(app, businessId, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE id = ${lapsed.id}::uuid`),
    );
    const voided = await book(businessId, 'void-me');
    const old = await book(businessId, 'old-one');
    await withBusiness(app, businessId, async (tx) => {
      await tx.execute(
        sql`UPDATE expenses SET status = 'voided' WHERE id = ${voided.expenseId}::uuid`,
      );
      await tx.execute(sql`
        UPDATE expenses SET created_at = clock_timestamp() - interval '24 hours 1 second'
         WHERE id = ${old.expenseId}::uuid`);
    });
    await book(businessId, self.id);
    const { records } = await withBusiness(app, businessId, (tx) =>
      purchaseIdentityRepo.purchaseRecords(tx, businessId, 10_000_000, {
        excludeDraftId: self.id,
      }),
    );
    expect(records).toEqual([]);
  });

  it("never another business's purchases", async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    await draft(theirs.businessId);
    await book(theirs.businessId, 'theirs-1');
    const { records } = await withBusiness(app, mine.businessId, (tx) =>
      purchaseIdentityRepo.purchaseRecords(tx, mine.businessId, 10_000_000),
    );
    expect(records).toEqual([]);
  });

  it('a "separate" preview carries exactly the records its question named', async () => {
    const { businessId } = await seedBusiness();
    const named = await draft(businessId);
    const held = await draft(businessId, MILO, { held: true });
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.nameHeldRecords(tx, businessId, held.id, [
        { draftId: named.id, expenseId: null },
      ]),
    );
    const fresh = await draft(businessId, MILO, { separateFrom: held.id });
    const facts = await withBusiness(app, businessId, (tx) =>
      purchaseIdentityRepo.draftFacts(tx, businessId, fresh.id),
    );
    expect(facts?.separateFrom).toEqual([{ draftId: named.id, expenseId: null }]);
    expect(facts?.self).toEqual({ draftId: fresh.id, expenseId: null });
  });

  it('a preview reads records by message ORDER, never by mixing clocks', async () => {
    const { businessId } = await seedBusiness();
    const first = await draft(businessId);
    const second = await draft(businessId);
    /* The second message reached Rekoda an instant before the first draft was
     * written; the first draft still came from an earlier message. */
    await withBusiness(app, businessId, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET created_at = clock_timestamp() + interval '1 minute'
         WHERE id = ${first.id}::uuid`),
    );
    const { records } = await withBusiness(app, businessId, (tx) =>
      purchaseIdentityRepo.purchaseRecords(tx, businessId, 10_000_000, {
        messageId: second.messageId,
        excludeDraftId: second.id,
      }),
    );
    expect(records.map((r) => r.id)).toEqual([first.id]);
  });
});

describe('the identity lock', () => {
  it('serialises one business’s purchases of one total on separate connections, and nothing else', async () => {
    const { businessId } = await seedBusiness();
    const other = await seedBusiness();
    const second = createDb(urls.app, { max: 1 });
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = withBusiness(app, businessId, async (tx) => {
        await purchaseIdentityRepo.lockPurchaseTotal(tx, businessId, 10_000_000);
        locked();
        await held;
      });
      await isLocked;
      const tryLock = (b: string, amountK: number) =>
        withBusiness(second.db, b, async (tx) => {
          const rows = await tx.execute<{ got: boolean }>(sql`
            SELECT pg_try_advisory_xact_lock(3, hashtext(${`${b}:${amountK}`})) AS got`);
          return [...rows][0]!.got;
        });
      expect(await tryLock(businessId, 10_000_000)).toBe(false);
      expect(await tryLock(businessId, 10_000_100)).toBe(true);
      expect(await tryLock(other.businessId, 10_000_000)).toBe(true);
      release();
      await holder;
      expect(await tryLock(businessId, 10_000_000)).toBe(true);
    } finally {
      await second.close();
    }
  });
});

describe('Codex review of #262: the comparison instant bounds the bookings', () => {
  it('a booking made after `asOf` is not one a message received at `asOf` can be', async () => {
    const { businessId } = await seedBusiness();
    const before = new Date(Date.now() - 60_000);
    await book(businessId, 'later-booking');
    const { records } = await withBusiness(app, businessId, (tx) =>
      purchaseIdentityRepo.purchaseRecords(tx, businessId, 10_000_000, { asOf: before }),
    );
    expect(records).toEqual([]);
  });
});

describe('Codex review of #262, round 2: the comparison instant bounds waiting previews too', () => {
  it('a preview recorded after `asOf` is not one a message received at `asOf` can be', async () => {
    const { businessId } = await seedBusiness();
    const before = new Date(Date.now() - 60_000);
    await draft(businessId);
    const { records } = await withBusiness(app, businessId, (tx) =>
      purchaseIdentityRepo.purchaseRecords(tx, businessId, 10_000_000, { asOf: before }),
    );
    expect(records).toEqual([]);
  });
});
