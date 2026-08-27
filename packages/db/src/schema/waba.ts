/**
 * The WABA connection model (spec §24; migration 0084, PR-058): the
 * merchant's own WABA, connected by them, routed by us. The
 * `phoneNumberId` is globally unique — one number, one business — and an
 * unknown one is refused, never guessed. Billing mode carries every §24
 * value plus UNCONFIRMED, so W0's confirmation is a data change, never a
 * code branch.
 */
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
