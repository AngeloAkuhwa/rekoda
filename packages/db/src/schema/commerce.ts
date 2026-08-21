/**
 * Commerce entities — products, inventory, orders, suppliers (spec §39).
 * All money columns are BIGINT KOBO. Naira never touches the database.
 */
import { sql } from 'drizzle-orm';
import {
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
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(), // sale | purchase | adjustment | reservation | release
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('inv_moves_product_ix').on(t.productId),
    index('inv_moves_business_ix').on(t.businessId),
  ],
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: id(),
    businessId: businessId(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('suppliers_business_ix').on(t.businessId)],
);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    businessId: businessId(),
    customerId: uuid('customer_id').references(() => customers.id),
    orderNumber: text('order_number').notNull(),
    status: text('status').notNull().default('placed'), // placed | confirmed | paid | cancelled
    totalK: kobo('total_k').notNull(),
    currency: text('currency').notNull().default('NGN'),
    /** WhatsApp order reference (Integrate) for idempotent capture. */
    externalRef: text('external_ref'),
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
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    productId: uuid('product_id').references(() => products.id),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceK: kobo('unit_price_k').notNull(),
    lineTotalK: kobo('line_total_k').notNull(),
  },
  (t) => [index('order_items_order_ix').on(t.orderId)],
);
