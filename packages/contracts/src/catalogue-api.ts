/**
 * The price list a merchant manages (MASTER-PLAN §5.3.5).
 *
 * Separate from the reports surface, because everything there ANSWERS a
 * question about what already happened and everything here CHANGES what the
 * shop will say next. A page that only reads is safe to reload; one that
 * writes needs its own contract and its own refusals.
 */
import { z } from 'zod';

/** Integer kobo end to end, same as every other money field on the wire. */
const kobo = z.number().int().finite().nonnegative();

export const catalogueResponse = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** The merchant's own words. Null until they write some. */
      description: z.string().nullable(),
      /** What it sells for. Null means they have never said. */
      unitPriceK: kobo.nullable(),
      /**
       * What it cost them, as a weighted average, or null.
       *
       * Usually moved by deliveries rather than typed. It is here so a
       * merchant can see it beside the price and set one for stock they
       * counted by hand or bought before they joined, which otherwise sells
       * with no cost against it forever.
       */
      unitCostK: kobo.nullable(),
      /**
       * Where this API serves the photo, or null when there is none.
       *
       * An API path, not a browser one: the dashboard proxies it under its
       * own origin, because an `<img>` sends cookies and this API wants a
       * bearer token. Never the storage key, which is the bucket's business
       * and would be a URL nobody should be handed.
       */
      imagePath: z.string().nullable(),
      /** Listed in the shop. A hidden product still exists and still counts. */
      active: z.boolean(),
      onHand: z.number().int(),
    }),
  ),
  /**
   * Every product the shop has, which is not `products.length`.
   *
   * `products` is a page. The footer used to count it and tell a merchant
   * with three hundred and sixteen listed products that they had two hundred
   * and ninety seven.
   */
  total: z.number().int().nonnegative(),
  listed: z.number().int().nonnegative(),
  hidden: z.number().int().nonnegative(),
  /**
   * Listed products with no price. The number that stops a shop selling.
   *
   * Counted across the whole catalogue, never the page. Derived from the page
   * it came back as ZERO for a shop with twelve unsellable products, because
   * all twelve sorted past the cap: no warning shown, nothing to act on, and
   * the shop quietly selling none of them.
   */
  unpriced: z.number().int().nonnegative(),
});
export type CatalogueResponse = z.infer<typeof catalogueResponse>;

/**
 * Changing what the shop says about one product.
 *
 * Every field is optional and every one distinguishes absent from null:
 * a merchant clearing a description must not have their price cleared with
 * it by a form that submits every field it knows about.
 */
export const editProductRequest = z.object({
  id: z.string().uuid(),
  /* An emptied box and "no description" are the same fact, so they get the
   * same representation. Storing "" would give a shop a product whose
   * description is present and says nothing. */
  description: z
    .string()
    .trim()
    .max(400)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value)),
  unitPriceK: kobo.nullable().optional(),
  /**
   * A cost the merchant states, which REPLACES the weighted average rather
   * than averaging into it.
   *
   * A delivery is a fact about goods arriving and moves the average; this is
   * a merchant telling Rekoda what something costs, and averaging their
   * answer with a history they are correcting would give them neither.
   */
  unitCostK: kobo.nullable().optional(),
  active: z.boolean().optional(),
});

export const editProductResponse = z.object({
  outcome: z.union([z.literal('updated'), z.literal('not_found'), z.literal('nothing_to_do')]),
});

export const uploadImageResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('stored'), imagePath: z.string() }),
  z.object({ outcome: z.literal('not_found') }),
  /** The bytes are not a JPEG, PNG or WEBP, whatever the upload claimed. */
  z.object({ outcome: z.literal('not_an_image') }),
  z.object({ outcome: z.literal('too_large'), maxBytes: z.number().int().positive() }),
  /** No bucket configured. The photo is refused rather than silently dropped. */
  z.object({ outcome: z.literal('no_storage') }),
]);

/**
 * `z.input`, not `z.infer`.
 *
 * The description field carries a transform, so the OUTPUT type has it
 * present-and-possibly-undefined while the input type keeps it optional.
 * A caller building a request is on the input side, and inferring from the
 * output would force every caller to name a field they meant to leave alone,
 * which is the exact distinction this contract exists to preserve.
 */
export type EditProductRequest = z.input<typeof editProductRequest>;
export type EditProductResponse = z.infer<typeof editProductResponse>;
export type UploadImageResponse = z.infer<typeof uploadImageResponse>;
