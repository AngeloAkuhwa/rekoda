/**
 * A preview WhatsApp accepted and then failed to deliver (G-20, migration
 * 0169).
 *
 * "Previewed" is set when WhatsApp ACCEPTS the send (G-23). A delivery that
 * fails afterwards arrives later, as a `failed` status webhook naming OUR
 * outbound wamid. The outbound reply row now records the inbound message it
 * answered (`reply_to_message_id`), so that wamid leads back to the draft the
 * preview showed. Pins: the pending preview it carried is marked unseen
 * (previewed false, its link proposal dropped); a draft that is no longer
 * pending, a reply that answered nothing, an unknown wamid and another
 * business's wamid all change nothing; and the link cannot name another
 * business's message.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  continuationsRepo,
  conversationsRepo,
  createDb,
  identity,
  jobsRepo,
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
  const asApp = createDb(urls.app, { max: 4 });
  app = asApp.db;
  closeApp = asApp.close;
});

afterAll(async () => {
  await closeApp();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const EXPENSE = {
  intent: 'RecordExpense',
  description: 'fuel',
  amount: 20_000,
  category: 'utilities',
  paymentMethod: 'cash',
};
const LINK = { survivorToken: 'CUSTOMER_A1', orphanToken: 'CUSTOMER_B2' };

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481900${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Provisions',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/**
 * An inbound request, its previewed draft, and the reply that carried the
 * preview, accepted by WhatsApp as `wamid`.
 */
async function previewed(
  businessId: string,
  options: { linked?: boolean; identityLink?: unknown } = {},
): Promise<{ messageId: string; draftId: string; wamid: string }> {
  seq += 1;
  const n = seq;
  return withBusiness(app, businessId, async (tx) => {
    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: 'bought fuel 20k',
      providerMessageId: `wamid.in-${n}`,
    });
    const draft = await conversationsRepo.recordDraft(tx, {
      businessId,
      conversationMessageId: message.id,
      intent: 'RecordExpense',
      command: EXPENSE,
      model: null,
      previewed: true,
      ...(options.identityLink ? { identityLink: options.identityLink } : {}),
    });
    const reply = await conversationsRepo.recordOutbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: 'Please check this before I save it',
      ...(options.linked === false ? {} : { replyToMessageId: message.id }),
    });
    const wamid = `wamid.out-${n}`;
    await conversationsRepo.markOutboundSent(tx, reply.id, wamid);
    return { messageId: message.id, draftId: draft.id, wamid };
  });
}

async function flags(businessId: string, draftId: string) {
  const rows = await withBusiness(app, businessId, (tx) =>
    tx.execute<{ previewed: boolean; link: unknown }>(sql`
      SELECT previewed, identity_link AS link FROM command_drafts
       WHERE business_id = ${businessId}::uuid AND id = ${draftId}::uuid`),
  );
  return [...rows][0];
}

const undelivered = async (businessId: string, wamid: string) =>
  (
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.markPreviewUndelivered(tx, businessId, wamid),
    )
  ).drafts;

async function draftRow(businessId: string, draftId: string) {
  const rows = await withBusiness(app, businessId, (tx) =>
    tx.execute<{ state: string; reason: string | null }>(sql`
      SELECT state, retired_reason AS reason FROM command_drafts
       WHERE business_id = ${businessId}::uuid AND id = ${draftId}::uuid`),
  );
  return [...rows][0];
}

const claim = (businessId: string, draftId: string, options = {}) =>
  withBusiness(app, businessId, (tx) => conversationsRepo.claimDraft(tx, draftId, options));

describe('a preview that failed after WhatsApp accepted it (G-20)', () => {
  it('is no longer previewed, and its link question was not asked', async () => {
    const businessId = await seedBusiness();
    const sent = await previewed(businessId, { identityLink: LINK });
    expect(await flags(businessId, sent.draftId)).toEqual({ previewed: true, link: LINK });

    expect(await undelivered(businessId, sent.wamid)).toBe(1);
    expect(await flags(businessId, sent.draftId)).toEqual({ previewed: false, link: null });

    /* A duplicate receipt is a no-op. */
    expect(await undelivered(businessId, sent.wamid)).toBe(0);
  });

  it.each(['confirmed', 'abandoned', 'superseded'])(
    'leaves a %s draft as it was',
    async (state) => {
      const businessId = await seedBusiness();
      const sent = await previewed(businessId);
      await withBusiness(app, businessId, (tx) =>
        tx.execute(sql`UPDATE command_drafts SET state = ${state}
                      WHERE business_id = ${businessId}::uuid AND id = ${sent.draftId}::uuid`),
      );
      expect(await undelivered(businessId, sent.wamid)).toBe(0);
      expect((await flags(businessId, sent.draftId))?.previewed).toBe(true);
    },
  );

  it('also clears a draft whose window lapsed before the receipt arrived (G-20)', async () => {
    const businessId = await seedBusiness();
    const sent = await previewed(businessId);
    await withBusiness(app, businessId, (tx) =>
      tx.execute(sql`UPDATE command_drafts SET state = 'expired'
                      WHERE business_id = ${businessId}::uuid AND id = ${sent.draftId}::uuid`),
    );
    expect(await undelivered(businessId, sent.wamid)).toBe(1);
    expect((await flags(businessId, sent.draftId))?.previewed).toBe(false);
  });

  it('changes nothing for a reply that answered no request, or a wamid it never sent', async () => {
    const businessId = await seedBusiness();
    const unlinked = await previewed(businessId, { linked: false });
    expect(await undelivered(businessId, unlinked.wamid)).toBe(0);
    expect(await undelivered(businessId, 'wamid.never-ours')).toBe(0);
    expect((await flags(businessId, unlinked.draftId))?.previewed).toBe(true);
  });

  it("never reaches another business's preview", async () => {
    const ada = await seedBusiness();
    const bisi = await seedBusiness();
    const adas = await previewed(ada);
    const bisis = await previewed(bisi);

    expect(await undelivered(bisi, adas.wamid)).toBe(0);
    expect((await flags(ada, adas.draftId))?.previewed).toBe(true);
    expect((await flags(bisi, bisis.draftId))?.previewed).toBe(true);
  });

  it("cannot record a reply to another business's message", async () => {
    const ada = await seedBusiness();
    const bisi = await seedBusiness();
    const adas = await previewed(ada);
    await expect(
      withBusiness(app, bisi, (tx) =>
        conversationsRepo.recordOutbound(tx, {
          businessId: bisi,
          channel: 'meta',
          kind: 'text',
          body: 'not yours',
          replyToMessageId: adas.messageId,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});

describe('an unseen preview can never be confirmed (G-20, owner ruling)', () => {
  it('a late failure retires the pending draft with an auditable reason', async () => {
    const businessId = await seedBusiness();
    const sent = await previewed(businessId);
    expect(await undelivered(businessId, sent.wamid)).toBe(1);
    expect(await draftRow(businessId, sent.draftId)).toEqual({
      state: 'superseded',
      reason: 'preview_not_delivered',
    });
    expect(await claim(businessId, sent.draftId)).toEqual({ outcome: 'not_pending' });
    /* A duplicate receipt changes nothing. */
    expect(await undelivered(businessId, sent.wamid)).toBe(0);
  });

  it('a send that failed outright leaves it pending but unconfirmable', async () => {
    const businessId = await seedBusiness();
    const sent = await previewed(businessId);
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.markDraftUnseen(tx, businessId, sent.messageId),
    );
    expect((await draftRow(businessId, sent.draftId))?.state).toBe('pending');
    expect(await claim(businessId, sent.draftId)).toEqual({ outcome: 'unseen' });
    expect((await draftRow(businessId, sent.draftId))?.state).toBe('pending');
  });

  it('an expired draft stays expired but is no longer previewed', async () => {
    const businessId = await seedBusiness();
    const sent = await previewed(businessId);
    await withBusiness(app, businessId, (tx) =>
      tx.execute(sql`UPDATE command_drafts SET state = 'expired'
                      WHERE business_id = ${businessId}::uuid AND id = ${sent.draftId}::uuid`),
    );
    await undelivered(businessId, sent.wamid);
    expect(await draftRow(businessId, sent.draftId)).toEqual({ state: 'expired', reason: null });
  });

  it('the claim itself refuses a pending draft that was never previewed', async () => {
    const businessId = await seedBusiness();
    const sent = await previewed(businessId);
    await withBusiness(app, businessId, (tx) =>
      tx.execute(sql`UPDATE command_drafts SET previewed = false
                      WHERE business_id = ${businessId}::uuid AND id = ${sent.draftId}::uuid`),
    );
    expect(await claim(businessId, sent.draftId)).toEqual({ outcome: 'unseen' });
    expect((await draftRow(businessId, sent.draftId))?.state).toBe('pending');
  });

  it('a draft that was previewed is still claimed', async () => {
    const businessId = await seedBusiness();
    const sent = await previewed(businessId);
    expect(await claim(businessId, sent.draftId)).toEqual({ outcome: 'claimed' });
  });

  it('a draft that is no financial preview (an erasure ask) is still claimed', async () => {
    const businessId = await seedBusiness();
    const sent = await previewed(businessId);
    await withBusiness(app, businessId, (tx) =>
      tx.execute(sql`UPDATE command_drafts SET previewed = false, intent = 'EraseData',
                             command = '{"intent":"EraseData"}'::jsonb
                      WHERE business_id = ${businessId}::uuid AND id = ${sent.draftId}::uuid`),
    );
    expect(await claim(businessId, sent.draftId)).toEqual({
      outcome: 'claimed',
    });
  });

  it('a late failure retires only the continuation that reply opened', async () => {
    const businessId = await seedBusiness();
    const owner = await withBusiness(app, businessId, async (tx) => {
      const rows = await tx.execute<{ user_id: string }>(
        sql`SELECT user_id FROM memberships WHERE business_id = ${businessId}::uuid LIMIT 1`,
      );
      return [...rows][0]!.user_id;
    });
    const asked = await previewed(businessId, { linked: true });
    const other = await previewed(businessId, { linked: true });
    const open = (sourceMessageId: string, expects = 'period') =>
      withBusiness(app, businessId, (tx) =>
        continuationsRepo.openContinuation(tx, {
          businessId,
          userId: owner,
          sourceMessageId,
          state: { kind: 'clarification', expects: expects as 'period', topic: 'sales_summary' },
        }),
      );
    const mine = await open(asked.messageId);
    const states = async () =>
      (
        await withBusiness(app, businessId, (tx) =>
          tx.execute<{ id: string; state: string }>(
            sql`SELECT id, state FROM conversation_continuations WHERE business_id = ${businessId}::uuid`,
          ),
        )
      ).map((r) => r.state);
    expect(await states()).toEqual(['open']);
    const result = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.markPreviewUndelivered(tx, businessId, other.wamid),
    );
    expect(result.continuations).toBe(0);
    expect(await states()).toEqual(['open']);
    const failed = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.markPreviewUndelivered(tx, businessId, asked.wamid),
    );
    expect(failed.continuations).toBe(1);
    expect(mine?.isNew).toBe(true);
    expect(await states()).toEqual(['superseded']);
    const again = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.markPreviewUndelivered(tx, businessId, asked.wamid),
    );
    expect(again).toEqual({ drafts: 0, continuations: 0 });
  });
});

describe('a receipt job that died still unsees its preview (G-20)', () => {
  it('reconciles from the dead job, once', async () => {
    const businessId = await seedBusiness();
    const sent = await previewed(businessId);
    const event = await withBusiness(app, businessId, (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO external_events (provider, event_type, external_id, payload, business_id, signature_valid)
        VALUES ('meta', 'status.failed', ${`st-${sent.wamid}`}, '{}'::jsonb, ${businessId}::uuid, 1)
        RETURNING id`),
    );
    const eventId = [...event][0]!.id;
    await withBusiness(app, businessId, async (tx) => {
      const job = await jobsRepo.enqueue(tx, {
        businessId,
        kind: 'delivery.status',
        payload: { eventId, outboundMessageId: sent.wamid },
        singletonKey: eventId,
        maxAttempts: 12,
      });
      await tx.execute(
        sql`UPDATE jobs SET state = 'dead', attempts = 12 WHERE id = ${job!.id}::uuid`,
      );
    });

    const first = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.reconcileDeadReceipts(tx, businessId),
    );
    expect(first).toBe(1);
    expect(await draftRow(businessId, sent.draftId)).toEqual({
      state: 'superseded',
      reason: 'preview_not_delivered',
    });
    const second = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.reconcileDeadReceipts(tx, businessId),
    );
    expect(second).toBe(0);
  });
});

describe('the claim exemption needs the stored command to agree (G-20)', () => {
  it('a financial command filed under an exempt intent column is still refused', async () => {
    const businessId = await seedBusiness();
    const sent = await previewed(businessId);
    await withBusiness(app, businessId, (tx) =>
      tx.execute(sql`UPDATE command_drafts SET previewed = false, intent = 'Query'
                      WHERE business_id = ${businessId}::uuid AND id = ${sent.draftId}::uuid`),
    );
    expect(await claim(businessId, sent.draftId)).toEqual({ outcome: 'unseen' });
  });
});
