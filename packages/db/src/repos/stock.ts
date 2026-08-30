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

/** Why the stock moved. `adjustment` is the merchant counting their own
 * shelf; `opening` is what the shelf already held on day one (PR-083). */
export type MovementReason =
  | 'sale'
  | 'purchase'
  | 'adjustment'
  | 'reservation'
  | 'release'
  | 'return'
  | 'supplier_return'
  | 'opening';

export interface StockMovement {
  businessId: string;
  productId: string;
  delta: number;
  reason: MovementReason;
  sourceType: string;
  sourceId?: string | null;
  /** The unit cost APPLIED to this movement (Appendix B): receipt cost
   * inbound, issue cost outbound. Null when nobody has ever costed it. */
  unitCostK?: number | null;
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

  /* Backed by products_business_folded_name_ux now: two messages naming a
   * new product at the same moment used to both pass the read above and
   * both insert, splitting the stock history between twins forever (the
   * exact outcome the docblock above warns about). The index decides, and
   * the loser reads the winner. */
  const inserted = await tx
    .insert(products)
    .values({ businessId, name: name.trim() })
    .onConflictDoNothing()
    .returning({ id: products.id, name: products.name });
  const row = inserted[0];
  if (!row) {
    const winner = await productByName(tx, businessId, name);
    if (!winner) throw new Error('product insert conflicted but the winner is not readable');
    return winner;
  }
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
    unitCostK: movement.unitCostK ?? null,
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
    /**
     * How this arrival should be remembered. 'purchase' for goods bought;
     * 'opening' for stock the business already held on the day it started
     * with Rekoda (PR-083) — same lock, same weighted average, different
     * history.
     */
    reason?: 'purchase' | 'opening';
  },
): Promise<number> {
  /**
   * Locked and re-read before averaging. The caller's snapshot was taken by
   * an earlier SELECT, and two deliveries racing on it would each average
   * against the same pre-state; the second UPDATE then overwrites the first
   * and the weighted cost forgets a delivery forever, which every later
   * sale's COGS inherits. FOR UPDATE serialises the two, and the fresh sum
   * is the state the average is truly joining.
   */
  const lockedRows = await tx.execute<{ unit_cost_k: string | number | null; on_hand: number }>(sql`
    SELECT p.unit_cost_k,
           (SELECT coalesce(sum(m.delta), 0)::int
              FROM inventory_movements m WHERE m.product_id = p.id) AS on_hand
    FROM products p
    WHERE p.business_id = ${input.businessId}::uuid AND p.id = ${input.product.id}::uuid
    FOR UPDATE OF p
  `);
  const locked = [...lockedRows][0];
  const averageCostK = weightedAverageCostK({
    onHand: locked?.on_hand ?? input.product.onHand,
    averageCostK:
      locked === undefined
        ? input.product.unitCostK
        : locked.unit_cost_k === null
          ? null
          : Number(locked.unit_cost_k),
    arriving: input.quantity,
    costK: input.costK,
  });

  await recordMovement(tx, {
    businessId: input.businessId,
    productId: input.product.id,
    delta: input.quantity,
    reason: input.reason ?? 'purchase',
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    /* The receipt's own per-unit cost rides the movement (Appendix B),
     * which is what a supplier return later reverses at. */
    unitCostK: Math.round(input.costK / input.quantity),
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
/**
 * The shelf could not cover this order (PR-138).
 *
 * An exception rather than a return value at the call site, because by the
 * time the reservation runs the invoice and order rows are already written
 * in the same transaction: unwinding them one by one would be a second
 * implementation of rollback. Throwing takes the whole transaction with it,
 * which is the only version that cannot leave half an order behind.
 */
export class InsufficientStock extends Error {
  override readonly name = 'InsufficientStock';
  constructor(readonly shortfalls: readonly StockShortfall[]) {
    /* Names and numbers only. A shortfall carries no customer and no price,
     * so this message is safe in an ordinary log. */
    super(
      `insufficient stock: ${shortfalls
        .map((s) => `${s.name} wanted ${s.wanted}, ${s.onHand} on hand`)
        .join('; ')}`,
    );
  }
}

/** A line the shelf could not cover, named so a caller can say which. */
export interface StockShortfall {
  productId: string;
  name: string;
  wanted: number;
  onHand: number;
}

export type ReserveOutcome =
  | { outcome: 'reserved'; movements: SaleMovements }
  | { outcome: 'insufficient'; shortfalls: StockShortfall[] };

/**
 * Take stock for a sale, atomically (PR-138).
 *
 * The bug this exists to close: every caller used to read on-hand with a
 * plain SELECT, decide, and record the movements later. Two customers
 * reaching the last item both read one, both passed, and both bought it. The
 * storefront did not even read - it recorded the movements and let the count
 * go negative.
 *
 * The fix is the one `recordDelivery` already uses a few lines above for the
 * weighted average: take `FOR UPDATE` on the product rows FIRST, re-sum the
 * movements under that lock, and only then decide. A second transaction
 * wanting the same product waits at the lock and re-sums after the first
 * commits, so it sees the decremented figure rather than the stale one.
 *
 * Deliberately NOT a stored balance column. `on_hand` is `SUM(delta)` and is
 * never stored (see the top of this file): a cached count is a second answer
 * that can disagree with the movements, and reconciling the two is a worse
 * problem than the one being solved.
 *
 * Products are locked in a stable order (by id) so two multi-line orders
 * touching the same pair cannot deadlock by taking them opposite ways.
 *
 * A product the shop does not TRACK is not refused: the same rule
 * `recordSaleMovements` has always kept. A merchant who never told Rekoda
 * they stock something has not asked Rekoda to count it, and refusing a sale
 * on a count nobody keeps would stop shops selling what they actually have.
 */
export async function reserveStockForOrder(
  tx: TenantDb,
  businessId: string,
  items: ReadonlyArray<{ name: string; quantity: number }>,
  sourceId: string,
): Promise<ReserveOutcome> {
  /* Resolve names to products first, so the lock is taken on ids in a
   * deterministic order rather than in whatever order the cart arrived. */
  const wanted = new Map<string, { name: string; quantity: number }>();
  for (const item of items) {
    const quantity = Math.ceil(item.quantity);
    if (quantity <= 0) continue;
    const product = await productByName(tx, businessId, item.name);
    if (!product) continue; // untracked: not this function's business
    const prior = wanted.get(product.id);
    /* The same product on two lines is ONE reservation of the total. Locking
     * per line would check each against the full shelf and let a cart of
     * "2 wigs" and "2 wigs" pass on a shelf holding three. */
    wanted.set(product.id, {
      name: product.name,
      quantity: (prior?.quantity ?? 0) + quantity,
    });
  }
  if (wanted.size === 0)
    return { outcome: 'reserved', movements: { moved: 0, costK: 0, uncosted: 0 } };

  const ids = [...wanted.keys()].sort();

  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  /**
   * TWO STATEMENTS, and the split is the whole correctness argument.
   *
   * Taking the lock and summing the movements in ONE statement looks tidier
   * and is wrong under READ COMMITTED. When a blocked `FOR UPDATE` is
   * released, PostgreSQL re-reads the LOCKED ROW at the new snapshot, but a
   * correlated subquery in the select list still evaluates against the
   * statement's ORIGINAL snapshot. The lock would be held honestly while the
   * on-hand figure beside it stayed the stale one the waiter arrived with,
   * which is exactly the race this function exists to remove. The
   * concurrency test at two customers passes on that version by timing; at
   * eight it sells a shelf of three to all eight.
   *
   * So: lock first, and nothing else.
   */
  const locked = await tx.execute<{ id: string; unit_cost_k: string | number | null }>(sql`
    SELECT p.id, p.unit_cost_k
      FROM products p
     WHERE p.business_id = ${businessId}::uuid
       AND p.id IN (${idList})
     ORDER BY p.id
       FOR UPDATE
  `);

  /* Then sum, in a NEW statement, which takes a fresh snapshot now that the
   * rows are ours. Every committed movement is visible here, including those
   * written by the transaction we just waited for. */
  const sums = await tx.execute<{ product_id: string; on_hand: number }>(sql`
    SELECT m.product_id, coalesce(sum(m.delta), 0)::int AS on_hand
      FROM inventory_movements m
     WHERE m.business_id = ${businessId}::uuid
       AND m.product_id IN (${idList})
     GROUP BY m.product_id
  `);
  const onHandByProduct = new Map([...sums].map((row) => [row.product_id, row.on_hand]));

  /**
   * Absence from the sums IS "never counted" (W3, PR-088).
   *
   * A product with no movement history is not stock-tracked, and inventing an
   * empty shelf for it would refuse a service nobody counts - which is most
   * of what a new merchant lists. `onHandByIds` draws exactly this
   * distinction with an EXISTS, and the GROUP BY above gives it for free: a
   * product with no rows is simply not in the map.
   */
  const held = new Map(
    [...locked].map((row) => [
      row.id,
      {
        ...row,
        on_hand: onHandByProduct.get(row.id) ?? 0,
        counted: onHandByProduct.has(row.id),
      },
    ]),
  );
  const shortfalls: StockShortfall[] = [];
  for (const [productId, line] of wanted) {
    const row = held.get(productId);
    if (!row) continue;
    /* Only a shelf somebody counts can be short. The movement is still
     * recorded below either way, so an uncounted product becomes counted
     * from its first sale, exactly as it did before. */
    if (row.counted && row.on_hand < line.quantity) {
      shortfalls.push({
        productId,
        name: line.name,
        wanted: line.quantity,
        onHand: row.on_hand,
      });
    }
  }
  /* All or nothing. A partial order the customer did not compose is worse
   * than a refusal they can act on. */
  if (shortfalls.length > 0) return { outcome: 'insufficient', shortfalls };

  let moved = 0;
  let costK = 0;
  let uncosted = 0;
  for (const productId of ids) {
    const line = wanted.get(productId)!;
    const row = held.get(productId);
    if (!row) continue;
    const unitCostK = row.unit_cost_k === null ? null : Number(row.unit_cost_k);
    await recordMovement(tx, {
      businessId,
      productId,
      delta: -line.quantity,
      reason: 'sale',
      sourceType: 'invoice',
      sourceId,
      /* The ORIGINAL ISSUE COST, carried on the outbound movement
       * (Appendix B) - what a customer return restores at. */
      unitCostK,
    });
    moved += 1;
    const lineCostK = costOfQuantityK(unitCostK, line.quantity);
    if (lineCostK === null) uncosted += 1;
    else costK += lineCostK;
  }
  return { outcome: 'reserved', movements: { moved, costK, uncosted } };
}

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
      /* The ORIGINAL ISSUE COST, carried on the outbound movement
       * (Appendix B) — what a customer return restores at. */
      unitCostK: product.unitCostK,
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

/**
 * On-hand per product, with whether the shelf was ever counted (W3,
 * PR-088). The validator refuses an order the counted shelf cannot serve;
 * a product with no movement history is not stock-tracked, and inventing
 * an empty shelf for it would refuse a service nobody counts.
 */
export async function onHandByIds(
  tx: TenantDb,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, { onHand: number; counted: boolean }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; on_hand: string; counted: boolean }>(sql`
    SELECT p.id,
           COALESCE((SELECT SUM(m.delta) FROM inventory_movements m WHERE m.product_id = p.id), 0) AS on_hand,
           EXISTS (SELECT 1 FROM inventory_movements m WHERE m.product_id = p.id) AS counted
    FROM products p
    WHERE p.business_id = ${businessId}::uuid
      AND p.id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  return new Map([...rows].map((r) => [r.id, { onHand: Number(r.on_hand), counted: r.counted }]));
}
