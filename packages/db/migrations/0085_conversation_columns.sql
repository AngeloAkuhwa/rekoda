-- Conversation: channel-neutral columns, ADDITIVE (Appendix F; W1/W2,
-- PR-058a-1 — step one of five).
--
-- The repository's `conversations_business_channel_ux` ("one thread per
-- business per channel") is correct for merchant ↔ Rekoda Chat and
-- CANNOT represent a merchant WABA carrying fifty thousand customers.
-- This is the same shape of migration the plan refuses to do in one go:
-- columns now (nullable, no behaviour change), backfill next (058a-2,
-- `conversationKind = MERCHANT` and STOP — F.6: do not fabricate a
-- customer participant for a legacy merchant-only thread), readers and
-- writers onto the resolver behind a flag (058a-3), and only then the
-- broad unique replaced by F.2's two partial constraints (058a-4).
--
-- F.7: `external_conversation_id` is ADVISORY — recorded for correlation
-- and provider debugging, never the routing key, never part of a
-- uniqueness constraint. Meta's conversation ids serve Meta's billing
-- windows, and a billing window is not a relationship.

ALTER TABLE conversations
  ADD COLUMN conversation_kind text
    CONSTRAINT conversations_kind_enum CHECK (conversation_kind IS NULL OR
      conversation_kind IN ('MERCHANT', 'CUSTOMER', 'LEGACY_THREAD')),
  ADD COLUMN channel_account_id text,
  ADD COLUMN external_conversation_id text,
  ADD COLUMN participant_blind_index text,
  ADD COLUMN participant_index_key_version text,
  ADD COLUMN customer_id uuid,
  ADD COLUMN status text NOT NULL DEFAULT 'open'
    CONSTRAINT conversations_status_enum CHECK (status IN ('open', 'closed'));

/* F.2's NULL caveat, inverted into coherence: a blind index without its
 * key version is a value nobody can ever rotate, and a version without a
 * value is noise. Together or not at all. */
ALTER TABLE conversations
  ADD CONSTRAINT conversations_blind_index_pair
    CHECK ((participant_blind_index IS NULL) = (participant_index_key_version IS NULL));

/* The customer, resolved through the privacy gateway — tenant-safe. */
ALTER TABLE conversations
  ADD CONSTRAINT conversations_customer_fk
    FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id);
