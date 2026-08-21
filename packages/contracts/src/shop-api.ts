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
});
export type PublicShopResponse = z.infer<typeof publicShopResponse>;

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
]);

export type SaveShopRequest = z.infer<typeof saveShopRequest>;
export type SaveShopResponse = z.infer<typeof saveShopResponse>;
