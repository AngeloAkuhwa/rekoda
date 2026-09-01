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
 *     the next mention of it create a second row;
 *   - the bucket does not accumulate objects nothing points at, whether the
 *     upload succeeded and displaced an older photo or failed after writing.
 *
 * That last one is asserted against the REAL filesystem storage this suite
 * runs on, by counting the objects actually on disk. A mocked `put` would
 * have let every one of those leaks through.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { catalogueResponse, createProductResponse } from '@rekoda/contracts';
import { MAX_IMAGE_BYTES } from '@rekoda/core';
import { catalogueRepo, createDb, sql, stockRepo, withBusiness, type Db } from '@rekoda/db';
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

/**
 * Objects actually in the bucket, as storage keys.
 *
 * `truncateAll` empties the database between tests and the bucket is a real
 * directory that it cannot reach, so earlier tests' photos are still on disk.
 * Every assertion here is therefore scoped to ONE business's prefix, or
 * compares a before and after snapshot; a bare count across the whole root
 * would pass or fail depending on which tests ran first.
 */
async function objectsInBucket(businessId?: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path.slice(storageRoot.length + 1));
    }
  }
  await walk(storageRoot);
  const keys = found.sort();
  return businessId ? keys.filter((key) => key.startsWith(`catalogue/${businessId}/`)) : keys;
}

/**
 * What this shop has promised to delete and not yet deleted.
 *
 * Read INSIDE the tenant pin, which is not incidental. `pending_object_deletions`
 * is under FORCE row-level security (0124), and FORCE applies to the table
 * owner too, so an unpinned read as the owner matches nothing and every
 * assertion below would see an empty queue and pass for the wrong reason.
 * Pinning it also proves the row landed under the right tenant.
 */
async function queuedDeletions(
  businessId: string,
): Promise<Array<{ key: string; reason: string }>> {
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ storage_key: string; reason: string }>(
      sql`SELECT storage_key, reason FROM pending_object_deletions ORDER BY enqueued_at`,
    );
    return [...rows].map((row) => ({ key: row.storage_key, reason: row.reason }));
  });
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
    expect(await catalogueOf(auth)).toEqual({
      products: [],
      total: 0,
      listed: 0,
      hidden: 0,
      unpriced: 0,
    });
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

  /**
   * The four counts, carried out to the wire.
   *
   * Scoped deliberately, and named for what it actually proves. Twelve
   * products sit well inside the page the endpoint returns, so counting the
   * page and counting the table give the same four numbers here: this test
   * cannot tell them apart and does not claim to. Mutating the controller to
   * count its own rows leaves it green, which I checked rather than assumed.
   *
   * The divergence is proved in `catalogue.integration.test.ts` in
   * @rekoda/db, where a limit can be passed and a page of five out of twelve
   * makes the two answers differ. That is the layer that owns the counting.
   * What is worth having here is that all four cross the border with the
   * right values attached to the right names, which is its own way to be
   * wrong.
   */
  it('carries all four shop counts to the wire', async () => {
    const { businessId, auth } = await onboard('+2348177300009');
    await withBusiness(db, businessId, async (tx) => {
      for (let i = 0; i < 12; i += 1) {
        const name = `Product ${String(i + 1).padStart(3, '0')}`;
        const product = await stockRepo.findOrCreateProduct(tx, businessId, name);
        /* The last four sort last by name, and are listed with no price. */
        if (i < 8) {
          await catalogueRepo.editProduct(tx, businessId, product.id, { unitPriceK: 50_000 });
        }
        if (i === 0) {
          await catalogueRepo.editProduct(tx, businessId, product.id, { active: false });
        }
      }
    });

    const body = await catalogueOf(auth);
    expect(body.total).toBe(12);
    expect(body.listed).toBe(11);
    expect(body.hidden).toBe(1);
    /* The figure that matters most, and the one most easily transposed with
     * `hidden` on the way out: eleven listed, four of them unsellable. */
    expect(body.unpriced).toBe(4);
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

  it('refuses a product that belongs to somebody else, without writing a byte', async () => {
    const { businessId } = await onboard('+2348177300015');
    const { auth: other } = await onboard('+2348177300016');
    const product = await seedProduct(businessId);
    const before = await objectsInBucket();

    expect((await upload(product.id, other, JPEG)).json()).toEqual({ outcome: 'not_found' });

    /* The refusal used to arrive AFTER the bytes were already in the bucket,
     * so anyone holding a session could fill it by posting to ids that were
     * not theirs and reading the 'not_found' back. Nothing collected what
     * that left.
     *
     * What is asserted is the PROPERTY, not which of the two mechanisms
     * delivered it: the question is asked before the write, and anything
     * written anyway is discarded after. Either alone would satisfy this
     * assertion, which is the point - the bucket must not grow, however
     * that ends up being true. */
    expect(await objectsInBucket()).toEqual(before);
    expect(await queuedDeletions(businessId)).toEqual([]);
  });

  it('writes nothing for a product that does not exist at all', async () => {
    const { auth } = await onboard('+2348177300019');
    const before = await objectsInBucket();

    const nowhere = '2b0f9b6a-0000-4000-8000-000000000000';
    expect((await upload(nowhere, auth, JPEG)).json()).toEqual({ outcome: 'not_found' });

    // Same leak, reached without needing another merchant's id to guess at.
    expect(await objectsInBucket()).toEqual(before);
  });

  /**
   * The other half of the leak, and the quieter one.
   *
   * `setProductImage` has always handed back the key it replaced so the
   * caller could bin the object. The caller dropped it, so every re-upload
   * since launch left the old photo in the bucket with no row naming it and
   * nothing in the estate that still knew the key.
   */
  it('promises the displaced photo to the bin when one is replaced', async () => {
    const { businessId, auth } = await onboard('+2348177300020');
    const product = await seedProduct(businessId);

    await upload(product.id, auth, JPEG, 'first.jpg');
    const afterFirst = await objectsInBucket(businessId);
    expect(afterFirst).toHaveLength(1);

    await upload(product.id, auth, PNG, 'second.png', 'image/png');
    expect(await objectsInBucket(businessId)).toHaveLength(2);

    /* Both objects are still on disk: the queue is drained by the worker, not
     * by the request. What matters is that the old one is now PROMISED rather
     * than forgotten, which is the difference between a backlog somebody can
     * read and a leak nobody can. */
    const queued = await queuedDeletions(businessId);
    expect(queued).toEqual([{ key: afterFirst[0]!, reason: 'image_replaced' }]);

    // And the product now serves the new bytes, not the old.
    const served = await app.inject({
      method: 'GET',
      url: `/v1/catalogue/${product.id}/image`,
      headers: auth,
    });
    expect(Buffer.from(served.rawPayload)).toEqual(PNG);
  });

  it('promises nothing on a first upload, because nothing was displaced', async () => {
    const { businessId, auth } = await onboard('+2348177300021');
    const product = await seedProduct(businessId);

    expect((await upload(product.id, auth, JPEG)).json()).toMatchObject({ outcome: 'stored' });

    // A null `replacedKey` is not a key. Enqueuing one would be a promise to
    // delete nothing, sitting in an operator's backlog forever.
    expect(await queuedDeletions(businessId)).toEqual([]);
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
    expect(onShelf.rows).toHaveLength(1);
    expect(onShelf.rows[0]).toMatchObject({ onHand: 12, active: false });
  });
});

describe('creating and renaming from the dashboard (fix-plan 5, H2c)', () => {
  it('creates a product, and a matching name answers with the original', async () => {
    const { auth } = await onboard('+2348177600020');
    const created = createProductResponse.parse(
      (
        await post('/v1/catalogue/products', { name: 'Ankara bale', unitPriceK: 850_000 }, auth)
      ).json(),
    );
    expect(created).toMatchObject({ outcome: 'created', name: 'Ankara bale' });
    if (created.outcome !== 'created') return;

    /* The fold, not the spelling, decides: extra spaces and case answer with
     * the product that already exists rather than minting a twin. */
    const again = createProductResponse.parse(
      (await post('/v1/catalogue/products', { name: '  ankara   BALE ' }, auth)).json(),
    );
    expect(again).toEqual({ outcome: 'already_exists', id: created.id, name: 'Ankara bale' });

    const list = await catalogueOf(auth);
    expect(list.products.filter((p) => p.name === 'Ankara bale')).toHaveLength(1);
    expect(list.products.find((p) => p.name === 'Ankara bale')?.unitPriceK).toBe(850_000);
  });

  it('renames without splitting history, and refuses a name another product answers to', async () => {
    const { businessId, auth } = await onboard('+2348177600021');
    const bale = await seedProduct(businessId, 'Ankara bale');
    await seedProduct(businessId, 'Aso oke set');

    const renamed = (
      await post('/v1/catalogue/product', { id: bale.id, name: 'Ankara bale (premium)' }, auth)
    ).json() as { outcome: string };
    expect(renamed).toEqual({ outcome: 'updated' });

    /* The count came along with the name: same row, same twelve on hand. */
    const stock = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'Ankara bale (premium)'),
    );
    expect(stock?.id).toBe(bale.id);
    expect(stock?.onHand).toBe(12);

    const clash = (
      await post('/v1/catalogue/product', { id: bale.id, name: 'aso OKE set' }, auth)
    ).json() as { outcome: string };
    expect(clash).toEqual({ outcome: 'name_taken' });

    /* A rename that also reprices is one form: both land, or neither. */
    const both = (
      await post(
        '/v1/catalogue/product',
        { id: bale.id, name: 'Ankara bale', unitPriceK: 900_000 },
        auth,
      )
    ).json() as { outcome: string };
    expect(both).toEqual({ outcome: 'updated' });
    const list = await catalogueOf(auth);
    expect(list.products.find((p) => p.id === bale.id)).toMatchObject({
      name: 'Ankara bale',
      unitPriceK: 900_000,
    });
  });

  it('keeps creation behind the shop-floor roles', async () => {
    expect((await post('/v1/catalogue/products', { name: 'Ankara bale' })).statusCode).toBe(401);
  });
});
