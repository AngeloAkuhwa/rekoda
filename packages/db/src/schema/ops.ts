/**
 * Operational tables — conversations, external events, documents, audit,
 * counters, and the cost telemetry the commercial model depends on
 * (pricing-model.md §"Cost telemetry is a build item").
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
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
  // One thread per business per channel — see migration 0006.
  (t) => [uniqueIndex('conversations_business_channel_ux').on(t.businessId, t.channel)],
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
 * External event store (spec §41 traceability).
 *
 * Payloads are SEALED at write time — AES-256-GCM under `VAULT_KEY`, see
 * `apps/api/src/privacy/payload-vault.ts`. This is the one table with
 * row-level security deliberately switched off, because an event arrives
 * before anyone knows which tenant it belongs to, so a provider body stored
 * verbatim would put the merchant's message and the sender's number in
 * plaintext in the least protected table in the schema.
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
    provider: text('provider').notNull(), // meta | twilio | anthropic | openai | stt | storage | paystack
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

/**
 * Background work, queued in the same database as the work it describes
 * (ADR 0022).
 *
 * `business_id` is `NOT NULL`: there is no such thing as a job with
 * no tenant, and the column is what the row-level security policy keys on. A
 * worker that forgets to pin sees an empty queue rather than everybody's.
 *
 * `payload` holds **references, never content** — an event id, a document id.
 * The queue is the one table a worker reads across tenants, so anything put in
 * here is readable by every worker; message text belongs in the vault.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    businessId: businessId(),
    kind: text('kind').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * At most one un-finished job per (business, kind, key). Used to make
     * "render the PDF for this document" idempotent at enqueue time rather
     * than hoping the handler is.
     */
    singletonKey: text('singleton_key'),
    /** pending | running | done | dead */
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('jobs_business_state_ix').on(t.businessId, t.state)],
);

/**
 * Per-business daily AI-call reservations (MASTER-PLAN §5.3.3).
 *
 * A counter rather than a count over `usage_events`, because a ceiling decided
 * by reading and then acting is not a ceiling — see repos/quota.ts.
 */
export const aiQuotaCounters = pgTable(
  'ai_quota_counters',
  {
    businessId: businessId(),
    day: date('day').notNull(),
    calls: integer('calls').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.businessId, t.day] })],
);

/**
 * The platform-wide daily ceiling. One integer per day, no tenant data, and
 * therefore no row-level security: it answers "what is the most this product
 * can cost tomorrow if something goes wrong", which no single tenant's row can.
 */
export const aiGlobalCounters = pgTable('ai_global_counters', {
  day: date('day').primaryKey(),
  calls: integer('calls').notNull().default(0),
});

/**
 * The model's interpretation of one message, before anybody agrees to it
 * (CG2, CG5). A draft is not a document: no number, no ledger entry, nothing
 * a customer can be shown. `command` holds tokenised content only.
 */
export const commandDrafts = pgTable(
  'command_drafts',
  {
    id: id(),
    businessId: businessId(),
    conversationMessageId: uuid('conversation_message_id')
      .notNull()
      .references(() => conversationMessages.id),
    intent: text('intent').notNull(),
    command: jsonb('command').notNull(),
    model: text('model'),
    /** pending | superseded | confirmed | abandoned */
    state: text('state').notNull().default('pending'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One draft per message — a job that runs twice must not give the merchant
    // two previews of one sale.
    uniqueIndex('command_drafts_message_ux').on(t.conversationMessageId),
    index('command_drafts_business_state_ix').on(t.businessId, t.state),
  ],
);
