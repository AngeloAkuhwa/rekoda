/**
 * Products, and the append-only ledger of how much of each there is.
 *
 * Both tables have existed since migration 0000 and nothing has ever written
 * to either. `AdjustInventory` has been in the command contract since M0 with
 * no handler behind it, so a merchant who typed "add 20 bags of rice" was told
 * that recording that kind of entry was not built yet, which was true.
 *
 * On-hand is `SUM(delta)` and is never stored. A stored count is a number two
 * writers can disagree about; a sum over an append-only ledger is the same
 * discipline the money ledger already runs under (ADR 0004), applied to
 * things instead of naira.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { inventoryMovements, products } from '../schema/commerce.js';

export interface Product {
  id: string;
  name: string;
  unitPriceK: number | null;
  onHand: number;
}

/** Why the stock moved. `adjustment` is the merchant counting their own shelf. */
export type MovementReason = 'sale' | 'purchase' | 'adjustment' | 'reservation' | 'release';

export interface StockMovement {
  businessId: string;
  productId: string;
  delta: number;
  reason: MovementReason;
  sourceType: string;
  sourceId?: string | null;
}

/**
 * Find a product by what the merchant called it, case and space insensitive.
 *
 * Deliberately not fuzzy. "rice" and "bags of rice" are different products in
 * some shops and the same one in others, and a matcher that guessed would
 * silently move stock the merchant did not mean. An exact-after-normalising
 * match either finds their product or does not, and "does not" is a question
 * the caller can ask out loud.
 */
export async function productByName(
  tx: TenantDb,
  businessId: string,
  name: string,
): Promise<Product | null> {
  const rows = await tx.execute<{
    id: string;
    name: string;
    unit_price_k: string | number | null;
    on_hand: number | null;
  }>(sql`
    SELECT p.id, p.name, p.unit_price_k,
           coalesce(sum(m.delta), 0)::int AS on_hand
    FROM products p
    LEFT JOIN inventory_movements m ON m.product_id = p.id
    WHERE p.business_id = ${businessId}::uuid
      AND lower(btrim(p.name)) = lower(btrim(${name}))
      AND p.active = 1
    GROUP BY p.id, p.name, p.unit_price_k
    LIMIT 1
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    unitPriceK: row.unit_price_k === null ? null : Number(row.unit_price_k),
    onHand: row.on_hand ?? 0,
  };
}

/**
 * The product the merchant means, created if this is the first time they have
 * mentioned it.
 *
 * A shop's catalogue builds itself out of what they actually trade rather than
 * out of a setup screen nobody fills in. The name is stored as they typed it,
 * because it is theirs and it is what they will type again.
 */
export async function findOrCreateProduct(
  tx: TenantDb,
  businessId: string,
  name: string,
): Promise<Product> {
  const existing = await productByName(tx, businessId, name);
  if (existing) return existing;

  const inserted = await tx
    .insert(products)
    .values({ businessId, name: name.trim() })
    .returning({ id: products.id, name: products.name });
  const row = inserted[0]!;
  return { id: row.id, name: row.name, unitPriceK: null, onHand: 0 };
}

/** Append one movement. Never an UPDATE: the count is the sum of the history. */
export async function recordMovement(tx: TenantDb, movement: StockMovement): Promise<void> {
  await tx.insert(inventoryMovements).values({
    businessId: movement.businessId,
    productId: movement.productId,
    delta: movement.delta,
    reason: movement.reason,
    sourceType: movement.sourceType,
    sourceId: movement.sourceId ?? null,
  });
}

/**
 * Move stock for the lines of a sale that name something the shop tracks.
 *
 * Matched by name against products that ALREADY exist, and silent about the
 * rest. A sale of something never counted must not invent a product and then
 * report it as minus three: a merchant who has not told Rekoda they stock
 * something has not asked Rekoda to count it.
 *
 * Returns how many lines moved, which is what lets a caller say "3 of 5 lines
 * came off stock" rather than implying the whole sale did.
 */
export async function recordSaleMovements(
  tx: TenantDb,
  businessId: string,
  items: ReadonlyArray<{ name: string; quantity: number }>,
  sourceId: string,
): Promise<number> {
  let moved = 0;
  for (const item of items) {
    const product = await productByName(tx, businessId, item.name);
    if (!product) continue;
    /**
     * Rounded UP, not truncated.
     *
     * `delta` is an integer column and a stock count is whole units, but a
     * sale line is not: the contract allows 2.5, and a merchant selling rice
     * by weight will send it. Truncating would leave the shop believing it
     * holds MORE than it does, and a merchant who thinks they have stock
     * promises a customer something that is not on the shelf. Believing they
     * hold less only sends them to restock early, which is the error a shop
     * recovers from. Sub-unit quantities still round to 1 rather than
     * vanishing, for the same reason.
     */
    const quantity = Math.ceil(item.quantity);
    if (quantity <= 0) continue;
    await recordMovement(tx, {
      businessId,
      productId: product.id,
      delta: -quantity,
      reason: 'sale',
      sourceType: 'invoice',
      sourceId,
    });
    moved += 1;
  }
  return moved;
}

/**
 * Everything the shop tracks, most depleted first.
 *
 * The order is the point: a stock list sorted by name is a list somebody has
 * to read all of, and the row that needs acting on is the one about to run
 * out. Products with no movements at all sit at zero among them, which is
 * correct rather than a bug: something counted once and never restocked is
 * exactly as out of stock as something sold down to nothing.
 */
export async function stockList(tx: TenantDb, businessId: string, limit = 200): Promise<Product[]> {
  const rows = await tx.execute<{
    id: string;
    name: string;
    unit_price_k: string | number | null;
    on_hand: number | null;
  }>(sql`
    SELECT p.id, p.name, p.unit_price_k,
           coalesce(sum(m.delta), 0)::int AS on_hand
    FROM products p
    LEFT JOIN inventory_movements m ON m.product_id = p.id
    WHERE p.business_id = ${businessId}::uuid AND p.active = 1
    GROUP BY p.id, p.name, p.unit_price_k
    ORDER BY coalesce(sum(m.delta), 0) ASC, p.name ASC
    LIMIT ${limit}
  `);
  return [...rows].map((r) => ({
    id: r.id,
    name: r.name,
    unitPriceK: r.unit_price_k === null ? null : Number(r.unit_price_k),
    onHand: r.on_hand ?? 0,
  }));
}
