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
  publicOrderRequest,
  type PublicOrderResponse,
  payWithTransferRequest,
  type PayWithTransferResponse,
  type TransferStatusResponse,
  saveShopRequest,
  shopSettingsResponse,
  type PublicShopResponse,
  publicShopIndexResponse,
  type PublicShopIndexResponse,
  type SaveShopResponse,
  type ShopSettingsResponse,
} from '@rekoda/contracts';
import { allowanceFor, postCostOfSale, sniffImageType, usagePeriod } from '@rekoda/core';
import {
  catalogueRepo,
  entitlementsRepo,
  identity,
  issueRepo,
  jobsRepo,
  ordersRepo,
  shopsRepo,
  stockRepo,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { DOCUMENT_STORAGE } from '../documents/documents.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { MerchantTransferService } from '../payments/merchant-transfer.service.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { placeOrderWork, type PlaceOrderCmdInput } from '../commands/order-commands.js';
import type { DocumentStorage } from '../documents/storage.js';

interface ImageReply {
  header(name: string, value: string): ImageReply;
  code(status: number): ImageReply;
  send(body: Buffer | string): void;
}

/** A 23505 on the orders external-ref index: this clientRef already ordered. */
function isDuplicateOnOrders(error: unknown): boolean {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const pg = cause as { code?: string; constraint_name?: string; constraint?: string };
  return (
    pg?.code === '23505' && (pg.constraint_name ?? pg.constraint ?? '').includes('orders_external')
  );
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

/** Thrown inside the order transaction when the cart no longer matches the
 * shop, so the whole booking rolls back to nothing and the customer is told
 * to refresh rather than sold a product the merchant took down. */
class CartChanged extends Error {
  override readonly name = 'CartChanged';
}

@Controller('v1/shop')
export class PublicShopController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    @Inject(CONFIG) private readonly config: ApiConfig,
    private readonly gateway: PrivacyGateway,
    private readonly transfers: MerchantTransferService,
    private readonly commandBus: CommandBus,
  ) {}

  /**
   * A temporary account for the order this clientRef placed (fix-plan 6,
   * M5c). Public like the order itself: the caller proves nothing but the
   * one-shot key only their browser holds, and everything the answer
   * reveals — amount, account to pay into — is what a payer must be told.
   */
  @Post(':slug/pay-with-transfer')
  @HttpCode(200)
  async payWithTransfer(
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<PayWithTransferResponse> {
    const parsed = payWithTransferRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('your order reference and an email address');
    }
    const shop = await shopsRepo.shopBySlug(this.db, slug);
    if (!shop) return { outcome: 'order_gone' };

    const outcome = await this.transfers.accountFor(
      shop.businessId,
      parsed.data.clientRef,
      parsed.data.email,
    );
    if (outcome.state === 'account') {
      return {
        outcome: 'account',
        bankName: outcome.bankName,
        accountNumber: outcome.accountNumber,
        accountName: outcome.accountName,
        amountK: outcome.amountK,
        expiresAt: outcome.expiresAtIso,
        reference: outcome.reference,
      };
    }
    return { outcome: outcome.state };
  }

  /**
   * Has the transfer landed? The customer's tap starts a server-side verify
   * on the merchant's own key; `paid` is only ever Paystack's answer.
   */
  @Get(':slug/transfer-status')
  async transferStatus(
    @Param('slug') slug: string,
    @Query('clientRef') clientRef: string | undefined,
  ): Promise<TransferStatusResponse> {
    if (!clientRef || !UUID.test(clientRef)) {
      throw new BadRequestException('your order reference');
    }
    const shop = await shopsRepo.shopBySlug(this.db, slug);
    if (!shop) return { state: 'order_gone' };

    const outcome = await this.transfers.statusFor(shop.businessId, clientRef);
    if (outcome.state === 'paid') {
      return { state: 'paid', receiptNumber: outcome.receiptNumber };
    }
    return { state: outcome.state };
  }

  /**
   * A customer's order, from the shop page (fix-plan 6, M5b; MASTER-PLAN
   * 5.6.2). The second door into the orders engine, and the first write a
   * stranger can cause — which is why every figure is the server's:
   *
   *  - PRICES come from the catalogue, never from the request. A cart that
   *    carried prices would let anyone name their own.
   *  - The customer's name and phone go straight into the vault through the
   *    same gateway chat mentions use; the invoice carries the customerId
   *    and never the words.
   *  - The merchant's METER is the shop's capacity: an order spends one
   *    orders unit and one documents unit exactly as a captured WhatsApp
   *    order does, refunded on every path that books nothing. A plan with
   *    no order capture answers "closed", not an error, because a customer
   *    standing at a counter deserves a sentence.
   *  - From there it IS the chat confirm path: order, invoice, stock,
   *    cost of goods, render and payment link, in one transaction.
   */
  @Post(':slug/orders')
  @HttpCode(200)
  async placeOrder(
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<PublicOrderResponse> {
    const parsed = publicOrderRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('items, your name, your phone number and a client reference');
    }

    const shop = await shopsRepo.shopBySlug(this.db, slug);
    if (!shop) return { outcome: 'shop_gone' };
    const businessId = shop.businessId;

    /**
     * Every refusable condition is checked BEFORE the customer's name and
     * phone touch the vault (fix-plan 7, H7b). The old order resolved the
     * identity first, so a bot cycling random identities against a closed
     * shop, a stale cart or a spent ref filled the merchant's customer vault
     * for free — every row a real ciphertext, indistinguishable from a
     * person. Now nothing is vaulted unless the order has cleared the
     * duplicate check, the cart check, the flood ceiling and the meter. The
     * transaction below re-checks the racy ones; these are the cheap doors.
     */
    const refused = await withBusiness(this.db, businessId, async (tx) => {
      const existing = await ordersRepo.orderByExternalRef(
        tx,
        businessId,
        `shop:${parsed.data.clientRef}`,
      );
      if (existing) return { outcome: 'duplicate' as const };

      const sellable = await catalogueRepo.sellableByIds(
        tx,
        businessId,
        parsed.data.items.map((i) => i.productId),
      );
      const listed = new Set(sellable.map((p) => p.id));
      if (parsed.data.items.some((i) => !listed.has(i.productId))) {
        return { outcome: 'items_changed' as const };
      }

      /* The flood ceiling: DB-counted, so every replica shares it. The plan
       * meter below is monthly capacity; this is orders-per-hour sanity. */
      const recent = await ordersRepo.countRecentStorefrontOrders(tx, businessId, 60 * 60 * 1000);
      if (recent >= this.config.shopOrdersPerHour) return { outcome: 'busy' as const };
      return null;
    });
    if (refused) return refused;

    /* ENTITLEMENT BEFORE METER (spec §4.3 rule 1). Before PR-013 this path
     * consumed the orders unit and read a refusal as `outcome: 'closed'`,
     * which could not tell "this shop is not on a plan that sells" from "this
     * shop has used all 300 orders this month" — and took a unit either way.
     * The gate answers first, and a refusal takes nothing. */
    const entitled = await withBusiness(this.db, businessId, (tx) =>
      entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_INTEGRATE'),
    );
    if (entitled) return { outcome: 'closed' };

    /* The meter, exactly as the chat capture pays it: own short
     * transactions, refunded on every path that delivers nothing. */
    const period = usagePeriod(new Date());
    const plan = await withBusiness(this.db, businessId, (tx) => usageRepo.planFor(tx, businessId));
    const orderGranted = await withBusiness(this.db, businessId, (own) =>
      usageRepo.consumeUnit(
        own,
        businessId,
        period,
        'CATALOGUE_ORDERS',
        allowanceFor(plan, 'CATALOGUE_ORDERS'),
      ),
    );
    if (!orderGranted) return { outcome: 'closed' };
    const documentGranted = await withBusiness(this.db, businessId, (own) =>
      usageRepo.consumeUnit(
        own,
        businessId,
        period,
        'DOCUMENT_GENERATION',
        allowanceFor(plan, 'DOCUMENT_GENERATION'),
      ),
    );
    if (!documentGranted) {
      await withBusiness(this.db, businessId, (own) =>
        usageRepo.refundUnit(own, businessId, period, 'CATALOGUE_ORDERS'),
      );
      return { outcome: 'closed' };
    }

    const refundBoth = async () => {
      await withBusiness(this.db, businessId, (own) =>
        usageRepo.refundUnit(own, businessId, period, 'CATALOGUE_ORDERS'),
      );
      await withBusiness(this.db, businessId, (own) =>
        usageRepo.refundUnit(own, businessId, period, 'DOCUMENT_GENERATION'),
      );
    };

    /* Only now — with the gates cleared and the units paid — does the
     * customer's identity enter the vault. A refused phone refunds both. */
    const customer = await this.gateway.resolveStorefrontCustomer(
      businessId,
      parsed.data.customerName,
      parsed.data.customerPhone,
    );
    if (!customer) {
      await refundBoth();
      return { outcome: 'bad_phone' };
    }

    try {
      return await withBusiness(this.db, businessId, async (tx) => {
        const wanted = parsed.data.items;
        const sellable = await catalogueRepo.sellableByIds(
          tx,
          businessId,
          wanted.map((i) => i.productId),
        );
        const byId = new Map(sellable.map((p) => [p.id, p]));
        if (wanted.some((i) => !byId.has(i.productId))) throw new CartChanged();

        const lines = wanted.map((item) => {
          const product = byId.get(item.productId)!;
          return {
            productId: product.id,
            name: product.name,
            quantity: item.quantity,
            unitPriceK: product.unitPriceK,
            lineTotalK: item.quantity * product.unitPriceK,
          };
        });
        const totalK = lines.reduce((n, line) => n + line.lineTotalK, 0);

        const input: PlaceOrderCmdInput = {
          businessId,
          customerId: customer.customerId,
          lines,
          totalK,
          sourceType: 'storefront',
          sourceId: `shop:${slug}`,
          externalRef: `shop:${parsed.data.clientRef}`,
          saleSource: 'website',
          actor: 'customer:storefront',
        };

        /* The A1 rollout seam (spec §25): the work places the order, issues
         * the invoice, attaches it, enqueues paper and link, and commits the
         * stock; the flag decides whether the bus's gates wrap the call. */
        let placed: Awaited<ReturnType<typeof placeOrderWork>>;
        if (this.config.commandPlaceOrder) {
          const run = await this.commandBus.run(
            tx,
            {
              businessId,
              command: 'PlaceOrder',
              payload: input,
              actor: input.actor,
              ingress: 'STOREFRONT',
              /* The form's one-shot key: the same identity the orders unique
               * index dedupes, so a replay answers the first order. */
              idempotencyKey: `shop-order:${parsed.data.clientRef}`,
            },
            () => placeOrderWork(tx, input),
          );
          if (run.outcome === 'not_entitled') {
            /* Pre-gated above, so reaching this means the plan changed mid
             * request. The shop reads as closed, which is the truth. */
            return { outcome: 'closed' as const };
          }
          if (run.outcome !== 'done') {
            throw new Error(`PlaceOrder refused unexpectedly: ${run.outcome}`);
          }
          placed = run.result;
        } else {
          placed = await placeOrderWork(tx, input);
        }

        return {
          outcome: 'placed' as const,
          orderNumber: placed.orderNumber,
          invoiceNumber: placed.invoiceNumber,
          totalK,
          whatsappE164: shop.whatsappE164,
          displayName: shop.displayName,
        };
      });
    } catch (error) {
      await refundBoth();
      if (error instanceof CartChanged) return { outcome: 'items_changed' };
      if (isDuplicateOnOrders(error)) return { outcome: 'duplicate' };
      throw error;
    }
  }

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
      catalogueRepo.sellableImageKeyFor(tx, shop.businessId, id),
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
@UseGuards(SessionGuard, RolesGuard)
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

  /* Publishing puts the business's name and number on the open web, and
   * taking it down removes the shop customers may be using. Both are the
   * owner's call; every member may still read the settings page. */
  @Post()
  @HttpCode(200)
  @Roles('owner')
  async save(@Req() request: AuthedRequest, @Body() body: unknown): Promise<SaveShopResponse> {
    const parsed = saveShopRequest.safeParse(body);
    if (!parsed.success) return { outcome: 'bad_slug' };

    const businessId = request.auth!.businessId;
    const owner = await identity.ownerPhoneFor(this.db, businessId);
    if (!owner) throw new BadRequestException('this business has no owner to contact');

    const { sellable, notEntitled } = await withBusiness(this.db, businessId, async (tx) => {
      const catalogue = await catalogueRepo.catalogueFor(tx, businessId);
      return {
        sellable: catalogue.rows.filter((p) => p.active && p.unitPriceK !== null).length,
        notEntitled: await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_INTEGRATE'),
      };
    });
    /* The shop link is what the Integrate card sells, and the trial holds
     * REKODA_INTEGRATE so a merchant can feel it before paying. Drafts and
     * take-downs stay open to every plan, because the gate is on going
     * public, never on keeping what was written.
     *
     * ENTITLEMENT, not a list of plan names. This door used to read
     * `plan !== 'trial' && plan !== 'integrate' && plan !== 'complete'`,
     * which is the same capability the order endpoint next door gates with
     * `requireEntitlement` — two doors answering one question two ways. A
     * support-issued MANUAL_GRANT of REKODA_INTEGRATE was honoured when a
     * customer placed an order and ignored when the merchant tried to
     * publish the shop that order would have come from. */
    if (parsed.data.published && notEntitled) {
      return { outcome: 'needs_integrate' };
    }
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
