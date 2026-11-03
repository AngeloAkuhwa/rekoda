/**
 * Customer payment reminders (migration 0184, N1, OWN-43, OWN-62).
 *
 * Tenant-owned and RLS-protected; the composite foreign keys to invoices and customers live in the
 * migration, so another business's invoice or customer is unrepresentable.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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

export const invoiceReminderStops = pgTable('invoice_reminder_stops', {
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  invoiceId: uuid('invoice_id').notNull(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }).notNull().defaultNow(),
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

/** REM-05 (migration 0189): a confirmed list of invoices to remind, now or at a chosen time. */
export const reminderBatches = pgTable('reminder_batches', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  channels: text('channels').notNull(),
  attest: boolean('attest').notNull().default(false),
  state: text('state').notNull().default('scheduled'),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  itemCount: integer('item_count').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  cancelledBy: uuid('cancelled_by'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  pausedUntil: timestamp('paused_until', { withTimezone: true }),
});

/** One invoice in a batch, once. Its outcome is the reminder row keyed `batch:<batch>:<item>`. */
export const reminderBatchItems = pgTable('reminder_batch_items', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  batchId: uuid('batch_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  position: integer('position').notNull(),
  state: text('state').notNull().default('pending'),
  reasonCode: text('reason_code'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});
