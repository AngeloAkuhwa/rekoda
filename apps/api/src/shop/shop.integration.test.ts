/**
 * The hosted shop, end to end: a slug in a URL, no session anywhere.
 *
 * This is the first surface Rekoda serves to strangers, so the claims worth
 * pinning are mostly about what it does NOT do. A published shop shows the
 * catalogue its owner listed and priced, and nothing else reaches the wire:
 * no stock counts, no hidden products, no unpriced ones, and nothing at all
 * about the business behind it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  publicOrderResponse,
  publicShopIndexResponse,
  publicShopResponse,
  reportsInvoicesResponse,
  shopSettingsResponse,
} from '@rekoda/contracts';
import { usagePeriod } from '@rekoda/core';
import {
  billingRepo,
  createDb,
  issueRepo,
  schema,
  stockRepo,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;
let storageRoot: string;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  storageRoot = await mkdtemp(join(tmpdir(), 'rekoda-shop-'));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_REVEAL_OTP'] = '1';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  process.env['REKODA_LOCAL_STORAGE'] = storageRoot;
  /* Low enough to reach in a test; the production default is far higher. */
  process.env['REKODA_SHOP_ORDERS_PER_HOUR'] = '3';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  delete process.env['REKODA_LOCAL_STORAGE'];
  delete process.env['REKODA_SHOP_ORDERS_PER_HOUR'];
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(urls);
});

function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Deliberately no headers: a customer has no session and never gets one. */
const anonymous = (url: string) => app.inject({ method: 'GET', url });

async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode?: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = await post(
    '/v1/businesses',
    { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  const session = created.json() as { sessionToken: string; businessId: string };
  return {
    businessId: session.businessId,
    auth: { authorization: `Bearer ${session.sessionToken}` },
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/**
 * A shop with one of everything the page has to decide about: listed and
 * priced, listed and unpriced, hidden but priced.
 */
async function seedCatalogue(businessId: string, auth: Record<string, string>) {
  const ids = await withBusiness(db, businessId, async (tx) => {
    const out: Record<string, string> = {};
    for (const [name, count] of [
      ['Ankara bale', 10],
      ['Head tie', 40],
      ['Aso oke set', 3],
    ] as const) {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, name);
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: product.id,
        delta: count,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: `seed-${name}`,
      });
      out[name] = product.id;
    }
    return out;
  });

  await post('/v1/catalogue/product', { id: ids['Ankara bale'], unitPriceK: 850_000 }, auth);
  await post(
    '/v1/catalogue/product',
    { id: ids['Ankara bale'], description: 'Six yards, wax print' },
    auth,
  );
  /* Priced but taken out of the shop. */
  await post('/v1/catalogue/product', { id: ids['Aso oke set'], unitPriceK: 4_000_000 }, auth);
  await post('/v1/catalogue/product', { id: ids['Aso oke set'], active: false }, auth);
  /* Head tie is listed and has never been priced. */
  return ids;
}

const publish = (auth: Record<string, string>, slug: string, published = true) =>
  post(
    '/v1/shop-settings',
    { slug, displayName: 'Ada Fashion', tagline: 'Wax print by the bale', published },
    auth,
  );

describe('the settings a merchant sees first', () => {
  it('refuses a caller with no session', async () => {
    expect((await anonymous('/v1/shop-settings')).statusCode).toBe(401);
    expect((await post('/v1/shop-settings', { slug: 'x' })).statusCode).toBe(401);
  });

  it('offers a handle built from their business name, and no shop yet', async () => {
    const { auth } = await onboard('+2348177400001');
    const settings = shopSettingsResponse.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/shop-settings',
          headers: auth,
        })
      ).json(),
    );

    expect(settings.shop).toBeNull();
    expect(settings.suggestedSlug).toBe('ada-fashion');
    expect(settings.sellableCount).toBe(0);
  });

  /* Publishing an empty page is worse than not publishing: a customer opens
   * it once, finds nothing, and does not come back. */
  it('refuses to publish a shop with nothing priced in it', async () => {
    const { auth } = await onboard('+2348177400002');
    expect((await publish(auth, 'ada-fashion')).json()).toEqual({ outcome: 'nothing_to_sell' });
    expect((await anonymous('/v1/shop/ada-fashion')).statusCode).toBe(404);
  });

  it('refuses a handle that is not one', async () => {
    const { businessId, auth } = await onboard('+2348177400003');
    await seedCatalogue(businessId, auth);
    expect((await publish(auth, 'Ada Fashion')).json()).toEqual({ outcome: 'bad_slug' });
    expect((await publish(auth, 'ad')).json()).toEqual({ outcome: 'bad_slug' });
  });

  it('keeps publishing behind Integrate, and keeps drafts open to every plan', async () => {
    const { businessId, auth } = await onboard('+2348177400008');
    await seedCatalogue(businessId, auth);
    /* The pricing page sells the shop link under Integrate; a Chat merchant
     * publishing anyway made the card and the door disagree. */
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'chat',
      expiresAt: null,
      actor: 'operator:test',
    });

    expect((await publish(auth, 'ada-chat-shop')).json()).toEqual({ outcome: 'needs_integrate' });
    /* A draft is not public and is always allowed: the gate is on going
     * public, never on keeping what was written. */
    expect(
      (
        await post(
          '/v1/shop-settings',
          { slug: 'ada-chat-shop', displayName: 'Ada Fashion', tagline: null, published: false },
          auth,
        )
      ).json(),
    ).toMatchObject({ outcome: 'saved', published: false });

    await billingRepo.setPlan(db, {
      businessId,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });
    expect((await publish(auth, 'ada-chat-shop')).json()).toMatchObject({ outcome: 'saved' });
  });

  it('tells the second merchant a handle is taken', async () => {
    const first = await onboard('+2348177400004');
    const second = await onboard('+2348177400005');
    await seedCatalogue(first.businessId, first.auth);
    await seedCatalogue(second.businessId, second.auth);

    expect((await publish(first.auth, 'ada-fashion')).json()).toMatchObject({ outcome: 'saved' });
    expect((await publish(second.auth, 'ada-fashion')).json()).toEqual({ outcome: 'slug_taken' });
  });
});

describe('the page a customer opens', () => {
  it('answers with no session at all', async () => {
    const { businessId, auth } = await onboard('+2348177400006');
    await seedCatalogue(businessId, auth);
    await publish(auth, 'ada-fashion');

    const res = await anonymous('/v1/shop/ada-fashion');
    expect(res.statusCode).toBe(200);
    const shop = publicShopResponse.parse(res.json());
    expect(shop).toMatchObject({
      slug: 'ada-fashion',
      displayName: 'Ada Fashion',
      tagline: 'Wax print by the bale',
      whatsappE164: '+2348177400006',
    });
  });

  /**
   * Listed AND priced, and nothing else. A hidden product is hidden; an
   * unpriced one cannot be sold from a page with no way to ask the price.
   */
  it('shows only what is listed and priced', async () => {
    const { businessId, auth } = await onboard('+2348177400007');
    await seedCatalogue(businessId, auth);
    await publish(auth, 'ada-fashion');

    const shop = publicShopResponse.parse((await anonymous('/v1/shop/ada-fashion')).json());
    expect(shop.products.map((p) => p.name)).toEqual(['Ankara bale']);
    expect(shop.products[0]).toMatchObject({
      priceK: 850_000,
      description: 'Six yards, wax print',
    });
  });

  /**
   * How many are left is the merchant's business and a competitor's homework,
   * and a customer told there are two left is being pressured, not informed.
   */
  it('never puts a stock count on the wire', async () => {
    const { businessId, auth } = await onboard('+2348177400008');
    await seedCatalogue(businessId, auth);
    await publish(auth, 'ada-fashion');

    const body = (await anonymous('/v1/shop/ada-fashion')).body;
    expect(body).not.toContain('onHand');
    expect(body).not.toContain('"10"');
    expect(JSON.parse(body).products[0]).not.toHaveProperty('onHand');
  });

  /* Nothing about the business behind the shop. The lookup cannot reach that
   * row at all, and this is the assertion that says so out loud. */
  it('says nothing about the business itself', async () => {
    const { businessId, auth } = await onboard('+2348177400009');
    await seedCatalogue(businessId, auth);
    await publish(auth, 'ada-fashion');

    const body = (await anonymous('/v1/shop/ada-fashion')).body;
    for (const leak of ['businessId', businessId, 'plan', 'trial', 'tin', 'rcNumber']) {
      expect(body).not.toContain(leak);
    }
  });

  it('is not there before it is published, and not there after it is taken down', async () => {
    const { businessId, auth } = await onboard('+2348177400010');
    await seedCatalogue(businessId, auth);

    await publish(auth, 'ada-fashion', false);
    expect((await anonymous('/v1/shop/ada-fashion')).statusCode).toBe(404);

    await publish(auth, 'ada-fashion', true);
    expect((await anonymous('/v1/shop/ada-fashion')).statusCode).toBe(200);

    await publish(auth, 'ada-fashion', false);
    expect((await anonymous('/v1/shop/ada-fashion')).statusCode).toBe(404);
  });

  it('answers the same way for a slug nobody has and one that is not a slug', async () => {
    expect((await anonymous('/v1/shop/nobody-here')).statusCode).toBe(404);
    expect((await anonymous('/v1/shop/NOT-A-SLUG')).statusCode).toBe(404);
  });
});

/**
 * The list a sitemap is built from.
 *
 * Its own path, `v1/shops`, and that is not a style choice: every route under
 * `v1/shop` is a slug, so a listing route there would go dark the day a
 * merchant chose that word as their handle.
 */
/**
 * A shop bigger than one page (task #55).
 *
 * The endpoint used to serve a capped read of the catalogue, so a big shop
 * silently published a fraction of itself with nothing saying so — and a
 * customer, unlike a merchant, has named nothing to look up and reads no
 * captions. The shop pages instead: sellable products are filtered AND paged
 * in SQL, and every page names its place.
 */
describe('a shop bigger than one page', () => {
  async function seedBigShop(businessId: string, auth: Record<string, string>, howMany: number) {
    const ids = await withBusiness(db, businessId, async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < howMany; i += 1) {
        const product = await stockRepo.findOrCreateProduct(
          tx,
          businessId,
          `Item ${String(i + 1).padStart(3, '0')}`,
        );
        out.push(product.id);
      }
      return out;
    });
    for (const id of ids) {
      await post('/v1/catalogue/product', { id, unitPriceK: 50_000 }, auth);
    }
  }

  it('serves every product across pages, each one exactly once', async () => {
    const { businessId, auth } = await onboard('+2348177400021');
    /* Sixty-five sellable products: one full page of sixty and a second of
     * five. Every one must appear, on exactly one page. */
    await seedBigShop(businessId, auth, 65);
    await publish(auth, 'big-provisions');

    const one = publicShopResponse.parse((await anonymous('/v1/shop/big-provisions')).json());
    expect(one).toMatchObject({ page: 1, pageCount: 2, productsTotal: 65 });
    expect(one.products).toHaveLength(60);

    const two = publicShopResponse.parse(
      (await anonymous('/v1/shop/big-provisions?page=2')).json(),
    );
    expect(two).toMatchObject({ page: 2, pageCount: 2, productsTotal: 65 });
    expect(two.products).toHaveLength(5);

    const seen = new Set([...one.products, ...two.products].map((p) => p.id));
    expect(seen.size).toBe(65);
  });

  it('refuses a page past the end, and forgives a mangled one', async () => {
    const { businessId, auth } = await onboard('+2348177400022');
    await seedBigShop(businessId, auth, 3);
    await publish(auth, 'small-shop');

    /* Past the end is a 404: that URL is only ever constructed, and serving
     * page one under it would hand crawlers duplicate pages. */
    expect((await anonymous('/v1/shop/small-shop?page=2')).statusCode).toBe(404);
    /* Mangled is page one: a shared link that lost its query should still
     * open the shop. */
    const forgiving = publicShopResponse.parse(
      (await anonymous('/v1/shop/small-shop?page=banana')).json(),
    );
    expect(forgiving.page).toBe(1);
    expect(forgiving.products).toHaveLength(3);
  });

  it('counts only what a customer could buy', async () => {
    const { businessId, auth } = await onboard('+2348177400023');
    await seedCatalogue(businessId, auth);
    await publish(auth, 'ada-counted');

    /* Three products exist; one is hidden, one unpriced. The total a page
     * states is the SELLABLE total, because that is the shop the customer is
     * actually in. */
    const shop = publicShopResponse.parse((await anonymous('/v1/shop/ada-counted')).json());
    expect(shop.productsTotal).toBe(1);
    expect(shop.pageCount).toBe(1);
  });
});

describe('the list of open shops', () => {
  it('needs no session, and carries slugs and dates only', async () => {
    const { businessId, auth } = await onboard('+2348177300010');
    /* A shop with nothing priced in it cannot be opened at all, which is a
     * guard this test learned about by tripping over it. */
    await seedCatalogue(businessId, auth);
    await publish(auth, 'ada-fashion');

    const res = await anonymous('/v1/shops');
    expect(res.statusCode).toBe(200);
    const body = publicShopIndexResponse.parse(res.json());
    expect(body).toEqual({
      shops: [{ slug: 'ada-fashion', updatedAt: expect.any(String) }],
      truncated: false,
    });

    /* The thing this response must NOT become. Every one of these is public
     * on the shop's own page; a downloadable file that gathers them for every
     * merchant at once is a directory, which is a different product. */
    const raw = res.body;
    for (const leak of ['Ada Fashion', 'Wax print', '+234', 'businessId']) {
      expect(raw).not.toContain(leak);
    }
  });

  it('never lists a shop that is not open', async () => {
    const { businessId, auth } = await onboard('+2348177300011');
    await seedCatalogue(businessId, auth);
    await publish(auth, 'ada-fashion', false);
    expect(publicShopIndexResponse.parse((await anonymous('/v1/shops')).json()).shops).toEqual([]);

    await publish(auth, 'ada-fashion', true);
    expect(
      publicShopIndexResponse.parse((await anonymous('/v1/shops')).json()).shops.map((s) => s.slug),
    ).toEqual(['ada-fashion']);

    await publish(auth, 'ada-fashion', false);
    expect(publicShopIndexResponse.parse((await anonymous('/v1/shops')).json()).shops).toEqual([]);
  });

  it('answers with an empty list rather than an error when nobody has opened one', async () => {
    const res = await anonymous('/v1/shops');
    expect(res.statusCode).toBe(200);
    expect(publicShopIndexResponse.parse(res.json())).toEqual({ shops: [], truncated: false });
  });
});

describe('a photo on a public page', () => {
  it('is served to anybody, cacheable, with the type read from its bytes', async () => {
    const { businessId, auth } = await onboard('+2348177400011');
    const ids = await seedCatalogue(businessId, auth);
    await publish(auth, 'ada-fashion');

    const boundary = '----rekodashop';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
      ),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await app.inject({
      method: 'POST',
      url: `/v1/catalogue/${ids['Ankara bale']}/image`,
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...auth },
    });

    const shop = publicShopResponse.parse((await anonymous('/v1/shop/ada-fashion')).json());
    expect(shop.products[0]!.imagePath).toBe(`/v1/shop/ada-fashion/photo/${ids['Ankara bale']}`);

    const served = await anonymous(shop.products[0]!.imagePath!);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(String(served.headers['cache-control'])).toContain('public');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
  });

  /**
   * The route is keyed on the slug as well as the product, so one shop's URL
   * can never serve another shop's image even with a real product id.
   */
  it('will not serve another shop’s product through this shop’s URL', async () => {
    const mine = await onboard('+2348177400012');
    const theirs = await onboard('+2348177400013');
    await seedCatalogue(mine.businessId, mine.auth);
    const theirIds = await seedCatalogue(theirs.businessId, theirs.auth);
    await publish(mine.auth, 'my-shop');
    await publish(theirs.auth, 'their-shop');

    const served = await anonymous(`/v1/shop/my-shop/photo/${theirIds['Ankara bale']}`);
    expect(served.statusCode).toBe(404);
  });

  it('404s a product with no photo rather than an empty 200', async () => {
    const { businessId, auth } = await onboard('+2348177400014');
    const ids = await seedCatalogue(businessId, auth);
    await publish(auth, 'ada-fashion');
    expect((await anonymous(`/v1/shop/ada-fashion/photo/${ids['Ankara bale']}`)).statusCode).toBe(
      404,
    );
  });
});

describe('a customer orders from the shop (fix-plan 6, M5b)', () => {
  async function openShop(phone: string, slug: string) {
    const { businessId, auth } = await onboard(phone);
    const ids = await seedCatalogue(businessId, auth);
    expect((await publish(auth, slug)).json()).toMatchObject({ outcome: 'saved' });
    return { businessId, auth, ids };
  }

  const order = (slug: string, payload: Record<string, unknown>) =>
    post(`/v1/shop/${slug}/orders`, payload);

  it('books the whole sale at the SERVER price, once, and meters the merchant', async () => {
    const { businessId, auth, ids } = await openShop('+2348177400030', 'ada-orders');
    const clientRef = randomUUID();

    const placed = publicOrderResponse.parse(
      (
        await order('ada-orders', {
          items: [{ productId: ids['Ankara bale'], quantity: 2 }],
          customerName: 'Chidi Okafor',
          customerPhone: '0803 555 1234',
          clientRef,
        })
      ).json(),
    );
    expect(placed).toMatchObject({
      outcome: 'placed',
      totalK: 1_700_000,
      displayName: 'Ada Fashion',
    });
    if (placed.outcome !== 'placed') return;
    expect(placed.orderNumber).toMatch(/^ORD-/);
    expect(placed.invoiceNumber).toMatch(/^INV-/);

    /* The merchant sees a confirmed order attached to its invoice. */
    const register = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(register.orders[0]).toMatchObject({
      orderNumber: placed.orderNumber,
      status: 'confirmed',
      invoiceNumber: placed.invoiceNumber,
      totalK: 1_700_000,
    });
    expect(register.invoices[0]).toMatchObject({ totalK: 1_700_000, balanceDueK: 1_700_000 });

    /* Stock moved and the books balance. */
    const stock = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId));
    expect(stock.rows.find((p) => p.name === 'Ankara bale')?.onHand).toBe(8);
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries.reduce((n, e) => n + e.debitK, 0)).toBe(
      entries.reduce((n, e) => n + e.creditK, 0),
    );

    /* One order and one document spent, exactly like a chat capture. */
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'orders')?.used).toBe(1);
    expect(usage.find((r) => r.unit === 'documents')?.used).toBe(1);

    /* A resubmitted checkout books nothing twice. */
    const again = publicOrderResponse.parse(
      (
        await order('ada-orders', {
          items: [{ productId: ids['Ankara bale'], quantity: 2 }],
          customerName: 'Chidi Okafor',
          customerPhone: '0803 555 1234',
          clientRef,
        })
      ).json(),
    );
    expect(again).toEqual({ outcome: 'duplicate' });
    const usageAfter = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usageAfter.find((r) => r.unit === 'orders')?.used).toBe(1);
    expect(usageAfter.find((r) => r.unit === 'documents')?.used).toBe(1);
  });

  it('a de-listed item, a bad phone and a dead slug each get a sentence, and book nothing', async () => {
    const { businessId, ids } = await openShop('+2348177400031', 'ada-refusals');

    /* Hidden between the shop page and the checkout. */
    expect(
      publicOrderResponse.parse(
        (
          await order('ada-refusals', {
            items: [{ productId: ids['Aso oke set'], quantity: 1 }],
            customerName: 'Chidi Okafor',
            customerPhone: '08035551234',
            clientRef: randomUUID(),
          })
        ).json(),
      ),
    ).toEqual({ outcome: 'items_changed' });

    expect(
      publicOrderResponse.parse(
        (
          await order('ada-refusals', {
            items: [{ productId: ids['Ankara bale'], quantity: 1 }],
            customerName: 'Chidi Okafor',
            customerPhone: 'no digits',
            clientRef: randomUUID(),
          })
        ).json(),
      ),
    ).toEqual({ outcome: 'bad_phone' });

    expect(
      publicOrderResponse.parse(
        (
          await order('no-such-shop', {
            items: [{ productId: ids['Ankara bale'], quantity: 1 }],
            customerName: 'Chidi Okafor',
            customerPhone: '08035551234',
            clientRef: randomUUID(),
          })
        ).json(),
      ),
    ).toEqual({ outcome: 'shop_gone' });

    /* Nothing was booked and nothing was spent by any refusal. */
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'orders')?.used ?? 0).toBe(0);
    expect(usage.find((r) => r.unit === 'documents')?.used ?? 0).toBe(0);
  });

  it('a plan with no order capture answers closed, and spends nothing', async () => {
    const { businessId, ids } = await openShop('+2348177400032', 'ada-closed');
    /* Chat has no automatic order capture; the trial does. The shop stayed
     * published from the trial, and the honest answer at the counter is a
     * sentence, not an error. */
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'chat',
      expiresAt: null,
      actor: 'operator:test',
    });

    expect(
      publicOrderResponse.parse(
        (
          await order('ada-closed', {
            items: [{ productId: ids['Ankara bale'], quantity: 1 }],
            customerName: 'Chidi Okafor',
            customerPhone: '08035551234',
            clientRef: randomUUID(),
          })
        ).json(),
      ),
    ).toEqual({ outcome: 'closed' });

    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'orders')?.used ?? 0).toBe(0);
  });
});

describe('the storefront cannot be farmed (fix-plan 7, H7b)', () => {
  async function openShop(phone: string, slug: string) {
    const { businessId, auth } = await onboard(phone);
    const ids = await seedCatalogue(businessId, auth);
    expect((await publish(auth, slug)).json()).toMatchObject({ outcome: 'saved' });
    return { businessId, auth, ids };
  }

  const order = (slug: string, payload: Record<string, unknown>) =>
    post(`/v1/shop/${slug}/orders`, payload);

  const customersOf = (businessId: string) =>
    withBusiness(db, businessId, (tx) => tx.select().from(schema.customers));

  /**
   * Every refused order used to write the stranger's name and phone into the
   * vault BEFORE deciding to refuse — so a bot cycling random identities
   * against a closed shop filled a merchant's customer vault for free. The
   * identity is resolved only once the order has cleared every gate.
   */
  it('a refused order writes nothing into the vault', async () => {
    const { businessId, ids } = await openShop('+2348177400040', 'ada-novault');

    /* A de-listed item: refused before any identity work. */
    expect(
      publicOrderResponse.parse(
        (
          await order('ada-novault', {
            items: [{ productId: ids['Aso oke set'], quantity: 1 }],
            customerName: 'Bot Farm',
            customerPhone: '08031110001',
            clientRef: randomUUID(),
          })
        ).json(),
      ),
    ).toEqual({ outcome: 'items_changed' });
    expect(await customersOf(businessId)).toHaveLength(0);

    /* A plan with no order capture: closed, and still no vault rows. */
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'chat',
      expiresAt: null,
      actor: 'operator:test',
    });
    expect(
      publicOrderResponse.parse(
        (
          await order('ada-novault', {
            items: [{ productId: ids['Ankara bale'], quantity: 1 }],
            customerName: 'Bot Farm',
            customerPhone: '08031110002',
            clientRef: randomUUID(),
          })
        ).json(),
      ),
    ).toEqual({ outcome: 'closed' });
    expect(await customersOf(businessId)).toHaveLength(0);

    /* A real order books and records ONE customer; resubmitting its ref with
     * a fresh identity is answered duplicate without a second vault row. */
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });
    const clientRef = randomUUID();
    expect(
      publicOrderResponse.parse(
        (
          await order('ada-novault', {
            items: [{ productId: ids['Ankara bale'], quantity: 1 }],
            customerName: 'Chidi Okafor',
            customerPhone: '08035551234',
            clientRef,
          })
        ).json(),
      ),
    ).toMatchObject({ outcome: 'placed' });
    expect(await customersOf(businessId)).toHaveLength(1);
    expect(
      publicOrderResponse.parse(
        (
          await order('ada-novault', {
            items: [{ productId: ids['Ankara bale'], quantity: 1 }],
            customerName: 'Somebody Else',
            customerPhone: '08039999999',
            clientRef,
          })
        ).json(),
      ),
    ).toEqual({ outcome: 'duplicate' });
    expect(await customersOf(businessId)).toHaveLength(1);
  });

  /**
   * The plan meter is monthly and generous; a flood spends it in minutes and
   * fills the order book with junk. The hourly ceiling (3 in this suite, via
   * REKODA_SHOP_ORDERS_PER_HOUR) is the flood answer: DB-backed, so every
   * replica shares one count.
   */
  it('a flood of orders hits the hourly ceiling and gets an honest sentence', async () => {
    const { businessId, ids } = await openShop('+2348177400041', 'ada-flood');

    for (let i = 1; i <= 3; i++) {
      expect(
        publicOrderResponse.parse(
          (
            await order('ada-flood', {
              items: [{ productId: ids['Ankara bale'], quantity: 1 }],
              customerName: `Customer ${i}`,
              customerPhone: `0803555${String(1000 + i)}`,
              clientRef: randomUUID(),
            })
          ).json(),
        ),
      ).toMatchObject({ outcome: 'placed' });
    }

    expect(
      publicOrderResponse.parse(
        (
          await order('ada-flood', {
            items: [{ productId: ids['Ankara bale'], quantity: 1 }],
            customerName: 'Customer 4',
            customerPhone: '08035551004',
            clientRef: randomUUID(),
          })
        ).json(),
      ),
    ).toEqual({ outcome: 'busy' });

    /* The refusal spent nothing and vaulted nobody new. */
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'orders')?.used).toBe(3);
    expect(await customersOf(businessId)).toHaveLength(3);
  });
});
