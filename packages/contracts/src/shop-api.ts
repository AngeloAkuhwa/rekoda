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
