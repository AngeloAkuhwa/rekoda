/**
 * The price list, as something a merchant can manage.
 *
 * `products` has built itself out of conversation since M1, which is the
 * right way round: a shop's catalogue should come from what they actually
 * trade rather than from a setup screen nobody fills in. This is the other
 * half of that bargain. A row that appeared because somebody said "sold 2
 * bags of rice" needs a price, a description and a photo before a customer
 * can be shown it, and none of those can be said in a sentence about a sale.
 *
 * Nothing here is append-only. A price is a fact about right now, not a
 * record of anything: what a thing SOLD for is on the invoice, permanently,
 * and changing the list price never touches it.
 */
import { and, eq, sql, isNotNull } from 'drizzle-orm';
import { foldProductName } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { products } from '../schema/commerce.js';

export interface CatalogueItem {
  id: string;
  name: string;
  description: string | null;
  unitPriceK: number | null;
  /** Weighted average of what it cost, or null when nobody has said. */
  unitCostK: number | null;
  /** Storage key, not a URL. What serves it decides what a URL looks like. */
  imageKey: string | null;
  active: boolean;
  onHand: number;
}

type CatalogueRow = {
  id: string;
  name: string;
  description: string | null;
  unit_price_k: string | number | null;
  unit_cost_k: string | number | null;
  image_key: string | null;
  active: number;
  on_hand: number | null;
};

type Counts = { n: number; listed_n: number; hidden_n: number; unpriced_n: number };

const toItem = (r: CatalogueRow): CatalogueItem => ({
  id: r.id,
  name: r.name,
  description: r.description,
  unitPriceK: r.unit_price_k === null ? null : Number(r.unit_price_k),
  unitCostK: r.unit_cost_k === null ? null : Number(r.unit_cost_k),
  imageKey: r.image_key,
  active: r.active === 1,
  onHand: r.on_hand ?? 0,
});

/**
 * The catalogue page, and the four numbers that are about the shop.
 *
 * `rows` is a page; the counts are over the whole table. Deriving them from
 * `rows` was the bug: a merchant with three hundred and sixteen listed
 * products was told they had two hundred and ninety seven, and `unpriced`
 * came back as ZERO for a shop with twelve listed products nobody could buy,
 * because all twelve sorted past the cap.
 */
export interface Catalogue {
  rows: CatalogueItem[];
  /** Every product, listed and hidden alike. */
  count: number;
  listed: number;
  hidden: number;
  /**
   * Listed with no price: the number that stops a shop selling.
   *
   * Hidden products are excluded, because not being for sale is why they
   * have no price.
   */
  unpriced: number;
}

/**
 * Everything the shop could sell, listed and hidden alike, by name.
 *
 * By name rather than by depletion, which is the stock register's order and
 * the right one there: that page exists to surface what is running out. This
 * one is a list somebody is EDITING, and a list that reorders itself when a
 * sale lands is a list where the row you were about to change moves.
 */
export async function catalogueFor(
  tx: TenantDb,
  businessId: string,
  limit = 1_000,
): Promise<Catalogue> {
  const rows = await tx.execute<CatalogueRow & Counts>(sql`
    WITH counted AS (
      SELECT p.id, p.name, p.description, p.unit_price_k, p.unit_cost_k, p.image_key, p.active,
             coalesce(sum(m.delta), 0)::int AS on_hand
      FROM products p
      LEFT JOIN inventory_movements m ON m.product_id = p.id
      WHERE p.business_id = ${businessId}::uuid
      GROUP BY p.id, p.name, p.description, p.unit_price_k, p.unit_cost_k, p.image_key, p.active
    )
    SELECT id, name, description, unit_price_k, unit_cost_k, image_key, active, on_hand,
           count(*) OVER ()::int AS n,
           count(*) FILTER (WHERE active = 1) OVER ()::int AS listed_n,
           count(*) FILTER (WHERE active = 0) OVER ()::int AS hidden_n,
           count(*) FILTER (WHERE active = 1 AND unit_price_k IS NULL) OVER ()::int AS unpriced_n
    FROM counted
    ORDER BY lower(name) ASC
    LIMIT ${limit}
  `);

  const list = [...rows];
  return {
    rows: list.map(toItem),
    count: list[0]?.n ?? 0,
    listed: list[0]?.listed_n ?? 0,
    hidden: list[0]?.hidden_n ?? 0,
    unpriced: list[0]?.unpriced_n ?? 0,
  };
}

/**
 * Just the products an order actually names.
 *
 * Order pricing used to run over `catalogueFor`, which is a PAGE: three
 * hundred rows ordered by name. A provisions shop with four hundred products
 * had every product sorting past position three hundred come back as one the
 * shop does not stock, and the merchant was asked to name a price for
 * something Rekoda was holding stock of and had a price for. It failed safe
 * (no invented figure ever reached a customer) and it was still wrong.
 *
 * Looking up the names asked for makes the cap stop mattering on the path
 * where it mattered most: an order is already bounded, so this query is.
 *
 * The fold is `foldProductName`, the same one `priceOrder` uses on the other
 * side of this boundary, so a product this finds is a product it can match.
 */
export async function catalogueByNames(
  tx: TenantDb,
  businessId: string,
  names: readonly string[],
): Promise<CatalogueItem[]> {
  const wanted = [...new Set(names.map(foldProductName))].filter((n) => n.length > 0);
  /* Postgres would reject `IN ()`, and an order that names nothing has
   * nothing to price anyway. */
  if (wanted.length === 0) return [];

  const rows = await tx.execute<CatalogueRow>(sql`
    SELECT p.id, p.name, p.description, p.unit_price_k, p.unit_cost_k, p.image_key, p.active,
           coalesce(sum(m.delta), 0)::int AS on_hand
    FROM products p
    LEFT JOIN inventory_movements m ON m.product_id = p.id
    WHERE p.business_id = ${businessId}::uuid
      AND lower(regexp_replace(btrim(p.name), '[[:space:]]+', ' ', 'g')) IN (${sql.join(
        wanted.map((n) => sql`${n}`),
        sql`, `,
      )})
    GROUP BY p.id, p.name, p.description, p.unit_price_k, p.unit_cost_k, p.image_key, p.active
    ORDER BY lower(p.name) ASC
  `);
  return [...rows].map(toItem);
}

/**
 * One page of what a customer may actually buy, and how many pages there are.
 *
 * Sellable means listed AND priced, filtered in SQL rather than in a caller:
 * the shop endpoint used to filter a capped page of the whole catalogue,
 * which is how a big shop silently published a fraction of itself with
 * nothing saying so. A customer-facing page cannot fix that with a caption —
 * "showing 300 of 400" is written for the merchant, and a browsing customer
 * has named nothing to look up — so the shop pages instead, and this is the
 * query a page of it comes from.
 *
 * OFFSET rather than keyset, deliberately: pages are small, the order is
 * stable (name, then id for ties), and a customer walking page links wants
 * page numbers, which keysets cannot give them.
 */
export interface SellablePage {
  rows: CatalogueItem[];
  /** Every sellable product, not this page of them. */
  count: number;
}

export async function sellableCatalogueFor(
  tx: TenantDb,
  businessId: string,
  input: { page: number; pageSize: number },
): Promise<SellablePage> {
  const offset = (input.page - 1) * input.pageSize;
  const rows = await tx.execute<CatalogueRow & { n: number }>(sql`
    WITH counted AS (
      /* No inventory join, deliberately: onHand never crosses the public
       * boundary (how many are left is the merchant's business), and joining
       * every movement just to discard the sum made each crawler-reachable
       * page view aggregate the tenant's whole stock history. */
      SELECT p.id, p.name, p.description, p.unit_price_k, p.unit_cost_k, p.image_key, p.active,
             0::int AS on_hand
      FROM products p
      WHERE p.business_id = ${businessId}::uuid
        AND p.active = 1
        AND p.unit_price_k IS NOT NULL
    )
    SELECT id, name, description, unit_price_k, unit_cost_k, image_key, active, on_hand,
           count(*) OVER ()::int AS n
    FROM counted
    ORDER BY lower(name) ASC, id ASC
    LIMIT ${input.pageSize} OFFSET ${offset}
  `);
  const list = [...rows];
  /* An out-of-range page returns zero rows AND zero count, because the
   * window ran over nothing. The caller needs the real total to 404 the
   * page rather than the shop, so fetch it when the page came back empty. */
  if (list.length === 0) {
    const counted = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM products p
      WHERE p.business_id = ${businessId}::uuid
        AND p.active = 1
        AND p.unit_price_k IS NOT NULL
    `);
    return { rows: [], count: [...counted][0]?.n ?? 0 };
  }
  return { rows: list.map(toItem), count: list[0]?.n ?? 0 };
}

export interface CatalogueEdit {
  /** Absent means leave it. Present and null means clear it. */
  description?: string | null | undefined;
  unitPriceK?: number | null | undefined;
  /**
   * A cost the merchant STATES, which replaces the weighted average.
   *
   * A delivery is a fact about goods arriving and moves the average.
   * This is a merchant correcting or supplying what something costs, and
   * averaging their answer with the history they are correcting would give
   * them neither figure.
   */
  unitCostK?: number | null | undefined;
  active?: boolean | undefined;
}

export type EditOutcome = 'updated' | 'not_found' | 'nothing_to_do';

/**
 * Change what the shop says about one product.
 *
 * Absent and null are different on purpose: a form that submits only what it
 * changed must be able to clear a description without every other field
 * arriving as null and wiping the price with it.
 */
export async function editProduct(
  tx: TenantDb,
  businessId: string,
  id: string,
  edit: CatalogueEdit,
): Promise<EditOutcome> {
  const values: Record<string, unknown> = {};
  if ('description' in edit) values['description'] = edit.description;
  if ('unitPriceK' in edit) values['unitPriceK'] = edit.unitPriceK;
  if ('unitCostK' in edit) values['unitCostK'] = edit.unitCostK;
  if ('active' in edit) values['active'] = edit.active ? 1 : 0;
  if (Object.keys(values).length === 0) return 'nothing_to_do';

  const updated = await tx
    .update(products)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(products.businessId, businessId), eq(products.id, id)))
    .returning({ id: products.id });
  return updated.length === 1 ? 'updated' : 'not_found';
}

/**
 * Attach a photo, and say what it replaced.
 *
 * The old key comes back so the caller can delete the object it points at.
 * Doing that here would mean a storage call inside a database transaction,
 * which is how a slow bucket becomes a held row lock.
 */
export async function setProductImage(
  tx: TenantDb,
  businessId: string,
  id: string,
  imageKey: string,
): Promise<{ outcome: 'updated'; replacedKey: string | null } | { outcome: 'not_found' }> {
  const existing = await tx
    .select({ imageKey: products.imageKey })
    .from(products)
    .where(and(eq(products.businessId, businessId), eq(products.id, id)))
    .limit(1);
  if (existing.length !== 1) return { outcome: 'not_found' };

  await tx
    .update(products)
    .set({ imageKey, updatedAt: new Date() })
    .where(and(eq(products.businessId, businessId), eq(products.id, id)));
  return { outcome: 'updated', replacedKey: existing[0]!.imageKey };
}

/**
 * The key for one product's photo, or null.
 *
 * Three locks, and the order matters for anyone reading this later. Row-level
 * security is the one that actually holds: `withBusiness` pins the tenant and
 * the policy on `products` filters another shop's row out before this query
 * sees it, which was confirmed by removing the predicate below and watching
 * the cross-tenant test still pass. The `business_id` in the WHERE is the
 * second, kept because a repo that reads across tenants when RLS is ever
 * misconfigured is a repo that leaks silently. The unguessable storage key is
 * the third.
 */
/**
 * The image key ONLY when the product is still sellable.
 *
 * The public photo route serves whatever key comes back, and the plain
 * lookup kept serving a product the merchant had de-listed: taken down from
 * the shop but alive at a previously shared URL, with a public cache header
 * keeping it warm. De-listed means gone, photos included.
 */
export async function sellableImageKeyFor(
  tx: TenantDb,
  businessId: string,
  id: string,
): Promise<string | null> {
  const rows = await tx
    .select({ imageKey: products.imageKey })
    .from(products)
    .where(
      and(
        eq(products.businessId, businessId),
        eq(products.id, id),
        eq(products.active, 1),
        isNotNull(products.unitPriceK),
      ),
    )
    .limit(1);
  return rows[0]?.imageKey ?? null;
}

export async function imageKeyFor(
  tx: TenantDb,
  businessId: string,
  id: string,
): Promise<string | null> {
  const rows = await tx
    .select({ imageKey: products.imageKey })
    .from(products)
    .where(and(eq(products.businessId, businessId), eq(products.id, id)))
    .limit(1);
  return rows[0]?.imageKey ?? null;
}
