/**
 * Privacy Gateway storage — spec §5–8, ADR 0005.
 *
 * The vault is Zone 1: the ONLY place customer identity exists in readable
 * relation to a customer row, and even here it is ciphertext. Everything
 * else in the system speaks CustomerId / CUSTOMER_XXX tokens.
 */
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Zone 2 customer row — carries NO identity. */
export const customers = pgTable(
  'customers',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    /** The pseudonym shown to AI: CUSTOMER_X81. Unique per business. */
    token: text('token').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('customers_business_token_ux').on(t.businessId, t.token),
    index('customers_business_ix').on(t.businessId),
  ],
);

/**
 * Zone 1: the encrypted identity vault. One row per identity facet so a
 * facet can be individually erased. `ciphertext` is AES-256-GCM under the
 * vault key; `matchKey` is a keyed HMAC of the normalised value used ONLY
 * for deterministic known-customer matching (never reversible, never a
 * plain hash of a guessable value like a phone number alone).
 */
export const customerIdentities = pgTable(
  'customer_identities',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    facet: text('facet').notNull(), // name | phone | email | address
    ciphertext: text('ciphertext').notNull(),
    matchKey: text('match_key'),
    createdAt: createdAt(),
  },
  (t) => [
    index('identities_customer_ix').on(t.customerId),
    // UNIQUE, and partial (match_key IS NOT NULL) — see migration 0005. One
    // person is one customer even when two messages arrive together.
    uniqueIndex('identities_match_ux')
      .on(t.businessId, t.facet, t.matchKey)
      .where(sql`${t.matchKey} IS NOT NULL`),
  ],
);
