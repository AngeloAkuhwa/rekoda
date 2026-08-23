/**
 * The hosted shop (MASTER-PLAN §5.3.5, "Door 1").
 *
 * Rekoda's first surface with no session behind it, and every decision in
 * this file follows from that.
 *
 * ── how a slug becomes a tenant ────────────────────────────────────────────
 *
 * Pinning a tenant from a string somebody typed is the shape of a
 * tenant-confusion bug, so it is worth saying exactly why this one is not.
 * The mapping is authoritative: `shops.slug` is uniquely indexed and only a
 * PUBLISHED row answers. And the reach it buys is bounded by what follows:
 * once pinned, this controller reads listed, priced products and nothing
 * else. So the worst a stranger can do with a guessed slug is see the
 * catalogue that slug's owner chose to put online, which is the page.
 *
 * The lookup itself cannot reach a business's own row. `shops` is a separate
 * table holding only published fields precisely so that the public path never
 * touches `businesses`, where the plan, the TIN and the owner live.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  publicShopResponse,
  saveShopRequest,
  shopSettingsResponse,
  type PublicShopResponse,
  publicShopIndexResponse,
  type PublicShopIndexResponse,
  type SaveShopResponse,
  type ShopSettingsResponse,
} from '@rekoda/contracts';
import { sniffImageType } from '@rekoda/core';
import { catalogueRepo, identity, shopsRepo, withBusiness, type Db } from '@rekoda/db';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { DB } from '../db/db.module.js';
import { DOCUMENT_STORAGE } from '../documents/documents.module.js';
import type { DocumentStorage } from '../documents/storage.js';

interface ImageReply {
  header(name: string, value: string): ImageReply;
  code(status: number): ImageReply;
  send(body: Buffer | string): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How many shops one sitemap will carry.
 *
 * Far below the 50,000 URL ceiling the sitemap protocol sets, and chosen so
 * that reaching it is a signal rather than a wall: at this many merchants the
 * right answer is a sitemap index with one file per slice, not a bigger
 * number here. The response says when it was hit so nobody has to guess.
 */
const SITEMAP_SHOPS = 5_000;

/**
 * The list of open shops, on its own path.
 *
 * `v1/shops` rather than a route under `v1/shop`, because every path under
 * that controller is a slug: `/v1/shop/index` would be unreachable the day a
 * merchant chose `index` as their handle, and nothing stops them.
 */
@Controller('v1/shops')
export class PublicShopIndexController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async index(): Promise<PublicShopIndexResponse> {
    const shops = await shopsRepo.publishedShops(this.db, SITEMAP_SHOPS + 1);
    return publicShopIndexResponse.parse({
      shops: shops.slice(0, SITEMAP_SHOPS).map((shop) => ({
        slug: shop.slug,
        updatedAt: shop.updatedAt.toISOString(),
      })),
      /* One more than the cap was asked for, so this is a fact rather than a
       * guess about whether the list ran out or was cut off. */
      truncated: shops.length > SITEMAP_SHOPS,
    });
  }
}

/**
 * The public half. No guard, by design, and nothing here reads a session.
 *
 * The global rate limit applies (it exempts only `/health`), so a public page
 * is no cheaper to scrape than any other route.
 */
/**
 * Products per shop page.
 *
 * Small enough that a phone scrolls one page comfortably, large enough that
 * most shops never see a pager at all. The shop PAGES rather than capping,
 * because its reader is a customer: task #55's cap silently published a
 * fraction of a big shop with nothing saying so, and no caption fixes that
 * for somebody who has named nothing to look up.
 */
const SHOP_PAGE_PRODUCTS = 60;

@Controller('v1/shop')
export class PublicShopController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  @Get(':slug')
  async shop(
    @Param('slug') slug: string,
    @Query('page') pageParam?: string,
  ): Promise<PublicShopResponse> {
    const shop = await shopsRepo.shopBySlug(this.db, String(slug ?? '').toLowerCase());
    /* The same answer for a slug nobody has and a shop nobody published, so
     * the URL cannot be used to find out that a business exists. */
    if (!shop) throw new NotFoundException('Not found');

    /* Anything unparseable is page one, because a mangled shared link should
     * open the shop rather than a 404. A page past the end IS a 404: those
     * links are only ever constructed, and a constructed wrong URL should say
     * so to crawlers rather than serve duplicate pages. */
    const parsed = Number.parseInt(String(pageParam ?? '1'), 10);
    const page = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;

    /* Sellable means listed AND priced, filtered and paged in SQL. Filtering
     * a capped read here is the bug this replaced: a big shop silently
     * published a fraction of itself. `onHand` never crosses this boundary:
     * how many are left is the merchant's business and a competitor's
     * homework. */
    const sellable = await withBusiness(this.db, shop.businessId, (tx) =>
      catalogueRepo.sellableCatalogueFor(tx, shop.businessId, {
        page,
        pageSize: SHOP_PAGE_PRODUCTS,
      }),
    );
    const pageCount = Math.max(1, Math.ceil(sellable.count / SHOP_PAGE_PRODUCTS));
    if (page > pageCount) throw new NotFoundException('Not found');

    return publicShopResponse.parse({
      slug: shop.slug,
      displayName: shop.displayName,
      tagline: shop.tagline,
      whatsappE164: shop.whatsappE164,
      products: sellable.rows.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        priceK: p.unitPriceK,
        imagePath: p.imageKey ? `/v1/shop/${shop.slug}/photo/${p.id}` : null,
      })),
      page,
      pageCount,
      productsTotal: sellable.count,
    });
  }

  /**
   * A product photo, publicly.
   *
   * Keyed on the SLUG as well as the product, so this route can only ever
   * serve an image belonging to the shop in the URL: a product id from
   * another business resolves to nothing under that tenant's pin. The type is
   * read from the bytes again rather than trusted, the same rule the
   * authenticated route follows and for the same reason.
   */
  @Get(':slug/photo/:id')
  async photo(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Res() reply: ImageReply,
  ): Promise<void> {
    if (!UUID.test(id)) {
      reply.code(404).send('Not found');
      return;
    }
    const shop = await shopsRepo.shopBySlug(this.db, String(slug ?? '').toLowerCase());
    if (!shop) {
      reply.code(404).send('Not found');
      return;
    }

    const key = await withBusiness(this.db, shop.businessId, (tx) =>
      catalogueRepo.imageKeyFor(tx, shop.businessId, id),
    );
    const bytes = key ? await this.storage.get(key).catch(() => null) : null;
    const type = bytes ? sniffImageType(bytes) : null;
    if (!bytes || !type) {
      reply.code(404).send('Not found');
      return;
    }

    reply
      .header('content-type', type)
      /* Public here, unlike the dashboard's route, and deliberately: this
       * image is on a page anyone can open, so a shared cache holding it is
       * the point rather than the risk. */
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(bytes);
  }
}

/** The merchant's half: choosing the handle and switching the shop on. */
@Controller('v1/shop-settings')
@UseGuards(SessionGuard)
export class ShopSettingsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async settings(@Req() request: AuthedRequest): Promise<ShopSettingsResponse> {
    const businessId = request.auth!.businessId;
    const { shop, catalogue } = await withBusiness(this.db, businessId, async (tx) => ({
      shop: await shopsRepo.shopFor(tx, businessId),
      catalogue: (await catalogueRepo.catalogueFor(tx, businessId)).rows,
    }));
    const business = await identity.businessById(this.db, businessId);

    return shopSettingsResponse.parse({
      shop: shop
        ? {
            slug: shop.slug,
            displayName: shop.displayName,
            tagline: shop.tagline,
            whatsappE164: shop.whatsappE164,
            publishedAt: shop.publishedAt?.toISOString() ?? null,
          }
        : null,
      suggestedSlug: shopsRepo.slugify(business?.name ?? ''),
      sellableCount: catalogue.filter((p) => p.active && p.unitPriceK !== null).length,
    });
  }

  @Post()
  @HttpCode(200)
  async save(@Req() request: AuthedRequest, @Body() body: unknown): Promise<SaveShopResponse> {
    const parsed = saveShopRequest.safeParse(body);
    if (!parsed.success) return { outcome: 'bad_slug' };

    const businessId = request.auth!.businessId;
    const owner = await identity.ownerPhoneFor(this.db, businessId);
    if (!owner) throw new BadRequestException('this business has no owner to contact');

    const sellable = await withBusiness(this.db, businessId, async (tx) => {
      const catalogue = await catalogueRepo.catalogueFor(tx, businessId);
      return catalogue.rows.filter((p) => p.active && p.unitPriceK !== null).length;
    });
    /* Publishing an empty page is worse than not publishing: a customer opens
     * it once, finds nothing, and does not come back. Taking a shop DOWN is
     * always allowed, whatever is in it. */
    if (parsed.data.published && sellable === 0) return { outcome: 'nothing_to_sell' };

    try {
      const outcome = await withBusiness(this.db, businessId, (tx) =>
        shopsRepo.saveShop(tx, {
          businessId,
          slug: parsed.data.slug,
          displayName: parsed.data.displayName,
          /* The owner's WhatsApp number, published because a shop needs one.
           * Taken from the account rather than typed, so a merchant cannot
           * publish a number they do not control. */
          whatsappE164: owner,
          tagline: parsed.data.tagline,
          published: parsed.data.published,
        }),
      );
      if (outcome === 'bad_slug') return { outcome: 'bad_slug' };
      return { outcome: 'saved', slug: parsed.data.slug, published: parsed.data.published };
    } catch (error: unknown) {
      /* Caught OUT here rather than inside the transaction: a unique
       * violation aborts the transaction it happened in, so the repo throws
       * and the classification happens where there is still a connection. */
      if (error instanceof shopsRepo.SlugTaken) return { outcome: 'slug_taken' };
      throw error;
    }
  }
}
