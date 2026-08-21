/**
 * The catalogue surface, end to end: session guard → contract shape → the
 * bucket the photo actually lands in.
 *
 * The byte sniffing is proven in packages/core/src/images.test.ts. What this
 * suite pins is everything around it, and four claims in particular:
 *
 *   - a file that is not an image is refused whatever it was announced as,
 *     and nothing reaches storage;
 *   - a photo is served back with the type read from ITS OWN bytes;
 *   - one merchant cannot read or edit another's product, by id or otherwise;
 *   - hiding a product does not hide what is on the shelf, and does not make
 *     the next mention of it create a second row.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { catalogueResponse } from '@rekoda/contracts';
import { MAX_IMAGE_BYTES } from '@rekoda/core';
import { createDb, stockRepo, withBusiness, type Db } from '@rekoda/db';
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

  storageRoot = await mkdtemp(join(tmpdir(), 'rekoda-catalogue-'));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_REVEAL_OTP'] = '1';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  /* A real filesystem bucket rather than a stub: the claim under test is
   * that the bytes reach storage and come back, and a fake `put` would
   * prove that the fake was called. */
  process.env['REKODA_LOCAL_STORAGE'] = storageRoot;
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

const catalogueOf = async (auth: Record<string, string>) =>
  catalogueResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/catalogue', headers: auth })).json(),
  );

/** A product the merchant has mentioned, as chat would have created it. */
async function seedProduct(businessId: string, name = 'Ankara bale') {
  return withBusiness(db, businessId, async (tx) => {
    const product = await stockRepo.findOrCreateProduct(tx, businessId, name);
    await stockRepo.recordMovement(tx, {
      businessId,
      productId: product.id,
      delta: 12,
      reason: 'adjustment',
      sourceType: 'chat',
      sourceId: 'draft-a',
    });
    return product;
  });
}

/** The smallest thing each sniffer accepts, so tests move bytes not megabytes. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/** A multipart body, hand-built so the test owns exactly what goes on the wire. */
function multipart(file: Buffer, filename: string, contentType: string) {
  const boundary = '----rekodatest';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, file, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function upload(
  id: string,
  auth: Record<string, string>,
  file: Buffer,
  filename = 'photo.jpg',
  contentType = 'image/jpeg',
) {
  const body = multipart(file, filename, contentType);
  return app.inject({
    method: 'POST',
    url: `/v1/catalogue/${id}/image`,
    payload: body.payload,
    headers: { ...body.headers, ...auth },
  });
}

describe('the guardrail', () => {
  it('refuses a caller with no session', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/catalogue' })).statusCode).toBe(401);
    expect((await post('/v1/catalogue/product', { id: 'x' })).statusCode).toBe(401);
  });

  it('refuses a product id that is not one', async () => {
    const { auth } = await onboard('+2348177300001');
    expect((await post('/v1/catalogue/product', { id: 'not-a-uuid' }, auth)).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/catalogue/nope/image', headers: auth }))
        .statusCode,
    ).toBe(400);
  });
});

describe('the list', () => {
  it('is empty for a shop that has mentioned nothing', async () => {
    const { auth } = await onboard('+2348177300002');
    expect(await catalogueOf(auth)).toEqual({ products: [], unpriced: 0 });
  });

  it('carries what a product knows about itself, and no photo path until there is one', async () => {
    const { businessId, auth } = await onboard('+2348177300003');
    await seedProduct(businessId);

    const { products, unpriced } = await catalogueOf(auth);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      name: 'Ankara bale',
      description: null,
      unitPriceK: null,
      unitCostK: null,
      imagePath: null,
      active: true,
      onHand: 12,
    });
    /* Listed with no price is the state that stops a shop selling. */
    expect(unpriced).toBe(1);
  });

  it('stops counting a hidden product as unpriced, because it is not for sale', async () => {
    const { businessId, auth } = await onboard('+2348177300004');
    const product = await seedProduct(businessId);

    await post('/v1/catalogue/product', { id: product.id, active: false }, auth);
    const { products, unpriced } = await catalogueOf(auth);
    expect(products[0]!.active).toBe(false);
    expect(unpriced).toBe(0);
  });
});

describe('editing', () => {
  it('sets a price and a description, and leaves the rest alone', async () => {
    const { businessId, auth } = await onboard('+2348177300005');
    const product = await seedProduct(businessId);

    expect(
      (await post('/v1/catalogue/product', { id: product.id, unitPriceK: 850_000 }, auth)).json(),
    ).toEqual({ outcome: 'updated' });
    await post(
      '/v1/catalogue/product',
      { id: product.id, description: 'Six yards, wax print' },
      auth,
    );

    const { products } = await catalogueOf(auth);
    expect(products[0]).toMatchObject({
      unitPriceK: 850_000,
      description: 'Six yards, wax print',
      active: true,
    });
  });

  /**
   * A stated cost, for stock a merchant counted by hand or had before they
   * joined. Without it those sales post no cost of goods forever and every
   * profit figure they read is too high.
   */
  it('sets a cost the merchant states, without touching the price', async () => {
    const { businessId, auth } = await onboard('+2348177300015');
    const product = await seedProduct(businessId);

    await post('/v1/catalogue/product', { id: product.id, unitPriceK: 850_000 }, auth);
    expect(
      (await post('/v1/catalogue/product', { id: product.id, unitCostK: 450_000 }, auth)).json(),
    ).toEqual({ outcome: 'updated' });

    const { products } = await catalogueOf(auth);
    expect(products[0]).toMatchObject({ unitPriceK: 850_000, unitCostK: 450_000 });
  });

  /* What it sells for and what it cost are different facts, and clearing one
   * must not touch the other. */
  it('clearing a cost leaves the price standing', async () => {
    const { businessId, auth } = await onboard('+2348177300016');
    const product = await seedProduct(businessId);

    await post('/v1/catalogue/product', { id: product.id, unitPriceK: 850_000 }, auth);
    await post('/v1/catalogue/product', { id: product.id, unitCostK: 450_000 }, auth);
    await post('/v1/catalogue/product', { id: product.id, unitCostK: null }, auth);

    const { products } = await catalogueOf(auth);
    expect(products[0]!.unitCostK).toBeNull();
    expect(products[0]!.unitPriceK).toBe(850_000);
  });

  /**
   * The property the whole absent-versus-null design exists for. A form that
   * submits only what it changed must not wipe everything it did not.
   */
  it('clearing a description leaves the price standing', async () => {
    const { businessId, auth } = await onboard('+2348177300006');
    const product = await seedProduct(businessId);

    await post('/v1/catalogue/product', { id: product.id, unitPriceK: 850_000 }, auth);
    await post('/v1/catalogue/product', { id: product.id, description: 'Wax print' }, auth);
    await post('/v1/catalogue/product', { id: product.id, description: null }, auth);

    const { products } = await catalogueOf(auth);
    expect(products[0]!.description).toBeNull();
    expect(products[0]!.unitPriceK).toBe(850_000);
  });

  it('treats an emptied box and no description as the same fact', async () => {
    const { businessId, auth } = await onboard('+2348177300007');
    const product = await seedProduct(businessId);

    await post('/v1/catalogue/product', { id: product.id, description: '   ' }, auth);
    expect((await catalogueOf(auth)).products[0]!.description).toBeNull();
  });

  it('says so when there is nothing to change', async () => {
    const { businessId, auth } = await onboard('+2348177300008');
    const product = await seedProduct(businessId);
    expect((await post('/v1/catalogue/product', { id: product.id }, auth)).json()).toEqual({
      outcome: 'nothing_to_do',
    });
  });

  it('refuses another merchant’s product, and says not_found rather than why', async () => {
    const { businessId } = await onboard('+2348177300009');
    const { auth: other } = await onboard('+2348177300010');
    const product = await seedProduct(businessId);

    expect(
      (await post('/v1/catalogue/product', { id: product.id, unitPriceK: 1 }, other)).json(),
    ).toEqual({ outcome: 'not_found' });
    expect((await catalogueOf(other)).products).toHaveLength(0);
  });
});

describe('the photo', () => {
  it('stores it and hands it back with the type read from its own bytes', async () => {
    const { businessId, auth } = await onboard('+2348177300011');
    const product = await seedProduct(businessId);

    const stored = (await upload(product.id, auth, PNG, 'bale.png', 'image/png')).json() as {
      outcome: string;
      imagePath: string;
    };
    expect(stored.outcome).toBe('stored');
    expect(stored.imagePath).toBe(`/v1/catalogue/${product.id}/image`);
    expect((await catalogueOf(auth)).products[0]!.imagePath).toBe(stored.imagePath);

    const served = await app.inject({ method: 'GET', url: stored.imagePath, headers: auth });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    /* Private, never public: a shared cache holding one shop's photo and
     * serving it to the next request on the same edge is the point. */
    expect(String(served.headers['cache-control'])).toContain('private');
    expect(Buffer.from(served.rawPayload)).toEqual(PNG);
  });

  /**
   * The reason the type is sniffed rather than trusted. A document stored
   * under a claimed image type would be served back and run in somebody's
   * browser on our own origin.
   */
  it('refuses a document however the upload announced it', async () => {
    const { businessId, auth } = await onboard('+2348177300012');
    const product = await seedProduct(businessId);

    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    expect((await upload(product.id, auth, html, 'photo.jpg', 'image/jpeg')).json()).toEqual({
      outcome: 'not_an_image',
    });
    /* And nothing was attached, so nothing can be served. */
    expect((await catalogueOf(auth)).products[0]!.imagePath).toBeNull();
  });

  it('refuses SVG, which is a document that can carry script', async () => {
    const { businessId, auth } = await onboard('+2348177300013');
    const product = await seedProduct(businessId);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect((await upload(product.id, auth, svg, 'logo.svg', 'image/svg+xml')).json()).toEqual({
      outcome: 'not_an_image',
    });
  });

  it('refuses one over the ceiling rather than storing what fits', async () => {
    const { businessId, auth } = await onboard('+2348177300014');
    const product = await seedProduct(businessId);

    const huge = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES + 1_024, 0x41)]);
    expect((await upload(product.id, auth, huge, 'big.jpg')).json()).toEqual({
      outcome: 'too_large',
      maxBytes: MAX_IMAGE_BYTES,
    });
    expect((await catalogueOf(auth)).products[0]!.imagePath).toBeNull();
  });

  it('refuses a product that belongs to somebody else', async () => {
    const { businessId } = await onboard('+2348177300015');
    const { auth: other } = await onboard('+2348177300016');
    const product = await seedProduct(businessId);

    expect((await upload(product.id, other, JPEG)).json()).toEqual({ outcome: 'not_found' });
  });

  it('will not serve one merchant’s photo to another', async () => {
    const { businessId, auth } = await onboard('+2348177300017');
    const { auth: other } = await onboard('+2348177300018');
    const product = await seedProduct(businessId);
    await upload(product.id, auth, JPEG);

    const served = await app.inject({
      method: 'GET',
      url: `/v1/catalogue/${product.id}/image`,
      headers: other,
    });
    expect(served.statusCode).toBe(404);
  });

  it('404s a product with no photo rather than an empty 200', async () => {
    const { businessId, auth } = await onboard('+2348177300019');
    const product = await seedProduct(businessId);
    const served = await app.inject({
      method: 'GET',
      url: `/v1/catalogue/${product.id}/image`,
      headers: auth,
    });
    expect(served.statusCode).toBe(404);
  });

  it('replaces one photo with another', async () => {
    const { businessId, auth } = await onboard('+2348177300020');
    const product = await seedProduct(businessId);

    await upload(product.id, auth, JPEG, 'first.jpg', 'image/jpeg');
    await upload(product.id, auth, PNG, 'second.png', 'image/png');

    const served = await app.inject({
      method: 'GET',
      url: `/v1/catalogue/${product.id}/image`,
      headers: auth,
    });
    expect(served.headers['content-type']).toBe('image/png');
  });
});

describe('hiding a product', () => {
  /**
   * The bug this step exists to close as much as anything it adds. Matching
   * on `active` meant the next mention of a hidden product built a SECOND
   * row: the shop's stock history would split in two at that moment and the
   * count would be wrong from then on, silently and forever.
   */
  it('does not make the next mention of it create a second row', async () => {
    const { businessId, auth } = await onboard('+2348177300021');
    const product = await seedProduct(businessId, 'Ankara bale');

    await post('/v1/catalogue/product', { id: product.id, active: false }, auth);

    const again = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'ankara bale'),
    );
    expect(again.id).toBe(product.id);
    expect((await catalogueOf(auth)).products).toHaveLength(1);
  });

  /* A hidden product still sits on a shelf. Dropping it from the stock
   * register would tell a merchant they have nothing when they have twelve. */
  it('leaves what is on the shelf where it is', async () => {
    const { businessId, auth } = await onboard('+2348177300022');
    const product = await seedProduct(businessId);
    await post('/v1/catalogue/product', { id: product.id, active: false }, auth);

    const onShelf = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId));
    expect(onShelf).toHaveLength(1);
    expect(onShelf[0]).toMatchObject({ onHand: 12, active: false });
  });
});
