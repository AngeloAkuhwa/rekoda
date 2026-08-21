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
import { and, eq, sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { products } from '../schema/commerce.js';

export interface CatalogueItem {
  id: string;
  name: string;
  description: string | null;
  unitPriceK: number | null;
  /** Storage key, not a URL. What serves it decides what a URL looks like. */
  imageKey: string | null;
  active: boolean;
  onHand: number;
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
  limit = 300,
): Promise<CatalogueItem[]> {
  const rows = await tx.execute<{
    id: string;
    name: string;
    description: string | null;
    unit_price_k: string | number | null;
    image_key: string | null;
    active: number;
    on_hand: number | null;
  }>(sql`
    SELECT p.id, p.name, p.description, p.unit_price_k, p.image_key, p.active,
           coalesce(sum(m.delta), 0)::int AS on_hand
    FROM products p
    LEFT JOIN inventory_movements m ON m.product_id = p.id
    WHERE p.business_id = ${businessId}::uuid
    GROUP BY p.id, p.name, p.description, p.unit_price_k, p.image_key, p.active
    ORDER BY lower(p.name) ASC
    LIMIT ${limit}
  `);

  return [...rows].map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    unitPriceK: r.unit_price_k === null ? null : Number(r.unit_price_k),
    imageKey: r.image_key,
    active: r.active === 1,
    onHand: r.on_hand ?? 0,
  }));
}

export interface CatalogueEdit {
  /** Absent means leave it. Present and null means clear it. */
  description?: string | null | undefined;
  unitPriceK?: number | null | undefined;
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
