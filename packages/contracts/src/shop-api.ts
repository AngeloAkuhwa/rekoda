/**
 * The shop a customer can open (MASTER-PLAN §5.3.5, "Door 1").
 *
 * Two contracts that look similar and are not. `publicShopResponse` is served
 * to anybody with the URL and carries only what the merchant published;
 * `shopSettingsResponse` is behind their session and is where they choose
 * what that is. Keeping them apart is what stops a field drifting from the
 * second into the first.
 */
import { z } from 'zod';

const kobo = z.number().int().finite().nonnegative();

/** Lowercase, digits, single hyphens. Mirrors the CHECK in migration 0030. */
export const shopSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, numbers and hyphens');

/**
 * What a customer sees.
 *
 * No stock counts, on purpose: how many bales are left is the merchant's
 * business and a competitor's homework, and a customer who is told there are
 * two left is being pressured rather than informed. No order history, no
 * totals, nothing about the books. Just what is for sale and how to ask.
 */
export const publicShopResponse = z.object({
  slug: z.string(),
  displayName: z.string(),
  tagline: z.string().nullable(),
  /** E.164, published deliberately: a shop with no way to reach it is a poster. */
  whatsappE164: z.string(),
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      priceK: kobo,
      /** Where the photo can be fetched, publicly, or null. */
      imagePath: z.string().nullable(),
    }),
  ),
  /**
   * Which page of the shop this is, and how many there are.
   *
   * The shop pages rather than capping, because it is the one list in the
   * product whose reader is a CUSTOMER: a "showing 300 of 400" caption is
   * written for the merchant, and a browsing customer has named nothing to
   * look up. `productsTotal` is every sellable product, so a page can say
   * what the whole shop holds without carrying it.
   */
  page: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  productsTotal: z.number().int().nonnegative(),
});
export type PublicShopResponse = z.infer<typeof publicShopResponse>;

/**
 * Every open shop, for the sitemap.
 *
 * Slugs and dates and nothing else. It is tempting to reuse the shop shape
 * here, and it would be wrong: this response is the one place Rekoda lists
 * its merchants together, and a list of merchants carrying their display
 * names and WhatsApp numbers is a directory rather than a sitemap. Each of
 * those facts is public on the shop's own page; assembling them into one
 * downloadable file is a different act.
 *
 * `truncated` is not decoration. A sitemap cut off at its cap reads exactly
 * like a complete one, and the only way anybody finds out is that half the
 * shops were never crawled.
 */
export const publicShopIndexResponse = z.object({
  shops: z.array(
    z.object({
      slug: z.string(),
      /** ISO 8601. What `<lastmod>` becomes. */
      updatedAt: z.string(),
    }),
  ),
  truncated: z.boolean(),
});
export type PublicShopIndexResponse = z.infer<typeof publicShopIndexResponse>;

/** The merchant's own view: the same shop, plus whether anybody can see it. */
export const shopSettingsResponse = z.object({
  shop: z
    .object({
      slug: z.string(),
      displayName: z.string(),
      tagline: z.string().nullable(),
      whatsappE164: z.string(),
      publishedAt: z.string().nullable(),
    })
    .nullable(),
  /** A handle built from their business name, for the empty state to offer. */
  suggestedSlug: z.string(),
  /** How many listed products carry a price. A shop of none is an empty page. */
  sellableCount: z.number().int().nonnegative(),
});
export type ShopSettingsResponse = z.infer<typeof shopSettingsResponse>;

export const saveShopRequest = z.object({
  slug: shopSlug,
  displayName: z.string().trim().min(2).max(60),
  tagline: z.string().trim().max(120).nullable(),
  /** Publishing is an act. Nothing is public until this is true. */
  published: z.boolean(),
});

export const saveShopResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('saved'), slug: z.string(), published: z.boolean() }),
  /** Somebody else has that handle. An ordinary answer, not a failure. */
  z.object({ outcome: z.literal('slug_taken') }),
  z.object({ outcome: z.literal('bad_slug') }),
  /** No products with prices, so publishing would put an empty page online. */
  z.object({ outcome: z.literal('nothing_to_sell') }),
  /**
   * Publishing is an Integrate feature and the plan is not there. Saving a
   * DRAFT and taking a shop down are always allowed: the gate is on going
   * public, never on keeping what was written.
   */
  z.object({ outcome: z.literal('needs_integrate') }),
]);

export type SaveShopRequest = z.infer<typeof saveShopRequest>;
export type SaveShopResponse = z.infer<typeof saveShopResponse>;

/**
 * A customer's order, from the public storefront (fix-plan 6, M5b).
 *
 * The request carries NO prices: what things cost is read from the
 * merchant's catalogue on the server, because a checkout that trusted the
 * browser's arithmetic would let anyone name their own price. The name and
 * phone are Zone 1 vault data the moment they arrive; the delivery note is
 * deliberately never stored — it rides the WhatsApp handoff the confirmation
 * page offers, straight from customer to merchant.
 */
export const publicOrderRequest = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive().max(100),
      }),
    )
    .min(1)
    .max(20),
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().min(7).max(20),
  /** One-shot key the checkout mints. A resubmission orders NOTHING twice. */
  clientRef: z.string().uuid(),
});

export const publicOrderResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('placed'),
    orderNumber: z.string(),
    invoiceNumber: z.string(),
    totalK: z.number().int().nonnegative(),
    /** For the confirmation page's WhatsApp handoff. Published already. */
    whatsappE164: z.string(),
    displayName: z.string(),
  }),
  /** The same clientRef arrived twice: the first submission already ordered. */
  z.object({ outcome: z.literal('duplicate') }),
  /** The slug is not a published shop (taken down between page and order). */
  z.object({ outcome: z.literal('shop_gone') }),
  /** Something in the cart is no longer listed or priced. Reload the shop. */
  z.object({ outcome: z.literal('items_changed') }),
  /** The phone did not survive normalisation. A sentence, not a 400. */
  z.object({ outcome: z.literal('bad_phone') }),
  /** The shop cannot take orders right now: the merchant's monthly capacity
   * is spent, or their plan has no automatic order capture. */
  z.object({ outcome: z.literal('closed') }),
]);
export type PublicOrderRequest = z.infer<typeof publicOrderRequest>;
export type PublicOrderResponse = z.infer<typeof publicOrderResponse>;

/**
 * Pay with Transfer at the storefront checkout (ADR 0016/0019, fix-plan 6
 * M5c). The customer asks for a temporary account for the order they just
 * placed. `clientRef` is the same one-shot key the order was placed under;
 * the email exists because Paystack's charge requires one, travels to the
 * provider, and is not stored by Rekoda.
 */
export const payWithTransferRequest = z.object({
  clientRef: z.string().uuid(),
  email: z.string().trim().email().max(120),
});

export const payWithTransferResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('account'),
    bankName: z.string(),
    accountNumber: z.string(),
    accountName: z.string().nullable(),
    amountK: z.number().int().positive(),
    /** ISO instant the number stops working. The invoice stays open past it. */
    expiresAt: z.string().nullable(),
    reference: z.string(),
  }),
  /** The merchant has not connected their own Paystack key. */
  z.object({ outcome: z.literal('not_available') }),
  /** No such order under this shop and clientRef. */
  z.object({ outcome: z.literal('order_gone') }),
  /** The invoice already carries no balance. */
  z.object({ outcome: z.literal('nothing_to_pay') }),
  /** Paystack itself would not answer. Try again shortly. */
  z.object({ outcome: z.literal('provider_down') }),
]);
export type PayWithTransferRequest = z.infer<typeof payWithTransferRequest>;
export type PayWithTransferResponse = z.infer<typeof payWithTransferResponse>;

/**
 * "Has my transfer landed?" — asked by the checkout after the customer says
 * they have sent it. Answering `paid` is backed by a server-side verify
 * against the merchant's own key, never by the customer's word.
 */
export const transferStatusResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('paid'), receiptNumber: z.string().nullable() }),
  z.object({ state: z.literal('pending') }),
  /** The temporary account lapsed unpaid. Ask for a fresh one. */
  z.object({ state: z.literal('expired') }),
  z.object({ state: z.literal('order_gone') }),
]);
export type TransferStatusResponse = z.infer<typeof transferStatusResponse>;
