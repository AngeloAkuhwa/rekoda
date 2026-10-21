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
  entitlementsRepo,
  sql,
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

  /**
   * The two doors of the same capability, asked the same question.
   *
   * Publishing compared plan names while the order endpoint next door asked
   * `requireEntitlement`. A support-issued grant of REKODA_INTEGRATE was
   * therefore honoured when a customer placed an order and ignored when the
   * merchant tried to publish the shop that order would have come from.
   */
  it('lets a granted Chat business publish, because the grant is real', async () => {
    const { businessId, auth } = await onboard('+2348177400020');
    await seedCatalogue(businessId, auth);
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'chat',
      expiresAt: null,
      actor: 'operator:test',
    });
    expect((await publish(auth, 'ada-granted-shop')).json()).toEqual({
      outcome: 'needs_integrate',
    });

    await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.grant(tx, {
        businessId,
        entitlementKey: 'REKODA_INTEGRATE',
        source: 'MANUAL_GRANT',
        grantedBy: 'operator:support',
      }),
    );

    const granted = (await publish(auth, 'ada-granted-shop')).json();
    expect(granted).not.toEqual({ outcome: 'needs_integrate' });
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
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);

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
    expect(usageAfter.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(usageAfter.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  /* G-96: a double tap fires two submits of one form at the same instant. Both
   * pass the "already ordered" pre-check, so each meters its two units; the bus
   * replays the first order to the second, and nothing refunded the second's
   * units. One order must cost exactly one order unit and one document unit. */
  it('two concurrent submits of one form book one order and meter one order and one document (G-96)', async () => {
    const { businessId, ids } = await openShop('+2348177400090', 'ada-double-tap');
    const payload = {
      items: [{ productId: ids['Ankara bale'], quantity: 2 }],
      customerName: 'Chidi Okafor',
      customerPhone: '0803 555 1234',
      clientRef: randomUUID(),
    };

    const answers = (
      await Promise.all([order('ada-double-tap', payload), order('ada-double-tap', payload)])
    ).map((res) => {
      expect(res.statusCode).toBe(200);
      return publicOrderResponse.parse(res.json());
    });

    /* Whichever way the two requests interleave, one order is confirmed: a
     * replay hands the second tap the SAME confirmation, and a request that
     * lost the race at the pre-check answers `duplicate`. Never two orders. */
    const placed = answers.filter((a) => a.outcome === 'placed');
    expect(placed.length).toBeGreaterThanOrEqual(1);
    expect(answers.every((a) => a.outcome === 'placed' || a.outcome === 'duplicate')).toBe(true);
    if (placed.length === 2) expect(placed[0]).toEqual(placed[1]);
    const orders = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM orders WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect(Number([...orders][0]?.n)).toBe(1);
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  it('a resubmit whose server price changed answers duplicate, never a 500, and meters once (G-96)', async () => {
    const { businessId, ids } = await openShop('+2348177400091', 'ada-price-race');
    const payload = {
      items: [{ productId: ids['Ankara bale'], quantity: 1 }],
      customerName: 'Chidi Okafor',
      customerPhone: '0803 555 1234',
      clientRef: randomUUID(),
    };
    const first = publicOrderResponse.parse((await order('ada-price-race', payload)).json());
    expect(first.outcome).toBe('placed');

    /* What a second in-flight request sees: it passed the "already ordered"
     * pre-check before the first committed (modelled by hiding the order's
     * external ref) and read a catalogue the merchant has since repriced, so its
     * payload hashes differently under the same one-shot key. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`UPDATE orders SET external_ref = NULL
                                WHERE business_id = ${businessId}::uuid`);
      await ownerDb.execute(sql`UPDATE products SET unit_price_k = unit_price_k + 100
                                WHERE business_id = ${businessId}::uuid`);
    } finally {
      await close();
    }
    const res = await order('ada-price-race', payload);

    expect(res.statusCode).toBe(200);
    expect(publicOrderResponse.parse(res.json())).toEqual({ outcome: 'duplicate' });
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
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
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
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
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
  });

  /* G-60: a vault failure while attaching the typed name is no longer
   * swallowed. The checkout fails visibly, books nothing, and gives back
   * the two units it had already paid. */
  it('a vault failure fails the checkout visibly and spends nothing', async () => {
    const { businessId, ids } = await openShop('+2348177400033', 'ada-vault-down');
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    let status = 0;
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_shop_name_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.facet = 'name' THEN RAISE EXCEPTION 'g60: the vault is unavailable'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_shop_name_fails BEFORE INSERT ON customer_identities
          FOR EACH ROW EXECUTE FUNCTION g60_shop_name_fails()`);

      status = (
        await order('ada-vault-down', {
          items: [{ productId: ids['Ankara bale'], quantity: 1 }],
          customerName: 'Chidi Okafor',
          customerPhone: '08035551234',
          clientRef: randomUUID(),
        })
      ).statusCode;
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_shop_name_fails ON customer_identities`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_shop_name_fails()`);
      await close();
    }

    expect(status).toBeGreaterThanOrEqual(500);
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
    const orders = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM orders WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect(Number([...orders][0]?.n)).toBe(0);
  });

  /* Final review of #271: when the order itself fails during an outage and a
   * refund fails too, the other refund is still made. */
  it('tries both refunds when the order fails and one refund fails too', async () => {
    const { businessId, ids } = await openShop('+2348177400037', 'ada-order-down');
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    let status = 0;
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_order_fails() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'g60: the books are unavailable'; END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_order_fails BEFORE INSERT ON orders
          FOR EACH ROW EXECUTE FUNCTION g60_order_fails()`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_orders_refund_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.unit = 'CATALOGUE_ORDERS' AND NEW.used < OLD.used THEN
            RAISE EXCEPTION 'g60: the orders refund failed';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_orders_refund_fails BEFORE UPDATE ON usage_counters
          FOR EACH ROW EXECUTE FUNCTION g60_orders_refund_fails()`);
      status = (
        await order('ada-order-down', {
          items: [{ productId: ids['Ankara bale'], quantity: 1 }],
          customerName: 'Chidi Okafor',
          customerPhone: '08035551234',
          clientRef: randomUUID(),
        })
      ).statusCode;
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_order_fails ON orders`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_order_fails()`);
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_orders_refund_fails ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_orders_refund_fails()`);
      await close();
    }
    expect(status).toBeGreaterThanOrEqual(500);
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(1);
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  /* Final review of #271: Integrate lapses between the meter and the order;
   * the order is refused, and the two units it had paid go back. */
  it('a plan that lapses mid-checkout answers closed and spends nothing', async () => {
    const { businessId, ids } = await openShop('+2348177400038', 'ada-lapse');
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    let outcome: unknown;
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_lapse() RETURNS trigger SECURITY DEFINER AS $$
        BEGIN
          UPDATE businesses SET plan = 'chat' WHERE id = NEW.business_id;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_lapse AFTER INSERT OR UPDATE ON usage_counters
          FOR EACH ROW WHEN (NEW.unit = 'DOCUMENT_GENERATION' AND NEW.used > 0)
          EXECUTE FUNCTION g60_lapse()`);
      outcome = (
        await order('ada-lapse', {
          items: [{ productId: ids['Ankara bale'], quantity: 1 }],
          customerName: 'Chidi Okafor',
          customerPhone: '08035551234',
          clientRef: randomUUID(),
        })
      ).json();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_lapse ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_lapse()`);
      await close();
    }
    expect(outcome).toEqual({ outcome: 'closed' });
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  /* Final review of #271: the order unit is taken, then the document meter
   * fails; the order unit goes back. */
  it('gives the order unit back when the document meter fails', async () => {
    const { businessId, ids } = await openShop('+2348177400039', 'ada-meter-down');
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    let status = 0;
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_doc_meter_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.unit = 'DOCUMENT_GENERATION' THEN RAISE EXCEPTION 'g60: the meter is unavailable'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_doc_meter_fails BEFORE INSERT OR UPDATE ON usage_counters
          FOR EACH ROW EXECUTE FUNCTION g60_doc_meter_fails()`);
      status = (
        await order('ada-meter-down', {
          items: [{ productId: ids['Ankara bale'], quantity: 1 }],
          customerName: 'Chidi Okafor',
          customerPhone: '08035551234',
          clientRef: randomUUID(),
        })
      ).statusCode;
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_doc_meter_fails ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_doc_meter_fails()`);
      await close();
    }
    expect(status).toBeGreaterThanOrEqual(500);
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
  });

  /* Owner decision on #271: a terminal answer is never given while a refund
   * it needs has failed; the failure surfaces instead. */
  it('does not answer closed while the refund it owes has failed', async () => {
    const { ids } = await openShop('+2348177400040', 'ada-lapse-refund');
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    let status = 0;
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_lapse() RETURNS trigger SECURITY DEFINER AS $$
        BEGIN UPDATE businesses SET plan = 'chat' WHERE id = NEW.business_id; RETURN NEW; END
        $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_lapse AFTER INSERT OR UPDATE ON usage_counters
          FOR EACH ROW WHEN (NEW.unit = 'DOCUMENT_GENERATION' AND NEW.used > 0)
          EXECUTE FUNCTION g60_lapse()`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_refund_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.unit = 'CATALOGUE_ORDERS' AND NEW.used < OLD.used THEN
            RAISE EXCEPTION 'g60: the refund is unavailable';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_refund_fails BEFORE UPDATE ON usage_counters
          FOR EACH ROW EXECUTE FUNCTION g60_refund_fails()`);
      status = (
        await order('ada-lapse-refund', {
          items: [{ productId: ids['Ankara bale'], quantity: 1 }],
          customerName: 'Chidi Okafor',
          customerPhone: '08035551234',
          clientRef: randomUUID(),
        })
      ).statusCode;
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_lapse ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_lapse()`);
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_refund_fails ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_refund_fails()`);
      await close();
    }
    expect(status).toBeGreaterThanOrEqual(500);
  });

  /* Owner review of #271: the phone customer is committed before the name
   * is attached, so a retried checkout must still attach the name. */
  it('a retried checkout attaches the name a failed attempt could not', async () => {
    const { businessId, ids } = await openShop('+2348177400035', 'ada-retry-name');
    const clientRef = randomUUID();
    const body = {
      items: [{ productId: ids['Ankara bale'], quantity: 1 }],
      customerName: 'Chidi Okafor',
      customerPhone: '08035551234',
      clientRef,
    };
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_shop_name_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.facet = 'name' THEN RAISE EXCEPTION 'g60: the vault is unavailable'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_shop_name_fails BEFORE INSERT ON customer_identities
          FOR EACH ROW EXECUTE FUNCTION g60_shop_name_fails()`);
      expect((await order('ada-retry-name', body)).statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_shop_name_fails ON customer_identities`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_shop_name_fails()`);
      await close();
    }

    const placed = publicOrderResponse.parse((await order('ada-retry-name', body)).json());
    expect(placed.outcome).toBe('placed');
    const facets = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ customers: number; phones: number; names: number; orders: number }>(sql`
        SELECT
          (SELECT count(*)::int FROM customers WHERE business_id = ${businessId}::uuid) AS customers,
          (SELECT count(*)::int FROM customer_identities
            WHERE business_id = ${businessId}::uuid AND facet = 'phone') AS phones,
          (SELECT count(*)::int FROM customer_identities
            WHERE business_id = ${businessId}::uuid AND facet = 'name') AS names,
          (SELECT count(*)::int FROM orders WHERE business_id = ${businessId}::uuid) AS orders`),
    );
    expect([...facets][0]).toEqual({ customers: 1, phones: 1, names: 1, orders: 1 });
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  it('a returning named customer keeps the name they have', async () => {
    const { businessId, ids } = await openShop('+2348177400036', 'ada-named');
    const first = {
      items: [{ productId: ids['Ankara bale'], quantity: 1 }],
      customerName: 'Chidi Okafor',
      customerPhone: '08035551234',
      clientRef: randomUUID(),
    };
    expect(publicOrderResponse.parse((await order('ada-named', first)).json()).outcome).toBe(
      'placed',
    );
    expect(
      publicOrderResponse.parse(
        (
          await order('ada-named', { ...first, customerName: 'Chidi O.', clientRef: randomUUID() })
        ).json(),
      ).outcome,
    ).toBe('placed');
    const names = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM customer_identities
         WHERE business_id = ${businessId}::uuid AND facet = 'name'`),
    );
    expect(Number([...names][0]?.n)).toBe(1);
  });

  /* Codex P2 on #271: a refund that fails while the vault is down must not
   * stop the other refund from being tried. */
  it('tries both refunds when one of them fails too', async () => {
    const { businessId, ids } = await openShop('+2348177400034', 'ada-refund-down');
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    let status = 0;
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_shop_name_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.facet = 'name' THEN RAISE EXCEPTION 'g60: the vault is unavailable'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_shop_name_fails BEFORE INSERT ON customer_identities
          FOR EACH ROW EXECUTE FUNCTION g60_shop_name_fails()`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_orders_refund_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.unit = 'CATALOGUE_ORDERS' AND NEW.used < OLD.used THEN
            RAISE EXCEPTION 'g60: the orders refund failed';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_orders_refund_fails BEFORE UPDATE ON usage_counters
          FOR EACH ROW EXECUTE FUNCTION g60_orders_refund_fails()`);

      status = (
        await order('ada-refund-down', {
          items: [{ productId: ids['Ankara bale'], quantity: 1 }],
          customerName: 'Chidi Okafor',
          customerPhone: '08035551234',
          clientRef: randomUUID(),
        })
      ).statusCode;
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_shop_name_fails ON customer_identities`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_shop_name_fails()`);
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_orders_refund_fails ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_orders_refund_fails()`);
      await close();
    }

    expect(status).toBeGreaterThanOrEqual(500);
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    /* The orders refund failed; the document refund was still made. */
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(1);
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
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
    expect(usage.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(3);
    expect(await customersOf(businessId)).toHaveLength(3);
  });
});
