/**
 * Catalogue synchronisation to the WABA (spec §3.2; W3, PR-086).
 *
 * What Meta shows a merchant's customers is a projection of the products
 * table, and these are the claims that keep it one: the first sync pushes
 * the whole sellable shelf and the second pushes NOTHING; a change
 * travels and an unchanged item does not; an emptied shelf flips to 'out
 * of stock'; a product taken off the catalogue goes 'out of stock' rather
 * than vanishing mid-conversation; the provider's per-item refusal is
 * recorded with its stated reason and re-pushed until it lands; and every
 * refusal (entitlement, connection, catalogue) costs nothing anywhere.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptFacet } from '@rekoda/core/vault';
import {
  billingRepo,
  catalogueRepo,
  createDb,
  identity,
  sql,
  stockRepo,
  wabaRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { CatalogueSyncService } from './catalogue-sync.service.js';
import type {
  CataloguePublisher,
  CataloguePushItem,
  CataloguePushOutcome,
} from './catalogue-publisher.js';

const MERCHANT_TOKEN = 'EAAG-golden-merchant-token';

/** Answers everything, remembers everything, fails what it is told to. */
class StubPublisher implements CataloguePublisher {
  calls: Array<{ catalogueId: string; items: CataloguePushItem[] }> = [];
  failRetailerIds = new Map<string, string>();

  async publish(input: {
    accessToken: string;
    catalogueId: string;
    items: readonly CataloguePushItem[];
  }): Promise<CataloguePushOutcome[]> {
    this.calls.push({ catalogueId: input.catalogueId, items: [...input.items] });
    return input.items.map((item) => {
      const error = this.failRetailerIds.get(item.retailerId);
      return error
        ? { retailerId: item.retailerId, ok: false, error }
        : { retailerId: item.retailerId, ok: true };
    });
  }
}

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;
let config: ApiConfig;
let publisher: StubPublisher;
let service: CatalogueSyncService;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = 'test-secret-at-least-32-characters-long';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['CONNECTION_KEY'] = randomBytes(32).toString('hex');
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  config = loadConfig();
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  publisher = new StubPublisher();
  service = new CatalogueSyncService(db, config, publisher);
});

let seq = 0;
async function seedMerchant(plan: 'integrate' | 'chat' = 'integrate', withCatalogue = true) {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481880${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await billingRepo.setPlan(db, {
    businessId: business.id,
    plan,
    expiresAt: null,
    actor: 'operator:test',
  });
  const connected = await withBusiness(db, business.id, (tx) =>
    wabaRepo.connectWaba(tx, {
      businessId: business.id,
      wabaId: `waba-cat-${seq}`,
      phoneNumberId: `pn-cat-${seq}`,
      accessTokenCipher: encryptFacet(
        MERCHANT_TOKEN,
        config.connectionKey,
        `${business.id}:waba_token`,
      ),
      tokenTail: MERCHANT_TOKEN.slice(-4),
    }),
  );
  if (connected.outcome !== 'connected') throw new Error('fixture: signup failed');
  if (withCatalogue) {
    await withBusiness(db, business.id, (tx) =>
      wabaRepo.setCatalogueId(tx, { businessId: business.id, catalogueId: `cat-${seq}` }),
    );
  }
  return { businessId: business.id, connectionId: connected.id };
}

async function priced(businessId: string, name: string, priceK: number): Promise<string> {
  const created = await withBusiness(db, businessId, (tx) =>
    catalogueRepo.createProduct(tx, businessId, { name, unitPriceK: priceK }),
  );
  return created.id;
}

describe('the shelf, projected', () => {
  it('pushes the whole sellable shelf once, then only what changed', async () => {
    const { businessId } = await seedMerchant();
    const wigId = await priced(businessId, 'wig', 150_000);
    await priced(businessId, 'gele styling', 40_000);
    /* The wig is counted; the service never was. Both are sellable. */
    await withBusiness(db, businessId, async (tx) => {
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 5,
        costK: 100_000,
        sourceType: 'chat',
      });
    });

    const first = await service.syncNow(businessId);
    expect(first).toEqual({ outcome: 'synced', pushed: 2, failed: 0 });
    expect(publisher.calls).toHaveLength(1);
    const pushed = publisher.calls[0]!.items;
    expect(
      pushed.map((i) => ({
        retailerId: i.retailerId,
        name: i.name,
        priceK: i.priceK,
        availability: i.availability,
      })),
    ).toEqual([
      {
        retailerId: expect.any(String),
        name: 'gele styling',
        priceK: 40_000,
        availability: 'in stock',
      },
      { retailerId: wigId, name: 'wig', priceK: 150_000, availability: 'in stock' },
    ]);

    /* Nothing changed: nothing travels, and the provider is not rung. */
    expect(await service.syncNow(businessId)).toEqual({ outcome: 'nothing_to_push' });
    expect(publisher.calls).toHaveLength(1);

    /* A price change travels ALONE. */
    await withBusiness(db, businessId, (tx) =>
      catalogueRepo.editProduct(tx, businessId, wigId, { unitPriceK: 160_000 }),
    );
    expect(await service.syncNow(businessId)).toEqual({ outcome: 'synced', pushed: 1, failed: 0 });
    expect(publisher.calls[1]!.items).toEqual([
      {
        retailerId: wigId,
        name: 'wig',
        priceK: 160_000,
        currency: 'NGN',
        availability: 'in stock',
      },
    ]);

    const state = await withBusiness(db, businessId, (tx) =>
      wabaRepo.catalogueSyncStateFor(tx, businessId),
    );
    expect(state).toMatchObject({ syncedCount: 2, failedCount: 0, pendingCount: 0 });
  });

  it('an emptied shelf flips to out of stock; a delisted product never vanishes', async () => {
    const { businessId } = await seedMerchant();
    const wigId = await priced(businessId, 'wig', 150_000);
    await withBusiness(db, businessId, async (tx) => {
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 2,
        costK: 40_000,
        sourceType: 'chat',
      });
    });
    await service.syncNow(businessId);

    /* The last two sell: the catalog must stop offering them. */
    await withBusiness(db, businessId, (tx) =>
      stockRepo.recordSaleMovements(tx, businessId, [{ name: 'wig', quantity: 2 }], 'inv-cat-1'),
    );
    expect(await service.syncNow(businessId)).toEqual({ outcome: 'synced', pushed: 1, failed: 0 });
    expect(publisher.calls[1]!.items[0]).toMatchObject({
      retailerId: wigId,
      availability: 'out of stock',
    });

    /* Delisted from the catalogue: OUT OF STOCK at Meta, never deleted —
     * a customer mid-conversation about it is told it is gone, not shown
     * a ghost. */
    await withBusiness(db, businessId, (tx) =>
      catalogueRepo.editProduct(tx, businessId, wigId, { unitPriceK: null }),
    );
    /* Already out of stock, so nothing NEW to say. */
    expect(await service.syncNow(businessId)).toEqual({ outcome: 'nothing_to_push' });
  });

  it("records the provider's per-item refusal with its reason, and re-pushes it until it lands", async () => {
    const { businessId, connectionId } = await seedMerchant();
    const wigId = await priced(businessId, 'wig', 150_000);
    await priced(businessId, 'lace', 80_000);
    publisher.failRetailerIds.set(wigId, 'Name too generic for commerce policy');

    expect(await service.syncNow(businessId)).toEqual({ outcome: 'synced', pushed: 1, failed: 1 });
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ status: string; error: string | null }>(sql`
        SELECT status, error FROM waba_catalogue_items
        WHERE business_id = ${businessId}::uuid AND product_id = ${wigId}::uuid
      `),
    );
    expect([...rows]).toEqual([
      { status: 'FAILED', error: 'Name too generic for commerce policy' },
    ]);

    /* A failure is not a state to settle into: the next sync re-pushes
     * exactly the failed item, and success replaces the record. */
    publisher.failRetailerIds.clear();
    expect(await service.syncNow(businessId)).toEqual({ outcome: 'synced', pushed: 1, failed: 0 });
    expect(publisher.calls[1]!.items.map((i) => i.retailerId)).toEqual([wigId]);
    const state = await withBusiness(db, businessId, (tx) =>
      wabaRepo.catalogueSyncStateFor(tx, businessId),
    );
    expect(state).toMatchObject({ syncedCount: 2, failedCount: 0, pendingCount: 0 });

    /* And the record's own coherence is the database's: a failure without
     * a reason is unrepresentable. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO waba_catalogue_items
            (business_id, waba_connection_id, product_id, retailer_id, synced_name,
             synced_price_k, synced_availability, status)
          VALUES (${businessId}::uuid, ${connectionId}::uuid, ${wigId}::uuid, 'r-x', 'wig',
                  1, 'in stock', 'FAILED')
        `),
      ),
    ).rejects.toThrow(/waba_catalogue_items/);
  });

  it('refuses without spending: entitlement, connection, catalogue, in that order', async () => {
    const chatOnly = await seedMerchant('chat');
    await priced(chatOnly.businessId, 'wig', 150_000);
    expect(await service.syncNow(chatOnly.businessId)).toEqual({ outcome: 'not_entitled' });

    const noCatalogue = await seedMerchant('integrate', false);
    await priced(noCatalogue.businessId, 'wig', 150_000);
    expect(await service.syncNow(noCatalogue.businessId)).toEqual({ outcome: 'no_catalogue' });

    /* No connection at all. */
    const user = await identity.upsertUserByPhone(db, '+2348188099901');
    const bare = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await billingRepo.setPlan(db, {
      businessId: bare.id,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });
    expect(await service.syncNow(bare.id)).toEqual({ outcome: 'no_connection' });

    /* Every refusal cost nothing: the provider was never rung. */
    expect(publisher.calls).toHaveLength(0);
  });
});
