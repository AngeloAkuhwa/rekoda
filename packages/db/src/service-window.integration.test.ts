/**
 * When the merchant last wrote to Rekoda's number (G-67).
 *
 * The 24-hour service window is opened by the recipient's message, so a
 * proactive send to the owner asks this before choosing free-form or
 * template. Pins: no inbound message is no window; the newest inbound wins;
 * Rekoda's own outbound replies never open it; and another business's
 * messages are invisible.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { conversationsRepo, createDb, identity, withBusiness, type Db } from './index.js';
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

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481950${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Provisions',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function inboundAt(businessId: string, at: Date): Promise<void> {
  seq += 1;
  await withBusiness(app, businessId, async (tx) => {
    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: 'hello',
      providerMessageId: `wamid.win-${seq}`,
    });
    await tx.execute(
      sql`UPDATE conversation_messages SET created_at = ${at.toISOString()}::timestamptz WHERE id = ${message.id}`,
    );
  });
}

const lastInbound = async (businessId: string) =>
  (
    await withBusiness(app, businessId, (tx) =>
      conversationsRepo.lastMerchantInboundAt(tx, businessId),
    )
  ).at;

describe('lastMerchantInboundAt', () => {
  it("returns the database's own time, so the window is judged on one clock", async () => {
    const business = await seedBusiness();
    await inboundAt(business, new Date(Date.now() - 60_000));
    const { at, now } = await withBusiness(app, business, (tx) =>
      conversationsRepo.lastMerchantInboundAt(tx, business),
    );
    expect(at).not.toBeNull();
    expect(now.getTime() - at!.getTime()).toBeGreaterThanOrEqual(59_000);
    expect(now.getTime() - at!.getTime()).toBeLessThan(120_000);
  });

  it('is null for a merchant who has never written', async () => {
    const business = await seedBusiness();
    expect(await lastInbound(business)).toBeNull();
  });

  it('is the newest inbound message', async () => {
    const business = await seedBusiness();
    await inboundAt(business, new Date('2026-10-20T08:00:00.000Z'));
    await inboundAt(business, new Date('2026-10-22T09:30:00.000Z'));
    await inboundAt(business, new Date('2026-10-21T10:00:00.000Z'));
    expect((await lastInbound(business))?.toISOString()).toBe('2026-10-22T09:30:00.000Z');
  });

  it('is not moved by a reply Rekoda sent', async () => {
    const business = await seedBusiness();
    await inboundAt(business, new Date('2026-10-20T08:00:00.000Z'));
    await withBusiness(app, business, (tx) =>
      conversationsRepo.recordOutbound(tx, {
        businessId: business,
        channel: 'meta',
        kind: 'text',
        body: 'Done',
      }),
    );
    expect((await lastInbound(business))?.toISOString()).toBe('2026-10-20T08:00:00.000Z');
  });

  it("does not see another business's messages", async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    await inboundAt(theirs, new Date('2026-10-22T09:30:00.000Z'));
    expect(await lastInbound(mine)).toBeNull();
  });
});
