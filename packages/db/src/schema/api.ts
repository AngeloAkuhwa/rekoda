/**
 * The public API's credentials — spec §27, migration 0110.
 *
 * These tables describe who may call the public API and how fast. What the
 * API exposes is a separate question answered in `packages/contracts`, which
 * is versioned independently of this schema precisely so the wire shape never
 * becomes a mirror of these columns.
 */
import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * A registered consumer of the API.
 *
 * `API_APPLICATIONS` is CAPACITY: what a business may hold at once, counted
 * from the active rows here rather than tallied in a monthly meter, so
 * disabling one frees the slot the same day (PR-116).
 */
export const apiApplications = pgTable(
  'api_applications',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'), // active | disabled
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('api_applications_business_name_ux').on(t.businessId, sql`lower(${t.name})`)],
);

/** A bearer credential for one application. Stored as SHA-256, never plaintext. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    /** The composite FK to `api_applications (business_id, id)` lives in
     * migration 0144; a key cannot be minted under another tenant's
     * application. */
    applicationId: uuid('application_id').notNull(),
    /** The public half: `rk_live_` plus eight hex characters. */
    prefix: text('prefix').notNull(),
    /** SHA-256 of the whole token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    label: text('label'),
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(120),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('api_keys_token_hash_ux').on(t.tokenHash),
    uniqueIndex('api_keys_prefix_ux').on(t.prefix),
    index('api_keys_application_ix').on(t.applicationId, t.createdAt),
    index('api_keys_business_ix').on(t.businessId, t.createdAt),
  ],
);

/** One row per key per minute. The limit lives in the WHERE clause. */
export const apiKeyRateWindows = pgTable('api_key_rate_windows', {
  /** The composite FK to `api_keys (business_id, id)` lives in migration 0144.
   * The window IS the ceiling, so one attached to another tenant's key would
   * spend that merchant's allowance. */
  apiKeyId: uuid('api_key_id').notNull(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  calls: integer('calls').notNull().default(0),
});
