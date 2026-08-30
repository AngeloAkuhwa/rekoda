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
    /** Appendix F: MERCHANT | CUSTOMER | LEGACY_THREAD. NOT NULL since
     * 0087 — every thread is classified at birth, none may dodge F.2. */
    conversationKind: text('conversation_kind').notNull(),
    /** WHICH merchant channel asset (phoneNumberId / WABA). Never who is
     * writing — F.5 keeps those identities apart. */
    channelAccountId: text('channel_account_id'),
    /** ADVISORY only (F.7): never the routing key, never unique. */
    externalConversationId: text('external_conversation_id'),
    /** Business- and channel-scoped keyed lookup token. NEVER raw. */
    participantBlindIndex: text('participant_blind_index'),
    participantIndexKeyVersion: text('participant_index_key_version'),
    /** Resolved through the privacy gateway. */
    customerId: uuid('customer_id'),
    status: text('status').notNull().default('open'),
    createdAt: createdAt(),
  },
  /* F.2's two identities, two constraints (migration 0087, which replaced
   * 0006's broad one-thread-per-channel unique): exactly one MERCHANT
   * thread per business per channel, and one CUSTOMER thread per
   * (business, channel, asset, blind index, key version). The NULL
   * exclusion on the customer unique is explicit — a customer row without
   * an identity is already unrepresentable via the CHECK in 0087, but the
   * index predicate says so on its own rather than leaning on it. */
  (t) => [
    uniqueIndex('conversations_merchant_ux')
      .on(t.businessId, t.channel)
      .where(sql`conversation_kind = 'MERCHANT'`),
    uniqueIndex('conversations_customer_ux')
      .on(
        t.businessId,
        t.channel,
        t.channelAccountId,
        t.participantBlindIndex,
        t.participantIndexKeyVersion,
      )
      .where(sql`conversation_kind = 'CUSTOMER' AND participant_blind_index IS NOT NULL`),
  ],
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
    /** When an operator worked this exception. Null while it is still open. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    /** What they decided. Never overwrites `error`, which is why it was flagged. */
    resolution: text('resolution'),
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

/**
 * Objects promised to the bin but not yet taken there (PR-136).
 *
 * The database holds the KEY and R2 holds the bytes, so deleting a row has
 * never deleted a file. This is the queue that closes that gap: a row is
 * written in the SAME transaction that orphans the object, and DELETED once
 * the object is actually gone. Nothing is marked done, so the table answers
 * one question and an empty table is the healthy state.
 *
 * Deliberately outside the tenant boundary, like `retention_deletions`: the
 * row has to outlive the business whose object it names, and it holds
 * nothing worth isolating - an opaque key and a business id, no names, no
 * numbers, no content. See migration 0122.
 */
export const pendingObjectDeletions = pgTable(
  'pending_object_deletions',
  {
    id: id(),
    /** Not a reference: the business is usually gone by the time this runs. */
    businessId: uuid('business_id'),
    storageKey: text('storage_key').notNull(),
    reason: text('reason').notNull(), // business_deleted | evidence_purged
    attempts: integer('attempts').notNull().default(0),
    /** The provider's last refusal, for an operator reading a stuck queue. */
    lastError: text('last_error'),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pending_object_deletions_key_ux').on(t.storageKey),
    index('pending_object_deletions_due_ix').on(t.nextAttemptAt),
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
    /**
     * What was bought. Outbound messages carry their Meta CATEGORY here
     * (SERVICE_MESSAGE, UTILITY_TEMPLATE, AUTH_TEMPLATE, AUTH_INTL_TEMPLATE,
     * MARKETING_TEMPLATE) rather than a single `message_out`, because spec
     * §24 separates them: utility and marketing differ by roughly eightfold
     * and one bucket hides the largest variable in plan margin. Everything
     * else keeps its own word: llm_call | stt_seconds | pdf | excel …
     */
    usageType: text('usage_type').notNull(),
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
 * Per-business daily document-extraction reservations (AI hardening item 4).
 *
 * The OPERATIONAL brake on vision spend, distinct from the monthly
 * `documents_understood` allowance the merchant bought: that one meters the
 * product, this one bounds what a single day can cost before somebody looks.
 * Same mechanism as `aiQuotaCounters` for the same reason — the limit lives
 * in the statement's WHERE clause, never in a read-then-decide.
 */
export const docExtractionCounters = pgTable(
  'doc_extraction_counters',
  {
    businessId: businessId(),
    day: date('day').notNull(),
    extractions: integer('extractions').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.businessId, t.day] })],
);

/** The platform's vision day (A4). One integer per day; no RLS on purpose. */
export const docExtractionGlobalCounters = pgTable('doc_extraction_global_counters', {
  day: date('day').primaryKey(),
  extractions: integer('extractions').notNull().default(0),
});

/**
 * Per-business daily transcription SECONDS (A4). Operational, not the
 * monthly voice allowance: this is the brake on a runaway day.
 */
export const voiceSecondCounters = pgTable(
  'voice_second_counters',
  {
    businessId: businessId(),
    day: date('day').notNull(),
    seconds: integer('seconds').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.businessId, t.day] })],
);

/** The platform's transcription day (A4). */
export const voiceGlobalCounters = pgTable('voice_global_counters', {
  day: date('day').primaryKey(),
  seconds: integer('seconds').notNull().default(0),
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
    /**
     * A proposal to join two customer records, waiting for the merchant's
     * `yes` (migration 0023). Null on almost every draft.
     */
    identityLink: jsonb('identity_link'),
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

/**
 * Who we have already told "you do not have an account yet".
 *
 * Keyed by the HMAC of the phone under MATCH_KEY, never the number: this
 * table needs to know that a person was answered, not who they are. Outside
 * row-level security, like `external_events`, because someone with no
 * business has no tenant to scope them to.
 */
export const strangerContacts = pgTable('stranger_contacts', {
  matchKey: text('match_key').primaryKey(),
  lastRepliedAt: timestamp('last_replied_at', { withTimezone: true }).notNull().defaultNow(),
});
