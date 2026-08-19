/**
 * Operational tables — conversations, external events, documents, audit,
 * counters, and the cost telemetry the commercial model depends on
 * (pricing-model.md §"Cost telemetry is a build item").
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const businessId = () =>
  uuid('business_id')
    .notNull()
    .references(() => businesses.id);

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    businessId: businessId(),
    channel: text('channel').notNull(), // meta | twilio | simulator
    createdAt: createdAt(),
  },
  (t) => [index('conversations_business_ix').on(t.businessId)],
);

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: id(),
    businessId: businessId(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    direction: text('direction').notNull(), // inbound | outbound
    kind: text('kind').notNull(), // text | voice | media | interactive
    /** Tokenised content — raw PII is vaulted before this row is written. */
    body: text('body'),
    /** Provider message id — the idempotency key for inbound delivery. */
    providerMessageId: text('provider_message_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('messages_provider_ux').on(t.providerMessageId),
    index('messages_conversation_ix').on(t.conversationId),
  ],
);

/**
 * Raw external event store (spec §41 traceability). Payloads are retained
 * for replay/debugging with PII-bearing fields redacted at write time.
 * Idempotency: (provider, external id) is unique — a webhook retry is a
 * no-op by construction.
 */
export const externalEvents = pgTable(
  'external_events',
  {
    id: id(),
    businessId: uuid('business_id').references(() => businesses.id),
    provider: text('provider').notNull(), // meta | twilio | paystack
    eventType: text('event_type').notNull(),
    externalId: text('external_id').notNull(),
    payload: jsonb('payload').notNull(),
    signatureValid: integer('signature_valid').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('external_events_ux').on(t.provider, t.externalId),
    index('external_events_business_ix').on(t.businessId),
  ],
);

/** Generated artefacts (PDF/Excel) with storage refs, never blobs in the DB. */
export const documents = pgTable(
  'documents',
  {
    id: id(),
    businessId: businessId(),
    kind: text('kind').notNull(), // invoice_pdf | receipt_pdf | snapshot_pdf | excel_export | records_csv
    /** Unguessable object key in R2. Public URL derives from this. */
    storageKey: text('storage_key').notNull(),
    refNumber: text('ref_number'),
    bytes: integer('bytes'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('documents_storage_ux').on(t.storageKey),
    index('documents_business_ix').on(t.businessId),
  ],
);

/** Sequential numbering counters — bumped inside the issuing transaction. */
export const docCounters = pgTable(
  'doc_counters',
  {
    businessId: businessId(),
    docType: text('doc_type').notNull(), // invoice | receipt | credit_note | order
    year: integer('year').notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.businessId, t.docType, t.year] })],
);

/** Append-only audit trail — spec §42. No UPDATE, no DELETE, ever. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    businessId: businessId(),
    actor: text('actor').notNull(), // user id | 'system' | 'webhook:paystack' …
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    action: text('action').notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    reason: text('reason'),
    sourceType: text('source_type').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_business_ix').on(t.businessId, t.createdAt)],
);

/**
 * Per-business cost telemetry — every external unit consumed, priced.
 * This is what turns pricing assumptions into knowledge six weeks after
 * launch, and powers the admin margin view (M4).
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: id(),
    businessId: businessId(),
    provider: text('provider').notNull(), // meta | twilio | anthropic | stt | storage | paystack
    usageType: text('usage_type').notNull(), // message_in | message_out | template | llm_call | stt_seconds | pdf | excel …
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
    /** Provider cost in micro-units of `costCurrency` (USD micros for AI). */
    providerCostMicros: bigint('provider_cost_micros', { mode: 'number' }).notNull().default(0),
    costCurrency: text('cost_currency').notNull().default('USD'),
    /** Naira-equivalent in kobo at the planning FX captured at write time. */
    nairaEquivalentK: bigint('naira_equivalent_k', { mode: 'number' }).notNull().default(0),
    billingPeriod: text('billing_period').notNull(), // YYYY-MM
    meta: jsonb('meta'),
    createdAt: createdAt(),
  },
  (t) => [
    index('usage_business_period_ix').on(t.businessId, t.billingPeriod),
    index('usage_provider_ix').on(t.provider, t.billingPeriod),
  ],
);
