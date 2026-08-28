/**
 * The WABA connection model (spec §24; migration 0084, PR-058): the
 * merchant's own WABA, connected by them, routed by us. The
 * `phoneNumberId` is globally unique — one number, one business — and an
 * unknown one is refused, never guessed. Billing mode carries every §24
 * value plus UNCONFIRMED, so W0's confirmation is a data change, never a
 * code branch.
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

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);

export const wabaConnections = pgTable(
  'waba_connections',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    wabaId: text('waba_id').notNull(),
    phoneNumberId: text('phone_number_id').notNull(),
    displayPhone: text('display_phone'),
    status: text('status').notNull().default('PENDING_SIGNUP'),
    billingMode: text('billing_mode').notNull().default('UNCONFIRMED'),
    /** W0's confirmation is an auditable act (0089): WHEN and BY WHOM
     * travel with the mode, and a CHECK makes a bare UPDATE unrepresentable. */
    billingModeConfirmedAt: timestamp('billing_mode_confirmed_at', { withTimezone: true }),
    billingModeConfirmedBy: text('billing_mode_confirmed_by'),
    /** WHY the connection is UNHEALTHY (0089) — never a bare adjective. */
    healthReason: text('health_reason'),
    /** The Meta commerce catalog this WABA presents (0103, PR-086). Null
     * until the merchant links one; sync refuses honestly without it. */
    catalogueId: text('catalogue_id'),
    accessTokenCipher: text('access_token_cipher'),
    tokenTail: text('token_tail'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastHealthyAt: timestamp('last_healthy_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('waba_connections_phone_number_ux').on(t.phoneNumberId),
    index('waba_connections_business_ix').on(t.businessId),
  ],
);

export const wabaTemplates = pgTable(
  'waba_templates',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    wabaConnectionId: uuid('waba_connection_id').notNull(),
    name: text('name').notNull(),
    language: text('language').notNull().default('en'),
    /** §4.2 metering category, chosen at SEND time. */
    category: text('category').notNull(),
    status: text('status').notNull().default('PENDING'),
    providerTemplateId: text('provider_template_id'),
    /** Meta's stated reason for a rejection or pause (0088). Advisory prose
     * for the merchant's next edit — never parsed, never a routing input. */
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('waba_templates_name_ux').on(t.businessId, t.wabaConnectionId, t.name, t.language),
  ],
);

/**
 * What Meta's commerce catalog currently holds, item by item (0103,
 * PR-086): the projection's own record, so the sync can DIFF the products
 * table against it instead of re-sending the world. A product that
 * disagrees with its synced row is dirty by comparison — no flag stored.
 */
export const wabaCatalogueItems = pgTable(
  'waba_catalogue_items',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    wabaConnectionId: uuid('waba_connection_id')
      .notNull()
      .references(() => wabaConnections.id),
    productId: uuid('product_id').notNull(),
    /** The identity Meta knows the item by: our product id, stable. */
    retailerId: text('retailer_id').notNull(),
    syncedName: text('synced_name').notNull(),
    syncedPriceK: bigint('synced_price_k', { mode: 'number' }).notNull(),
    syncedAvailability: text('synced_availability').notNull(), // in stock | out of stock
    status: text('status').notNull(), // SYNCED | FAILED
    /** Meta's stated reason for a refusal. Advisory prose for the
     * merchant's next edit — never parsed, never a routing input. */
    error: text('error'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('waba_catalogue_items_ux').on(t.businessId, t.wabaConnectionId, t.productId)],
);

export const wabaServiceWindows = pgTable(
  'waba_service_windows',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    wabaConnectionId: uuid('waba_connection_id').notNull(),
    /** Hashed customer identity. Raw numbers never land here. */
    customerHash: text('customer_hash').notNull(),
    windowExpiresAt: timestamp('window_expires_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('waba_windows_customer_ux').on(t.businessId, t.wabaConnectionId, t.customerHash),
  ],
);

/**
 * The away assistant's configured limits (spec Appendix D; W4, PR-090).
 * OFF by default; the daily ceiling is per customer per Lagos day, and 0
 * means zero replies, never unlimited.
 */
export const awayAssistantSettings = pgTable(
  'away_assistant_settings',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    enabled: integer('enabled').notNull().default(0),
    dailyReplyLimit: integer('daily_reply_limit').notNull().default(5),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('away_assistant_settings_ux').on(t.businessId)],
);

/** The meter the ceiling is enforced against: one row per customer per day. */
export const awayAssistantReplies = pgTable(
  'away_assistant_replies',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    /** The blind index the thread routes by, never a raw number (F.3/F.4). */
    customerHash: text('customer_hash').notNull(),
    day: text('day').notNull(),
    replies: integer('replies').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('away_assistant_replies_ux').on(t.businessId, t.customerHash, t.day)],
);
