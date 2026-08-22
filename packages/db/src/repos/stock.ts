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
import { and, eq, sql } from 'drizzle-orm';
import { costOfQuantityK, foldProductName, weightedAverageCostK } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { inventoryMovements, products } from '../schema/commerce.js';

export interface Product {
  id: string;
  name: string;
  unitPriceK: number | null;
  /** Weighted average of what it cost, or null when nobody has said. */
  unitCostK: number | null;
  onHand: number;
  /**
   * Whether it is listed in the shop. Not whether it exists: a hidden product
   * still sits on a shelf and still counts, which is why the stock register
   * shows it and marks it rather than dropping it.
   */
  active: boolean;
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
 *
 * The fold is `foldProductName` in @rekoda/core, expressed in SQL: trimmed,
 * lowered, and internal runs of whitespace collapsed to one space. The POSIX
 * class rather than `\s`, because a backslash inside a tagged template
 * literal never reaches Postgres: `'\s+'` arrives as `'s+'` and the pattern
 * quietly replaces runs of the letter s instead. Every name in the shop is
 * mangled and every match fails, which is at least loud. The last
 * of those was missing here while the TypeScript side had it, and the
 * consequence was not a missed match but a DUPLICATE: `findOrCreateProduct`
 * looked for "Bags  of  rice", did not find the shop's "Bags of rice", and
 * inserted a second row. Two products a human cannot tell apart, with the
 * stock history split between them from that moment on. `foldProductName`
 * carries the same warning from the other side.
 *
 * `active` is deliberately NOT part of the match. It says whether a product
 * is listed in the shop, not whether it exists, and filtering on it here made
 * `findOrCreateProduct` build a SECOND row the next time a merchant mentioned
 * something they had hidden. Their stock history would split in two at that
 * moment and the count would be wrong from then on, silently and forever.
 * A merchant who says "sold 2 bags of rice" has sold rice, whatever a listing
 * flag says.
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
    unit_cost_k: string | number | null;
    on_hand: number | null;
    active: number;
  }>(sql`
    SELECT p.id, p.name, p.unit_price_k, p.unit_cost_k, p.active,
           coalesce(sum(m.delta), 0)::int AS on_hand
    FROM products p
    LEFT JOIN inventory_movements m ON m.product_id = p.id
    WHERE p.business_id = ${businessId}::uuid
      AND lower(regexp_replace(btrim(p.name), '[[:space:]]+', ' ', 'g')) = ${foldProductName(name)}
    GROUP BY p.id, p.name, p.unit_price_k, p.unit_cost_k, p.active
    LIMIT 1
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    unitPriceK: row.unit_price_k === null ? null : Number(row.unit_price_k),
    unitCostK: row.unit_cost_k === null ? null : Number(row.unit_cost_k),
    onHand: row.on_hand ?? 0,
    active: row.active === 1,
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
  return { id: row.id, name: row.name, unitPriceK: null, unitCostK: null, onHand: 0, active: true };
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
 * A delivery arrived, and it moves what this product is reckoned to cost.
 *
 * One call rather than a movement and an update side by side, because the two
 * must not be able to happen separately: a count that rises without the cost
 * following it quietly averages the new goods in at the old price.
 *
 * `costK` is the whole amount the merchant paid for this delivery. When they
 * said "bought 10 crates of ankara for 50k" that is the only reading
 * available and it is the one they meant.
 */
export async function recordDelivery(
  tx: TenantDb,
  input: {
    businessId: string;
    product: Product;
    quantity: number;
    costK: number;
    sourceType: string;
    sourceId?: string | null;
  },
): Promise<number> {
  const averageCostK = weightedAverageCostK({
    onHand: input.product.onHand,
    averageCostK: input.product.unitCostK,
    arriving: input.quantity,
    costK: input.costK,
  });

  await recordMovement(tx, {
    businessId: input.businessId,
    productId: input.product.id,
    delta: input.quantity,
    reason: 'purchase',
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
  });

  await tx
    .update(products)
    .set({ unitCostK: averageCostK })
    .where(and(eq(products.businessId, input.businessId), eq(products.id, input.product.id)));

  return averageCostK;
}

export interface SaleMovements {
  /** Lines that matched a product the shop already counts. */
  moved: number;
  /**
   * What those lines cost, at each product's weighted average.
   *
   * The caller posts this to COGS. Zero means nothing that moved had a cost
   * recorded, which is different from the goods having been free.
   */
  costK: number;
  /**
   * How many of the moved lines had no cost to report.
   *
   * Counted rather than swallowed: revenue with no cost against it overstates
   * profit, and a merchant is owed the fact that it happened rather than a
   * gross margin that quietly assumes the goods cost nothing.
   */
  uncosted: number;
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
): Promise<SaleMovements> {
  let moved = 0;
  let costK = 0;
  let uncosted = 0;
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

    /* The cost of what left the shelf, at the average this product carries.
     * Null when nobody has ever told Rekoda what it cost, which is the state
     * every product starts in and a great many stay in. */
    const lineCostK = costOfQuantityK(product.unitCostK, quantity);
    if (lineCostK === null) uncosted += 1;
    else costK += lineCostK;
  }
  return { moved, costK, uncosted };
}

/**
 * What the register holds, and how much of it the page does not show.
 *
 * The counts are over the WHOLE table, never over the page. A caller that
 * asked for twenty products and counted the twenty it got would report a
 * shop of twenty products to a merchant who has forty five, and it would do
 * it in the merchant's own words, which is the kind of wrong nobody catches.
 */
export interface StockRegister {
  rows: Product[];
  /** Every product the business tracks, listed or not. */
  count: number;
  /** How many are at or below zero. */
  outOfStock: number;
  /** How many have never had a cost recorded. */
  withoutCost: number;
}

/**
 * Everything the shop tracks, most depleted first.
 *
 * The order is the point: a stock list sorted by name is a list somebody has
 * to read all of, and the row that needs acting on is the one about to run
 * out. Products with no movements at all sit at zero among them, which is
 * correct rather than a bug: something counted once and never restocked is
 * exactly as out of stock as something sold down to nothing.
 *
 * The three counts come back from SQL rather than from `rows.length` and
 * friends, because `rows` is a page and the counts are about the shop. They
 * are what lets a caller say what it left out instead of presenting its page
 * as the whole list.
 */
export async function stockList(
  tx: TenantDb,
  businessId: string,
  limit = 200,
): Promise<StockRegister> {
  const rows = await tx.execute<{
    id: string;
    name: string;
    unit_price_k: string | number | null;
    unit_cost_k: string | number | null;
    on_hand: number | null;
    active: number;
    n: number;
    out_n: number;
    nocost_n: number;
  }>(sql`
    WITH counted AS (
      SELECT p.id, p.name, p.unit_price_k, p.unit_cost_k, p.active,
             coalesce(sum(m.delta), 0)::int AS on_hand
      FROM products p
      LEFT JOIN inventory_movements m ON m.product_id = p.id
      WHERE p.business_id = ${businessId}::uuid
      GROUP BY p.id, p.name, p.unit_price_k, p.unit_cost_k, p.active
    )
    SELECT id, name, unit_price_k, unit_cost_k, active, on_hand,
           count(*) OVER ()::int AS n,
           count(*) FILTER (WHERE on_hand <= 0) OVER ()::int AS out_n,
           count(*) FILTER (WHERE unit_cost_k IS NULL) OVER ()::int AS nocost_n
    FROM counted
    ORDER BY on_hand ASC, name ASC
    LIMIT ${limit}
  `);
  const list = [...rows];
  return {
    rows: list.map((r) => ({
      id: r.id,
      name: r.name,
      unitPriceK: r.unit_price_k === null ? null : Number(r.unit_price_k),
      unitCostK: r.unit_cost_k === null ? null : Number(r.unit_cost_k),
      onHand: r.on_hand ?? 0,
      active: r.active === 1,
    })),
    count: list[0]?.n ?? 0,
    outOfStock: list[0]?.out_n ?? 0,
    withoutCost: list[0]?.nocost_n ?? 0,
  };
}
