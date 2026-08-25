-- R0A-i · Legacy payment provenance investigation.  READ ONLY.
--
-- Canonical corrections v1.3 §B1 forbids inventing historical trust: the old
-- `verified` boolean and the `method` column together prove nothing about who
-- said the money arrived. This report reconstructs provenance from EVIDENCE
-- and names what cannot be established, so remediation is a decision somebody
-- makes rather than a default the migration picks.
--
-- Nothing here writes. Run it against production before any R0A-ii migration:
--   psql "$DATABASE_URL" -f scripts/investigations/r0a-i-payment-provenance.sql
--
-- The ladder, in the order the CASE applies it:
--   provider intent + provider reference       -> PROVIDER_VERIFIED
--   reconciled against an imported bank line   -> BANK_FEED_MATCH
--   chat-confirmed FROM A PHOTOGRAPH           -> LEGACY_UNVERIFIED_FROM_IMAGE
--   merchant typed or spoke it, cash           -> MERCHANT_ATTESTED_CASH
--   merchant typed or spoke it, transfer/pos   -> MERCHANT_ATTESTED_TRANSFER
--   anything else                              -> LEGACY_PROVENANCE_UNKNOWN
\pset footer off

\echo '== 1. provenance distribution =='
WITH classified AS (
  SELECT
    p.id,
    p.business_id,
    p.amount_k,
    p.method,
    p.verified,
    p.source_type,
    p.created_at,
    m.kind AS origin_message_kind,
    CASE
      /* Both writers of verified = 1 (bookVerifiedPayment via the webhook
       * handler, and via the storefront transfer poll) perform a server-side
       * verify before booking, and both attach an intent and a provider ref.
       * That is established from the code trail, not assumed from the flag. */
      WHEN p.verified = 1
       AND p.payment_intent_id IS NOT NULL
       AND p.provider_ref IS NOT NULL          THEN 'PROVIDER_VERIFIED'
      /* verified = 1 without those anchors is exactly the case the correction
       * warned about: the flag alone proves nothing. */
      WHEN p.verified = 1                      THEN 'LEGACY_PROVENANCE_UNKNOWN'
      WHEN EXISTS (
        SELECT 1 FROM reconciliations r
         WHERE r.payment_id = p.id
           AND r.status = 'MATCHED'
      )                                        THEN 'BANK_FEED_MATCH'
      /* A draft whose originating conversation message was a photograph is a
       * payment booked from an image. Under the corrected model that should
       * have been PaymentEvidence and never a payment at all. */
      WHEN p.source_type = 'chat'
       AND m.kind = 'media'                    THEN 'LEGACY_UNVERIFIED_FROM_IMAGE'
      WHEN p.source_type = 'chat'
       AND m.kind IN ('text', 'voice')
       AND p.method = 'cash'                   THEN 'MERCHANT_ATTESTED_CASH'
      WHEN p.source_type = 'chat'
       AND m.kind IN ('text', 'voice')         THEN 'MERCHANT_ATTESTED_TRANSFER'
      /* Dashboard-entered payments are the merchant acting deliberately in
       * their own books; still an attestation, but with no message to inspect. */
      WHEN p.source_type = 'dashboard'
       AND p.method = 'cash'                   THEN 'MERCHANT_ATTESTED_CASH'
      WHEN p.source_type = 'dashboard'         THEN 'MERCHANT_ATTESTED_TRANSFER'
      ELSE                                          'LEGACY_PROVENANCE_UNKNOWN'
    END AS provenance
  FROM payments p
  LEFT JOIN command_drafts d          ON d.id::text = p.source_id
  LEFT JOIN conversation_messages m   ON m.id = d.conversation_message_id
),
enriched AS (
  SELECT c.*,
    EXISTS (SELECT 1 FROM receipts            r WHERE r.payment_id = c.id) AS has_receipt,
    EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = c.id) AS has_allocation
  FROM classified c
)

SELECT provenance,
       count(*)                               AS payments,
       count(*) FILTER (WHERE has_receipt)    AS with_receipt,
       count(*) FILTER (WHERE has_allocation) AS with_allocation,
       sum(amount_k) / 100.0                  AS naira_total
  FROM enriched
 GROUP BY provenance
 ORDER BY payments DESC;

\echo ''
\echo '== 2. REMEDIATION QUEUE: paper issued on payments no provider or feed ever confirmed =='
WITH classified AS (
  SELECT
    p.id,
    p.business_id,
    p.amount_k,
    p.method,
    p.verified,
    p.source_type,
    p.created_at,
    m.kind AS origin_message_kind,
    CASE
      /* Both writers of verified = 1 (bookVerifiedPayment via the webhook
       * handler, and via the storefront transfer poll) perform a server-side
       * verify before booking, and both attach an intent and a provider ref.
       * That is established from the code trail, not assumed from the flag. */
      WHEN p.verified = 1
       AND p.payment_intent_id IS NOT NULL
       AND p.provider_ref IS NOT NULL          THEN 'PROVIDER_VERIFIED'
      /* verified = 1 without those anchors is exactly the case the correction
       * warned about: the flag alone proves nothing. */
      WHEN p.verified = 1                      THEN 'LEGACY_PROVENANCE_UNKNOWN'
      WHEN EXISTS (
        SELECT 1 FROM reconciliations r
         WHERE r.payment_id = p.id
           AND r.status = 'MATCHED'
      )                                        THEN 'BANK_FEED_MATCH'
      /* A draft whose originating conversation message was a photograph is a
       * payment booked from an image. Under the corrected model that should
       * have been PaymentEvidence and never a payment at all. */
      WHEN p.source_type = 'chat'
       AND m.kind = 'media'                    THEN 'LEGACY_UNVERIFIED_FROM_IMAGE'
      WHEN p.source_type = 'chat'
       AND m.kind IN ('text', 'voice')
       AND p.method = 'cash'                   THEN 'MERCHANT_ATTESTED_CASH'
      WHEN p.source_type = 'chat'
       AND m.kind IN ('text', 'voice')         THEN 'MERCHANT_ATTESTED_TRANSFER'
      /* Dashboard-entered payments are the merchant acting deliberately in
       * their own books; still an attestation, but with no message to inspect. */
      WHEN p.source_type = 'dashboard'
       AND p.method = 'cash'                   THEN 'MERCHANT_ATTESTED_CASH'
      WHEN p.source_type = 'dashboard'         THEN 'MERCHANT_ATTESTED_TRANSFER'
      ELSE                                          'LEGACY_PROVENANCE_UNKNOWN'
    END AS provenance
  FROM payments p
  LEFT JOIN command_drafts d          ON d.id::text = p.source_id
  LEFT JOIN conversation_messages m   ON m.id = d.conversation_message_id
),
enriched AS (
  SELECT c.*,
    EXISTS (SELECT 1 FROM receipts            r WHERE r.payment_id = c.id) AS has_receipt,
    EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = c.id) AS has_allocation
  FROM classified c
)

SELECT provenance, business_id, id AS payment_id,
       amount_k / 100.0 AS naira, method, source_type,
       origin_message_kind, has_receipt, has_allocation, created_at
  FROM enriched
 WHERE provenance IN ('LEGACY_UNVERIFIED_FROM_IMAGE', 'LEGACY_PROVENANCE_UNKNOWN')
   AND (has_receipt OR has_allocation)
 ORDER BY business_id, created_at;

\echo ''
\echo '== 3. total payment population, for sanity =='
SELECT count(*) AS all_payments,
       count(*) FILTER (WHERE verified = 1) AS verified_flag_set,
       count(*) FILTER (WHERE verified = 0) AS verified_flag_clear
  FROM payments;
