/**
 * Customer payment reminders (migration 0184, N1, OWN-43, OWN-62).
 *
 * Tenant-owned and RLS-protected; the composite foreign keys to invoices and customers live in the
 * migration, so another business's invoice or customer is unrepresentable.
 */
import { sql } from 'drizzle-orm';
import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';

export const reminderAttestations = pgTable('reminder_attestations', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  customerId: uuid('customer_id').notNull(),
  channel: text('channel').notNull(),
  purpose: text('purpose').notNull().default('debt_reminder'),
  addressHash: text('address_hash').notNull(),
  policyVersion: text('policy_version').notNull(),
  attestedByUserId: uuid('attested_by_user_id').notNull(),
  attestedAt: timestamp('attested_at', { withTimezone: true }).notNull().defaultNow(),
});

export const customerEmailOptouts = pgTable('customer_email_optouts', {
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  addressHash: text('address_hash').notNull(),
  optedOutAt: timestamp('opted_out_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invoiceReminders = pgTable('invoice_reminders', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  invoiceId: uuid('invoice_id').notNull(),
  customerId: uuid('customer_id'),
  channel: text('channel').notNull(),
  status: text('status').notNull(),
  reasonCode: text('reason_code'),
  idempotencyKey: text('idempotency_key').notNull(),
  balanceK: bigint('balance_k', { mode: 'number' }),
  attestationId: uuid('attestation_id'),
  requestedBy: uuid('requested_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
});
