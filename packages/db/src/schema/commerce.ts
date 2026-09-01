/**
 * Commerce entities — products, inventory, orders, suppliers (spec §39).
 * All money columns are BIGINT KOBO. Naira never touches the database.
 */
import { sql } from 'drizzle-orm';
import {
  date,
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';
import { customers } from './privacy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const kobo = (name: string) => bigint(name, { mode: 'number' });
const businessId = () =>
  uuid('business_id')
    .notNull()
    .references(() => businesses.id);

export const products = pgTable(
  'products',
  {
    id: id(),
    businessId: businessId(),
    name: text('name').notNull(),
    unitPriceK: kobo('unit_price_k'),
    /**
     * What it cost, as a weighted average, or null.
     *
     * Maintained by deliveries rather than typed: a purchase that names a
     * product and a quantity moves this figure. The null is load-bearing.
     * A product nobody has told Rekoda the cost of has no cost, and a sale of
     * it posts none rather than inventing one.
     */
    unitCostK: kobo('unit_cost_k'),
    /** The merchant's own words about it. Never generated (migration 0028). */
    description: text('description'),
    /** Storage key of the photo, never the bytes. Same rule as `documents`. */
    imageKey: text('image_key'),
    /** Mapping to the merchant's WhatsApp catalogue item (Integrate). */
    externalCatalogueId: text('external_catalogue_id'),
    active: integer('active').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('products_business_ix').on(t.businessId),
    index('products_business_active_ix').on(t.businessId, t.active),
    uniqueIndex('products_catalogue_ux').on(t.businessId, t.externalCatalogueId),
  ],
);

/** Append-only stock ledger; on-hand = SUM(delta). Never UPDATE a count. */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: id(),
    businessId: businessId(),
    /** The composite FK to `products (business_id, id)` lives in migration
     * 0134; another tenant's product is unrepresentable. */
    productId: uuid('product_id').notNull(),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(), // sale | purchase | adjustment | reservation | release | return | supplier_return | opening
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    /** The unit cost APPLIED to this movement (Appendix B): the receipt
     * cost on the way in, the issue cost on the way out. Null on
     * historical rows that never recorded one — honest, not zero. */
    unitCostK: bigint('unit_cost_k', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('inv_moves_product_ix').on(t.productId),
    index('inv_moves_business_ix').on(t.businessId),
  ],
);

/**
 * GoodsReturn (spec §14.3; Appendix B.2a; migration 0101, PR-080).
 * Physical disposition decides the accounting: only RESALABLE re-enters
 * sellable stock, DAMAGED/QUARANTINED rows ARE the holding location, and
 * SCRAPPED is gone. Append-only.
 */
export const goodsReturns = pgTable(
  'goods_returns',
  {
    id: id(),
    businessId: businessId(),
    /** The composite FK to `products (business_id, id)` has been here since
     * this table was created, which is what made the single-column invoice
     * key beside it so obviously the odd one out. */
    productId: uuid('product_id').notNull(),
    /** The composite FK to `invoices (business_id, id)` lives in migration
     * 0134; another tenant's invoice is unrepresentable. */
    invoiceId: uuid('invoice_id'),
    quantity: integer('quantity').notNull(),
    disposition: text('disposition').notNull(),
    /** Per unit, from the outbound movement. Null: original issue was
     * never costed — an honest unknown, never a reconstruction. */
    originalIssueCostK: bigint('original_issue_cost_k', { mode: 'number' }),
    /** TOTAL supported value on a damaged/quarantined return. */
    salvageValueK: bigint('salvage_value_k', { mode: 'number' }),
    /** The composite FK to `ledger_transactions (business_id, id)` lives in
     * migration 0137; another tenant's posting is unrepresentable. */
    ledgerTransactionId: uuid('ledger_transaction_id'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    createdAt: createdAt(),
  },
  (t) => [index('goods_returns_business_ix').on(t.businessId, t.createdAt)],
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: id(),
    businessId: businessId(),
    /** The name as a vault blob (migration 0050). Only the authorised
     * boundary can open it; this package never sees a plaintext name. */
    nameCipher: text('name_cipher').notNull(),
    /** HMAC fold, so the same supplier said twice is one row without the
     * name ever being comparable at rest. */
    matchKey: text('match_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('suppliers_business_ix').on(t.businessId),
    uniqueIndex('suppliers_match_ux').on(t.businessId, t.matchKey),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    businessId: businessId(),
    /** The composite FK to `customers (business_id, id)` lives in migration
     * 0132; another tenant's customer is unrepresentable. */
    customerId: uuid('customer_id'),
    orderNumber: text('order_number').notNull(),
    /**
     * The invoice this order became, once the merchant agreed to it.
     *
     * Null while it is still only a request, which is every order until
     * somebody says yes (migration 0029). The composite FK to
     * `invoices (business_id, id)` lives in migration 0132; another tenant's
     * invoice is unrepresentable.
     */
    invoiceId: uuid('invoice_id'),
    /**
     * Three ways in and four ways on, closed by a CHECK in migration 0131:
     *
     *   placed     a customer order
     *   quoted     a quote the merchant has offered
     *   open       a purchase order to a supplier
     *   confirmed  the merchant said yes, and an invoice exists
     *   validated  a supplier delivery checked against its order
     *   received   goods arrived against a purchase order
     *   cancelled  from any of the three openings
     *
     * `paid` was named here for years and is written by nothing. Payment
     * lives on the invoice this order became, which is what `invoiceId` is
     * for; an order has no balance of its own to settle.
     */
    status: text('status').notNull().default('placed'),
    totalK: kobo('total_k').notNull(),
    currency: text('currency').notNull().default('NGN'),
    /** WhatsApp order reference (Integrate) for idempotent capture. */
    externalRef: text('external_ref'),
    /**
     * The Lagos day the paper carries, when it carries one. For a quote, the
     * last day the offer stands; for a purchase order, the day the goods are
     * expected. Null on plain orders and on either when nobody said.
     */
    validUntil: date('valid_until'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('orders_number_ux').on(t.businessId, t.orderNumber),
    uniqueIndex('orders_external_ux').on(t.businessId, t.externalRef),
    index('orders_business_ix').on(t.businessId),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    businessId: businessId(),
    /** The composite FK to `orders (business_id, id)` lives in migration
     * 0132; another tenant's order is unrepresentable. */
    orderId: uuid('order_id').notNull(),
    /** The composite FK to `products (business_id, id)` lives in migration
     * 0132; another tenant's product is unrepresentable. */
    productId: uuid('product_id'),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceK: kobo('unit_price_k').notNull(),
    lineTotalK: kobo('line_total_k').notNull(),
  },
  (t) => [index('order_items_order_ix').on(t.orderId)],
);

/**
 * The public face of a business (migration 0030).
 *
 * Its own table rather than columns on `businesses`, because a public page
 * has to turn a slug into a tenant and `businesses` is under strict row-level
 * security keyed on the pinned tenant. A policy letting anyone read a
 * published business would expose the whole row: the plan, the TIN, the
 * owner's user id, the date a card last failed. None of that is a shop.
 *
 * Everything here is published on purpose, which is why it is readable by
 * anyone and writable only under a tenant pin.
 */
export const shops = pgTable(
  'shops',
  {
    id: id(),
    businessId: businessId(),
    /** The handle in the URL. Globally unique, because a URL is. */
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    /** E.164, published deliberately. Copied, never joined from `users`. */
    whatsappE164: text('whatsapp_e164').notNull(),
    tagline: text('tagline'),
    /** Null until the merchant switches it on. Reserved is not live. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('shops_slug_ux').on(t.slug),
    uniqueIndex('shops_business_ux').on(t.businessId),
  ],
);
