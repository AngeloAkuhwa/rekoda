-- Conversation: the broad unique replaced, customer threads enabled
-- (Appendix F.2; W1/W2, PR-058a-4 — step four, the one the first three
-- existed to make safe).
--
-- "One thread per business per channel" was correct for merchant ↔ Rekoda
-- Chat and CANNOT represent a merchant WABA carrying fifty thousand
-- customers. It is replaced by F.2's two constraints — both PARTIAL and
-- both explicitly excluding the NULL case, because PostgreSQL treats
-- NULLs as distinct in a unique index and a constraint that quietly
-- stops applying is worse than no constraint.

/* The estate must be fully classified before the kind becomes load-
 * bearing. 0086's gate proved it; proved again here because this
 * migration is the one that RELIES on it. */
DO $$
DECLARE unclassified bigint;
BEGIN
  SELECT count(*) INTO unclassified FROM conversations WHERE conversation_kind IS NULL;
  IF unclassified > 0 THEN
    RAISE EXCEPTION 'cannot replace the unique: % threads unclassified', unclassified;
  END IF;
END;
$$;

ALTER TABLE conversations ALTER COLUMN conversation_kind SET NOT NULL;

/* A CUSTOMER thread without its identity would slip past the partial
 * unique (NULLs are distinct) and permit unlimited duplicates. Make the
 * shape unrepresentable instead: a customer thread carries WHICH asset
 * and WHO is writing, always. */
ALTER TABLE conversations
  ADD CONSTRAINT conversations_customer_identity CHECK (
    conversation_kind <> 'CUSTOMER'
    OR (channel_account_id IS NOT NULL AND participant_blind_index IS NOT NULL)
  );

DROP INDEX conversations_business_channel_ux;

/* MERCHANT: the correct part of the old rule, kept — exactly one per
 * business per channel. */
CREATE UNIQUE INDEX conversations_merchant_ux
  ON conversations (business_id, channel)
  WHERE conversation_kind = 'MERCHANT';

/* CUSTOMER: F.2's routing key, verbatim. */
CREATE UNIQUE INDEX conversations_customer_ux
  ON conversations (business_id, channel, channel_account_id,
                    participant_blind_index, participant_index_key_version)
  WHERE conversation_kind = 'CUSTOMER' AND participant_blind_index IS NOT NULL;

/* The customer-thread lookups the resolver runs. */
CREATE INDEX conversations_customer_lookup_ix
  ON conversations (business_id, channel_account_id)
  WHERE conversation_kind = 'CUSTOMER';
