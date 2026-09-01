/**
 * Merchant webhooks — spec §26/§27, migration 0111.
 *
 * The subscription and its delivery log. What a delivery CONTAINS is a v1
 * public contract in `packages/contracts`, versioned independently of these
 * columns, so a schema change cannot reshape somebody's integration.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
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
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** What the merchant registered, and which facts it wants. */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    url: text('url').notNull(),
    description: text('description'),
    /** Empty means every type. See `wantsEvent` in core. */
    eventTypes: text('event_types').array().notNull(),
    status: text('status').notNull().default('active'), // active | disabled
    /** AES-256-GCM under the vault key. Recoverable, because signing needs it. */
    encryptedSecret: text('encrypted_secret').notNull(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('webhook_endpoints_business_ix').on(t.businessId, t.createdAt),
    uniqueIndex('webhook_endpoints_business_url_ux').on(t.businessId, t.url),
  ],
);

/** One row per (endpoint, event). The fan-out's idempotency spine. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id),
    /* The fact this delivery announces. A real foreign key in migration
     * 0111; `outbox_events` has no drizzle table (its repo is raw SQL), so
     * the reference is the database's rather than this file's. */
    outboxEventId: uuid('outbox_event_id').notNull(),
    eventType: text('event_type').notNull(),
    /** The body as it will be sent, frozen at fan-out. */
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('pending'), // pending | delivered | dead
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(6),
    /** Truncated to milliseconds (0139): this column is read by a query that
     * compares it against a JavaScript Date, which cannot express anything
     * finer, so a microsecond remainder would hide a freshly queued row for
     * the rest of its millisecond. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .default(sql`date_trunc('milliseconds', now())`),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_event_endpoint_ux').on(t.endpointId, t.outboxEventId),
    index('webhook_deliveries_business_ix').on(t.businessId, t.createdAt),
  ],
);
