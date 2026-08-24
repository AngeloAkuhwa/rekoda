/**
 * Orders somebody else placed (MASTER-PLAN §5.3.5).
 *
 * `orders` and `order_items` have been in the schema since M0 with nothing
 * writing them, waiting for a door that lets a customer rather than a
 * merchant say what they want. This is the first of those doors: a message
 * the customer wrote, forwarded by the merchant.
 *
 * An order is NOT a financial document. Nothing is owed and nothing is
 * posted: the merchant has been asked, and until they agree there is no sale
 * and no ledger entry. Agreeing is what raises the invoice, and that is a
 * separate write with its own posting.
 *
 * ── what is deliberately not stored ────────────────────────────────────────
 *
 * The customer's own words. A forwarded message carries a name, often a
 * phone number and frequently a delivery address, all belonging to somebody
 * who never agreed to Rekoda holding them. What survives is what the books
 * need: which products, how many, at what price. The rest is echoed back to
 * the merchant once, in the preview, and never written down. It is already
 * on their phone in the message they forwarded.
 */
import { and, eq, sql } from 'drizzle-orm';
import { lagosYear } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { orders, orderItems } from '../schema/commerce.js';
import { invoices } from '../schema/finance.js';
import { nextDocumentNumber } from './issue.js';

export interface PlaceOrderLine {
  /** Null for a free-typed quote line naming nothing the shop counts. */
  productId: string | null;
  name: string;
  quantity: number;
  unitPriceK: number;
  lineTotalK: number;
}

export interface PlaceOrderInput {
  businessId: string;
  customerId: string | null;
  lines: PlaceOrderLine[];
  totalK: number;
  sourceType: string;
  sourceId: string;
  /**
   * The provider's own id for this order, when one exists. Null for a
   * forwarded message, which has no id of its own; the catalogue webhook
   * (Door 3) will have one, and the unique index makes a redelivered webhook
   * a no-op rather than a second order.
   */
  externalRef?: string | null;
  placedAt?: Date;
}

export interface PlacedOrder {
  id: string;
  orderNumber: string;
}

export async function placeOrder(tx: TenantDb, input: PlaceOrderInput): Promise<PlacedOrder> {
  const placedAt = input.placedAt ?? new Date();
  /* The counter first and inside the caller's transaction, same as every
   * other numbered document: a failure below un-bumps it, so numbering stays
   * dense and there is no gap for an auditor to read as a deletion. */
  const orderNumber = await nextDocumentNumber(tx, input.businessId, 'order', lagosYear(placedAt));

  const rows = await tx
    .insert(orders)
    .values({
      businessId: input.businessId,
      customerId: input.customerId,
      orderNumber,
      status: 'placed',
      totalK: input.totalK,
      externalRef: input.externalRef ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      createdAt: placedAt,
    })
    .returning({ id: orders.id });
  const order = rows[0];
  if (!order) throw new Error('placeOrder: insert returned no row');

  if (input.lines.length > 0) {
    await tx.insert(orderItems).values(
      input.lines.map((line) => ({
        businessId: input.businessId,
        orderId: order.id,
        productId: line.productId,
        name: line.name,
        quantity: line.quantity,
        unitPriceK: line.unitPriceK,
        lineTotalK: line.lineTotalK,
      })),
    );
  }

  return { id: order.id, orderNumber };
}

/**
 * A quote: an order-shaped OFFER (fix-plan 4, G3).
 *
 * Same table, same lines, same race-proof status machine — because a quote
 * that converts becomes exactly the order→invoice the engine already knows.
 * What separates it is everything a register needs: its own QUO counter (an
 * offer is not an obligation and must never be quoted by an invoice-shaped
 * number), the `quoted` status, and an optional last-valid Lagos day.
 */
export interface CreateQuoteInput {
  businessId: string;
  customerId: string | null;
  lines: PlaceOrderLine[];
  totalK: number;
  /** `YYYY-MM-DD`, or null for an offer with no expiry. */
  validUntil: string | null;
  /** One-shot key from the form, deduped by `orders_external_ux`. */
  clientRef: string | null;
  sourceId: string;
}

export async function createQuote(tx: TenantDb, input: CreateQuoteInput): Promise<PlacedOrder> {
  const at = new Date();
  const quoteNumber = await nextDocumentNumber(tx, input.businessId, 'quote', lagosYear(at));

  const rows = await tx
    .insert(orders)
    .values({
      businessId: input.businessId,
      customerId: input.customerId,
      orderNumber: quoteNumber,
      status: 'quoted',
      totalK: input.totalK,
      externalRef: input.clientRef ? `dash:${input.clientRef}` : null,
      validUntil: input.validUntil,
      sourceType: 'dashboard',
      sourceId: input.sourceId,
      createdAt: at,
    })
    .returning({ id: orders.id });
  const quote = rows[0];
  if (!quote) throw new Error('createQuote: insert returned no row');

  await tx.insert(orderItems).values(
    input.lines.map((line) => ({
      businessId: input.businessId,
      orderId: quote.id,
      productId: line.productId,
      name: line.name,
      quantity: line.quantity,
      unitPriceK: line.unitPriceK,
      lineTotalK: line.lineTotalK,
    })),
  );

  return { id: quote.id, orderNumber: quoteNumber };
}

export interface QuoteRow {
  id: string;
  quoteNumber: string;
  status: string;
  totalK: number;
  validUntil: string | null;
  invoiceNumber: string | null;
  createdAt: Date;
  itemCount: number;
}

export interface Quotes {
  rows: QuoteRow[];
  count: number;
}

/** The quote register: every QUO-numbered row, whatever became of it. */
export async function quotesFor(tx: TenantDb, businessId: string, limit = 100): Promise<Quotes> {
  const rows = await tx.execute<{
    id: string;
    order_number: string;
    status: string;
    total_k: string;
    valid_until: string | null;
    invoice_number: string | null;
    created_at: Date;
    item_count: number;
    n: number;
  }>(sql`
    SELECT o.id, o.order_number, o.status, o.total_k::bigint AS total_k,
           o.valid_until::text AS valid_until, inv.invoice_number,
           o.created_at, count(i.id)::int AS item_count,
           count(*) OVER ()::int AS n
    FROM orders o
    LEFT JOIN order_items i ON i.order_id = o.id AND i.business_id = o.business_id
    LEFT JOIN invoices inv ON inv.id = o.invoice_id AND inv.business_id = o.business_id
    WHERE o.business_id = ${businessId}::uuid
      AND o.order_number LIKE 'QUO-%'
    GROUP BY o.id, o.order_number, o.status, o.total_k, o.valid_until,
             inv.invoice_number, o.created_at
    ORDER BY o.created_at DESC
    LIMIT ${limit}
  `);
  const list = [...rows];
  return {
    count: list[0]?.n ?? 0,
    rows: list.map((r) => ({
      id: r.id,
      quoteNumber: r.order_number,
      status: r.status,
      totalK: Number(r.total_k),
      validUntil: r.valid_until,
      invoiceNumber: r.invoice_number,
      createdAt: new Date(r.created_at),
      itemCount: r.item_count,
    })),
  };
}

export interface QuoteWithLines {
  id: string;
  quoteNumber: string;
  status: string;
  totalK: number;
  validUntil: string | null;
  customerId: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  lines: Array<{
    productId: string | null;
    name: string;
    quantity: number;
    unitPriceK: number;
    lineTotalK: number;
  }>;
}

/** One quote with its lines — what a conversion needs, in one read. */
export async function quoteByNumber(
  tx: TenantDb,
  businessId: string,
  quoteNumber: string,
): Promise<QuoteWithLines | null> {
  const head = await tx
    .select({
      id: orders.id,
      status: orders.status,
      totalK: orders.totalK,
      validUntil: orders.validUntil,
      customerId: orders.customerId,
      invoiceId: orders.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
    })
    .from(orders)
    .leftJoin(invoices, eq(invoices.id, orders.invoiceId))
    .where(and(eq(orders.businessId, businessId), eq(orders.orderNumber, quoteNumber)))
    .limit(1);
  const quote = head[0];
  if (!quote) return null;

  const lines = await tx
    .select({
      productId: orderItems.productId,
      name: orderItems.name,
      quantity: orderItems.quantity,
      unitPriceK: orderItems.unitPriceK,
      lineTotalK: orderItems.lineTotalK,
    })
    .from(orderItems)
    .where(and(eq(orderItems.businessId, businessId), eq(orderItems.orderId, quote.id)));

  return {
    id: quote.id,
    quoteNumber,
    status: quote.status,
    totalK: Number(quote.totalK),
    validUntil: quote.validUntil,
    customerId: quote.customerId,
    invoiceId: quote.invoiceId,
    invoiceNumber: quote.invoiceNumber,
    lines: lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      quantity: l.quantity,
      unitPriceK: Number(l.unitPriceK),
      lineTotalK: Number(l.lineTotalK),
    })),
  };
}

/**
 * A purchase order: the quote's mirror, pointing at a supplier (fix-plan 4,
 * G4).
 *
 * Same table and same race-proof status machine, for the same reason quotes
 * took them: receiving one IS the purchase the spend engine already knows,
 * so a parallel table would duplicate the rows to encode a prefix. What
 * separates it is its own PO counter (what a supplier is chased with must
 * never name a customer's document), the `open` status, and the expected
 * delivery day riding the same date column a quote's expiry rides.
 *
 * No supplier reference, deliberately: Rekoda stores nothing about
 * suppliers. `customerId` stays null, which is also what keeps these rows
 * out of every customer-scoped read.
 */
export interface CreatePurchaseOrderInput {
  businessId: string;
  lines: PlaceOrderLine[];
  totalK: number;
  /** `YYYY-MM-DD`, or null when nobody said when the goods should land. */
  expectedOn: string | null;
  /** One-shot key from the form, deduped by `orders_external_ux`. */
  clientRef: string | null;
  sourceId: string;
}

export async function createPurchaseOrder(
  tx: TenantDb,
  input: CreatePurchaseOrderInput,
): Promise<PlacedOrder> {
  const at = new Date();
  const poNumber = await nextDocumentNumber(tx, input.businessId, 'purchase_order', lagosYear(at));

  const rows = await tx
    .insert(orders)
    .values({
      businessId: input.businessId,
      customerId: null,
      orderNumber: poNumber,
      status: 'open',
      totalK: input.totalK,
      externalRef: input.clientRef ? `dash:${input.clientRef}` : null,
      validUntil: input.expectedOn,
      sourceType: 'dashboard',
      sourceId: input.sourceId,
      createdAt: at,
    })
    .returning({ id: orders.id });
  const po = rows[0];
  if (!po) throw new Error('createPurchaseOrder: insert returned no row');

  await tx.insert(orderItems).values(
    input.lines.map((line) => ({
      businessId: input.businessId,
      orderId: po.id,
      productId: line.productId,
      name: line.name,
      quantity: line.quantity,
      unitPriceK: line.unitPriceK,
      lineTotalK: line.lineTotalK,
    })),
  );

  return { id: po.id, orderNumber: poNumber };
}

export interface PurchaseOrderRow {
  id: string;
  poNumber: string;
  status: string;
  totalK: number;
  expectedOn: string | null;
  createdAt: Date;
  itemCount: number;
}

export interface PurchaseOrders {
  rows: PurchaseOrderRow[];
  count: number;
}

/** The supplier-side register: PO- rows only, newest first. */
export async function purchaseOrdersFor(
  tx: TenantDb,
  businessId: string,
  limit = 100,
): Promise<PurchaseOrders> {
  const rows = await tx.execute<{
    id: string;
    order_number: string;
    status: string;
    total_k: string;
    expected_on: string | null;
    created_at: Date;
    item_count: number;
    n: number;
  }>(sql`
    SELECT o.id, o.order_number, o.status, o.total_k::bigint AS total_k,
           o.valid_until::text AS expected_on,
           o.created_at, count(i.id)::int AS item_count,
           count(*) OVER ()::int AS n
    FROM orders o
    LEFT JOIN order_items i ON i.order_id = o.id AND i.business_id = o.business_id
    WHERE o.business_id = ${businessId}::uuid
      AND o.order_number LIKE 'PO-%'
    GROUP BY o.id, o.order_number, o.status, o.total_k, o.valid_until, o.created_at
    ORDER BY o.created_at DESC
    LIMIT ${limit}
  `);
  const list = [...rows];
  return {
    count: list[0]?.n ?? 0,
    rows: list.map((r) => ({
      id: r.id,
      poNumber: r.order_number,
      status: r.status,
      totalK: Number(r.total_k),
      expectedOn: r.expected_on,
      /* Raw execute hands timestamps back as strings; same defence as the
       * registers above. */
      createdAt: new Date(r.created_at),
      itemCount: r.item_count,
    })),
  };
}

export interface PurchaseOrderWithLines {
  id: string;
  poNumber: string;
  status: string;
  totalK: number;
  expectedOn: string | null;
  lines: Array<{
    productId: string | null;
    name: string;
    quantity: number;
    unitPriceK: number;
    lineTotalK: number;
  }>;
}

/** One purchase order with its lines — what receiving needs, in one read. */
export async function purchaseOrderByNumber(
  tx: TenantDb,
  businessId: string,
  poNumber: string,
): Promise<PurchaseOrderWithLines | null> {
  const head = await tx
    .select({
      id: orders.id,
      status: orders.status,
      totalK: orders.totalK,
      expectedOn: orders.validUntil,
    })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), eq(orders.orderNumber, poNumber)))
    .limit(1);
  const po = head[0];
  if (!po) return null;

  const lines = await tx
    .select({
      productId: orderItems.productId,
      name: orderItems.name,
      quantity: orderItems.quantity,
      unitPriceK: orderItems.unitPriceK,
      lineTotalK: orderItems.lineTotalK,
    })
    .from(orderItems)
    .where(and(eq(orderItems.businessId, businessId), eq(orderItems.orderId, po.id)));

  return {
    id: po.id,
    poNumber,
    status: po.status,
    totalK: Number(po.totalK),
    expectedOn: po.expectedOn,
    lines: lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      quantity: l.quantity,
      unitPriceK: Number(l.unitPriceK),
      lineTotalK: Number(l.lineTotalK),
    })),
  };
}

export type MarkOutcome = 'marked' | 'already' | 'not_found';

/**
 * Move an order on, once and only once.
 *
 * `status = ${from}` in the WHERE is the mutual exclusion, and it is the same
 * shape the void and the credit note use: the status read a moment ago
 * settles nothing, because two callers both read `placed` before either
 * writes. Only this UPDATE decides, so only its winner may raise the invoice
 * that follows.
 *
 * `invoiceId` is written by the same statement that moves the status, not by
 * a second one. A confirmed order with no invoice attached would be a row
 * claiming a document exists with no way to find it, and the register would
 * be back to matching them by eye.
 */
export async function markOrder(
  tx: TenantDb,
  businessId: string,
  id: string,
  from: string,
  to: string,
  invoiceId?: string,
): Promise<MarkOutcome> {
  const moved = await tx
    .update(orders)
    .set({ status: to, updatedAt: new Date(), ...(invoiceId ? { invoiceId } : {}) })
    .where(and(eq(orders.businessId, businessId), eq(orders.id, id), eq(orders.status, from)))
    .returning({ id: orders.id });
  if (moved.length === 1) return 'marked';

  const existing = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), eq(orders.id, id)))
    .limit(1);
  return existing.length === 1 ? 'already' : 'not_found';
}

export interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  totalK: number;
  invoiceId: string | null;
  placedAt: Date;
  lines: { name: string; quantity: number; unitPriceK: number; lineTotalK: number }[];
}

/** One order and its lines, for the register and for the tests. */
export async function orderByNumber(
  tx: TenantDb,
  businessId: string,
  orderNumber: string,
): Promise<OrderRow | null> {
  const rows = await tx
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalK: orders.totalK,
      invoiceId: orders.invoiceId,
      placedAt: orders.createdAt,
    })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), eq(orders.orderNumber, orderNumber)))
    .limit(1);
  const order = rows[0];
  if (!order) return null;

  const lines = await tx
    .select({
      name: orderItems.name,
      quantity: orderItems.quantity,
      unitPriceK: orderItems.unitPriceK,
      lineTotalK: orderItems.lineTotalK,
    })
    .from(orderItems)
    .where(and(eq(orderItems.businessId, businessId), eq(orderItems.orderId, order.id)))
    .orderBy(orderItems.name);

  return {
    ...order,
    totalK: Number(order.totalK),
    lines: lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unitPriceK: Number(line.unitPriceK),
      lineTotalK: Number(line.lineTotalK),
    })),
  };
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: string;
  totalK: number;
  /** The invoice it became, by NUMBER, or null while it is still a request. */
  invoiceNumber: string | null;
  placedAt: Date;
  itemCount: number;
}

/** Every order this shop has taken, newest first. */
/**
 * The orders list, and how many there are.
 *
 * `count` is over the whole table. The invoice register beside this one has
 * said "showing the latest N" since it was built; this list did not, so a
 * merchant with more orders than the page carries was shown a page and given
 * no reason to think there was more.
 */
export interface Orders {
  rows: OrderSummary[];
  count: number;
}

export async function ordersFor(tx: TenantDb, businessId: string, limit = 100): Promise<Orders> {
  const rows = await tx.execute<{
    id: string;
    order_number: string;
    status: string;
    total_k: string;
    invoice_number: string | null;
    placed_at: Date;
    item_count: number;
    n: number;
  }>(sql`
    SELECT o.id, o.order_number, o.status, o.total_k::bigint AS total_k,
           inv.invoice_number, o.created_at AS placed_at,
           count(i.id)::int AS item_count,
           count(*) OVER ()::int AS n
    FROM orders o
    LEFT JOIN order_items i ON i.order_id = o.id AND i.business_id = o.business_id
    LEFT JOIN invoices inv ON inv.id = o.invoice_id AND inv.business_id = o.business_id
    WHERE o.business_id = ${businessId}::uuid
      AND o.order_number NOT LIKE 'QUO-%'
      AND o.order_number NOT LIKE 'PO-%'
    GROUP BY o.id, o.order_number, o.status, o.total_k, inv.invoice_number, o.created_at
    ORDER BY o.created_at DESC
    LIMIT ${limit}
  `);

  const list = [...rows];
  return {
    count: list[0]?.n ?? 0,
    rows: list.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      status: r.status,
      totalK: Number(r.total_k),
      invoiceNumber: r.invoice_number,
      placedAt: new Date(r.placed_at),
      itemCount: r.item_count,
    })),
  };
}

/**
 * The order a storefront clientRef placed (fix-plan 6, M5c). The checkout
 * holds no id, only the one-shot key it minted; the unique external-ref
 * index makes this an exact lookup, and the tenant pin keeps a guessed key
 * inside the shop it was guessed against.
 */
export async function orderByExternalRef(
  tx: TenantDb,
  businessId: string,
  externalRef: string,
): Promise<{
  id: string;
  orderNumber: string;
  status: string;
  totalK: number;
  invoiceId: string | null;
  customerId: string | null;
} | null> {
  const rows = await tx
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalK: orders.totalK,
      invoiceId: orders.invoiceId,
      customerId: orders.customerId,
    })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), eq(orders.externalRef, externalRef)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * How many storefront orders this business took in the trailing window
 * (fix-plan 7, H7b). The hourly flood ceiling counts here, in the database,
 * so however many API replicas are running they share one number — the
 * in-memory per-IP limiter cannot promise that.
 */
export async function countRecentStorefrontOrders(
  tx: TenantDb,
  businessId: string,
  windowMs: number,
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM orders
    WHERE business_id = ${businessId}::uuid
      AND source_type = 'storefront'
      AND created_at > now() - make_interval(secs => ${windowMs / 1000})
  `);
  return [...rows][0]?.n ?? 0;
}

/**
 * One quote and its lines, by id, for the renderer. Quotes carry no
 * snapshot: the order row and its items are immutable once created (there
 * is no edit path), so the rows themselves are the record a re-render
 * reads.
 */
export async function quoteForRender(
  tx: TenantDb,
  businessId: string,
  quoteId: string,
): Promise<{
  quoteNumber: string;
  totalK: number;
  validUntil: string | null;
  createdAt: Date;
  lines: { name: string; quantity: number; unitPriceK: number }[];
} | null> {
  const head = await tx
    .select({
      quoteNumber: orders.orderNumber,
      totalK: orders.totalK,
      validUntil: orders.validUntil,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), eq(orders.id, quoteId)))
    .limit(1);
  const quote = head[0];
  if (!quote || !quote.quoteNumber.startsWith('QUO-')) return null;

  const lines = await tx
    .select({
      name: orderItems.name,
      quantity: orderItems.quantity,
      unitPriceK: orderItems.unitPriceK,
    })
    .from(orderItems)
    .where(and(eq(orderItems.businessId, businessId), eq(orderItems.orderId, quoteId)));

  return {
    quoteNumber: quote.quoteNumber,
    totalK: Number(quote.totalK),
    validUntil: quote.validUntil,
    createdAt: quote.createdAt,
    lines: lines.map((line) => ({
      name: line.name,
      quantity: Number(line.quantity),
      unitPriceK: line.unitPriceK,
    })),
  };
}
