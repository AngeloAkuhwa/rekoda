-- R0A-i · Legacy payment provenance investigation.  READ ONLY.
--
-- Canonical corrections v1.5 §1. Provenance is reconstructed from EVIDENCE,
-- and the report names what the estate cannot establish so that remediation
-- is a decision somebody makes rather than a default the migration picks.
--
-- Two rules the earlier draft of this script broke, both fixed here:
--
--   The medium is not the attestation. "Ada says she transferred 60k" and "I
--   checked my bank and Ada's 60k is there" are both text. Typed, spoken and
--   photographed are therefore reported as a separate `evidence_basis`
--   column and never decide the trust grade.
--
--   POS is not a transfer. `method` stays its own dimension; it is never
--   fused into the provenance value.
--
-- What DOES prove attestation is a durable state transition. Every
-- chat-booked payment reaches `recordMerchantPayment` or `issueSale` only
-- through `confirmPendingDraft`, whose `claimDraft` is a conditional UPDATE
-- of `command_drafts` from 'pending' to 'confirmed'. The row survives, so the
-- proof survives: the merchant was shown a preview naming the amount and the
-- invoice, and answered it.
--
-- Nothing here writes. Run it against production before any R0A-ii migration:
--   psql "$DATABASE_URL" -f scripts/investigations/r0a-i-payment-provenance.sql
--
-- The ladder, in the order the CASE applies it:
--   provider intent + provider reference        -> PROVIDER_VERIFIED
--   an imported bank line matched its posting   -> BANK_FEED_MATCH
--   the merchant confirmed the draft            -> MERCHANT_ATTESTED
--   an authenticated dashboard entry            -> MERCHANT_ATTESTED
--   anything else                               -> LEGACY_PROVENANCE_UNKNOWN
--
-- The ladder below is repeated verbatim in each of the three statements. A
-- WITH clause binds only to its own statement, and a temp view would make a
-- read-only script write to the temp catalogue and stop it running on a
-- standby. Change one copy and you must change all three.
\pset footer off

\echo '== 1. provenance distribution =='
WITH classified AS (
  SELECT
    p.id,
    p.business_id,
    p.amount_k,
    p.verified,
    p.source_type,
    p.created_at,
    CASE
      /* 1. Provider-verified. Both callers of `bookVerifiedPayment` run a
       * server-side verify before booking and both attach an intent and a
       * provider reference, so these two anchors are the proof. The old
       * `verified` flag is deliberately NOT consulted: it records that some
       * code path once set it, not who claimed the money arrived. */
      WHEN p.payment_intent_id IS NOT NULL
       AND p.provider_ref IS NOT NULL              THEN 'PROVIDER_VERIFIED'
      /* 2. Bank feed. `bank_line_matches` anchors an imported statement line
       * to a LEDGER TRANSACTION, and a payment's posting carries the same
       * (source_type, source_id) pair the payment row does. That pair is how
       * the two are tied back together. */
      WHEN p.source_id IS NOT NULL AND EXISTS (
        SELECT 1
          FROM ledger_transactions lt
          JOIN bank_line_matches   blm ON blm.transaction_id = lt.id
         WHERE lt.business_id = p.business_id
           AND lt.source_type = p.source_type
           AND lt.source_id   = p.source_id
      )                                            THEN 'BANK_FEED_MATCH'
      /* 3. Merchant attestation, proved by a STATE TRANSITION rather than by
       * the medium the merchant used. Every chat-booked payment passes
       * through `confirmPendingDraft`, whose `claimDraft` is a conditional
       * UPDATE from 'pending' to 'confirmed'. A row can only exist if the
       * merchant was shown a preview naming the amount and the invoice and
       * answered it. That answer is the attestation; whether they typed it,
       * spoke it, or were looking at a photograph when they did is a
       * different fact, reported separately below. */
      WHEN p.source_type = 'chat'
       AND d.state = 'confirmed'
       AND d.intent IN ('RecordPayment', 'RecordSale')
                                                   THEN 'MERCHANT_ATTESTED'
      /* 4. The dashboard path: an authenticated user opened their own books
       * and entered an invoice number and an amount. The audit row carries
       * the user, which is what makes it an attestation rather than an
       * unattributed write. */
      WHEN p.source_type = 'dashboard' AND EXISTS (
        SELECT 1 FROM audit_events a
         WHERE a.business_id = p.business_id
           AND a.entity      = 'payment'
           AND a.entity_id   = p.id::text
           AND a.actor LIKE 'user:%'
      )                                            THEN 'MERCHANT_ATTESTED'
      /* 5. Everything else, INCLUDING `verified = 1` with no provider anchors
       * and chat rows whose draft is missing or never reached 'confirmed'.
       * Not a failure of the report: the point is to name what the estate
       * cannot establish rather than let the migration pick a default. */
      ELSE                                              'LEGACY_PROVENANCE_UNKNOWN'
    END AS provenance,
    /* Reported ALONGSIDE provenance and never folded into it. What the
     * merchant was looking at is context for a human reviewing the queue, not
     * a trust grade: a photograph does not lower an attestation, and typing
     * does not raise one. */
    CASE
      WHEN p.source_type <> 'chat' THEN 'NOT_A_MESSAGE'
      WHEN m.kind = 'media'        THEN 'SAW_AN_IMAGE'
      WHEN m.kind = 'voice'        THEN 'SPOKEN'
      WHEN m.kind = 'text'         THEN 'TYPED'
      WHEN m.kind IS NULL          THEN 'NO_MESSAGE_ON_FILE'
      ELSE                              m.kind
    END AS evidence_basis,
    /* And the third dimension, kept apart from both. POS is not a bank
     * transfer merely because both are electronic. */
    p.method AS method
  FROM payments p
  LEFT JOIN command_drafts d
    ON p.source_type = 'chat'
   AND d.business_id = p.business_id
   AND d.id::text    = p.source_id
  LEFT JOIN conversation_messages m ON m.id = d.conversation_message_id
),
enriched AS (
  SELECT c.*,
    EXISTS (SELECT 1 FROM receipts             r WHERE r.payment_id = c.id) AS has_receipt,
    EXISTS (SELECT 1 FROM payment_allocations  a WHERE a.payment_id = c.id) AS has_allocation
  FROM classified c
)

SELECT provenance,
       count(*)                                  AS payments,
       count(*) FILTER (WHERE has_receipt)       AS with_receipt,
       count(*) FILTER (WHERE has_allocation)    AS with_allocation,
       sum(amount_k) / 100.0                     AS naira_total
  FROM enriched
 GROUP BY provenance
 ORDER BY payments DESC;

\echo ''
\echo '== 2. the three dimensions, crossed. provenance never reads the other two =='
WITH classified AS (
  SELECT
    p.id,
    p.business_id,
    p.amount_k,
    p.verified,
    p.source_type,
    p.created_at,
    CASE
      /* 1. Provider-verified. Both callers of `bookVerifiedPayment` run a
       * server-side verify before booking and both attach an intent and a
       * provider reference, so these two anchors are the proof. The old
       * `verified` flag is deliberately NOT consulted: it records that some
       * code path once set it, not who claimed the money arrived. */
      WHEN p.payment_intent_id IS NOT NULL
       AND p.provider_ref IS NOT NULL              THEN 'PROVIDER_VERIFIED'
      /* 2. Bank feed. `bank_line_matches` anchors an imported statement line
       * to a LEDGER TRANSACTION, and a payment's posting carries the same
       * (source_type, source_id) pair the payment row does. That pair is how
       * the two are tied back together. */
      WHEN p.source_id IS NOT NULL AND EXISTS (
        SELECT 1
          FROM ledger_transactions lt
          JOIN bank_line_matches   blm ON blm.transaction_id = lt.id
         WHERE lt.business_id = p.business_id
           AND lt.source_type = p.source_type
           AND lt.source_id   = p.source_id
      )                                            THEN 'BANK_FEED_MATCH'
      /* 3. Merchant attestation, proved by a STATE TRANSITION rather than by
       * the medium the merchant used. Every chat-booked payment passes
       * through `confirmPendingDraft`, whose `claimDraft` is a conditional
       * UPDATE from 'pending' to 'confirmed'. A row can only exist if the
       * merchant was shown a preview naming the amount and the invoice and
       * answered it. That answer is the attestation; whether they typed it,
       * spoke it, or were looking at a photograph when they did is a
       * different fact, reported separately below. */
      WHEN p.source_type = 'chat'
       AND d.state = 'confirmed'
       AND d.intent IN ('RecordPayment', 'RecordSale')
                                                   THEN 'MERCHANT_ATTESTED'
      /* 4. The dashboard path: an authenticated user opened their own books
       * and entered an invoice number and an amount. The audit row carries
       * the user, which is what makes it an attestation rather than an
       * unattributed write. */
      WHEN p.source_type = 'dashboard' AND EXISTS (
        SELECT 1 FROM audit_events a
         WHERE a.business_id = p.business_id
           AND a.entity      = 'payment'
           AND a.entity_id   = p.id::text
           AND a.actor LIKE 'user:%'
      )                                            THEN 'MERCHANT_ATTESTED'
      /* 5. Everything else, INCLUDING `verified = 1` with no provider anchors
       * and chat rows whose draft is missing or never reached 'confirmed'.
       * Not a failure of the report: the point is to name what the estate
       * cannot establish rather than let the migration pick a default. */
      ELSE                                              'LEGACY_PROVENANCE_UNKNOWN'
    END AS provenance,
    /* Reported ALONGSIDE provenance and never folded into it. What the
     * merchant was looking at is context for a human reviewing the queue, not
     * a trust grade: a photograph does not lower an attestation, and typing
     * does not raise one. */
    CASE
      WHEN p.source_type <> 'chat' THEN 'NOT_A_MESSAGE'
      WHEN m.kind = 'media'        THEN 'SAW_AN_IMAGE'
      WHEN m.kind = 'voice'        THEN 'SPOKEN'
      WHEN m.kind = 'text'         THEN 'TYPED'
      WHEN m.kind IS NULL          THEN 'NO_MESSAGE_ON_FILE'
      ELSE                              m.kind
    END AS evidence_basis,
    /* And the third dimension, kept apart from both. POS is not a bank
     * transfer merely because both are electronic. */
    p.method AS method
  FROM payments p
  LEFT JOIN command_drafts d
    ON p.source_type = 'chat'
   AND d.business_id = p.business_id
   AND d.id::text    = p.source_id
  LEFT JOIN conversation_messages m ON m.id = d.conversation_message_id
),
enriched AS (
  SELECT c.*,
    EXISTS (SELECT 1 FROM receipts             r WHERE r.payment_id = c.id) AS has_receipt,
    EXISTS (SELECT 1 FROM payment_allocations  a WHERE a.payment_id = c.id) AS has_allocation
  FROM classified c
)

SELECT provenance, evidence_basis, method,
       count(*)              AS payments,
       sum(amount_k) / 100.0 AS naira_total
  FROM enriched
 GROUP BY provenance, evidence_basis, method
 ORDER BY provenance, payments DESC;

\echo ''
\echo '== 3. REMEDIATION QUEUE: paper issued on payments whose provenance is unknown =='
WITH classified AS (
  SELECT
    p.id,
    p.business_id,
    p.amount_k,
    p.verified,
    p.source_type,
    p.created_at,
    CASE
      /* 1. Provider-verified. Both callers of `bookVerifiedPayment` run a
       * server-side verify before booking and both attach an intent and a
       * provider reference, so these two anchors are the proof. The old
       * `verified` flag is deliberately NOT consulted: it records that some
       * code path once set it, not who claimed the money arrived. */
      WHEN p.payment_intent_id IS NOT NULL
       AND p.provider_ref IS NOT NULL              THEN 'PROVIDER_VERIFIED'
      /* 2. Bank feed. `bank_line_matches` anchors an imported statement line
       * to a LEDGER TRANSACTION, and a payment's posting carries the same
       * (source_type, source_id) pair the payment row does. That pair is how
       * the two are tied back together. */
      WHEN p.source_id IS NOT NULL AND EXISTS (
        SELECT 1
          FROM ledger_transactions lt
          JOIN bank_line_matches   blm ON blm.transaction_id = lt.id
         WHERE lt.business_id = p.business_id
           AND lt.source_type = p.source_type
           AND lt.source_id   = p.source_id
      )                                            THEN 'BANK_FEED_MATCH'
      /* 3. Merchant attestation, proved by a STATE TRANSITION rather than by
       * the medium the merchant used. Every chat-booked payment passes
       * through `confirmPendingDraft`, whose `claimDraft` is a conditional
       * UPDATE from 'pending' to 'confirmed'. A row can only exist if the
       * merchant was shown a preview naming the amount and the invoice and
       * answered it. That answer is the attestation; whether they typed it,
       * spoke it, or were looking at a photograph when they did is a
       * different fact, reported separately below. */
      WHEN p.source_type = 'chat'
       AND d.state = 'confirmed'
       AND d.intent IN ('RecordPayment', 'RecordSale')
                                                   THEN 'MERCHANT_ATTESTED'
      /* 4. The dashboard path: an authenticated user opened their own books
       * and entered an invoice number and an amount. The audit row carries
       * the user, which is what makes it an attestation rather than an
       * unattributed write. */
      WHEN p.source_type = 'dashboard' AND EXISTS (
        SELECT 1 FROM audit_events a
         WHERE a.business_id = p.business_id
           AND a.entity      = 'payment'
           AND a.entity_id   = p.id::text
           AND a.actor LIKE 'user:%'
      )                                            THEN 'MERCHANT_ATTESTED'
      /* 5. Everything else, INCLUDING `verified = 1` with no provider anchors
       * and chat rows whose draft is missing or never reached 'confirmed'.
       * Not a failure of the report: the point is to name what the estate
       * cannot establish rather than let the migration pick a default. */
      ELSE                                              'LEGACY_PROVENANCE_UNKNOWN'
    END AS provenance,
    /* Reported ALONGSIDE provenance and never folded into it. What the
     * merchant was looking at is context for a human reviewing the queue, not
     * a trust grade: a photograph does not lower an attestation, and typing
     * does not raise one. */
    CASE
      WHEN p.source_type <> 'chat' THEN 'NOT_A_MESSAGE'
      WHEN m.kind = 'media'        THEN 'SAW_AN_IMAGE'
      WHEN m.kind = 'voice'        THEN 'SPOKEN'
      WHEN m.kind = 'text'         THEN 'TYPED'
      WHEN m.kind IS NULL          THEN 'NO_MESSAGE_ON_FILE'
      ELSE                              m.kind
    END AS evidence_basis,
    /* And the third dimension, kept apart from both. POS is not a bank
     * transfer merely because both are electronic. */
    p.method AS method
  FROM payments p
  LEFT JOIN command_drafts d
    ON p.source_type = 'chat'
   AND d.business_id = p.business_id
   AND d.id::text    = p.source_id
  LEFT JOIN conversation_messages m ON m.id = d.conversation_message_id
),
enriched AS (
  SELECT c.*,
    EXISTS (SELECT 1 FROM receipts             r WHERE r.payment_id = c.id) AS has_receipt,
    EXISTS (SELECT 1 FROM payment_allocations  a WHERE a.payment_id = c.id) AS has_allocation
  FROM classified c
)

SELECT provenance, evidence_basis, method,
       business_id, id AS payment_id,
       amount_k / 100.0 AS naira,
       source_type, verified AS legacy_verified_flag,
       has_receipt, has_allocation, created_at
  FROM enriched
 WHERE provenance = 'LEGACY_PROVENANCE_UNKNOWN'
   AND (has_receipt OR has_allocation)
 ORDER BY business_id, created_at;

\echo ''
\echo '== 4. FOR REVIEW, NOT REMEDIATION: attestations made while looking at an image =='
\echo '   These are attested. The merchant may still want to re-check the ones'
\echo '   they confirmed off a photograph, which is a business decision.'
WITH classified AS (
  SELECT
    p.id,
    p.business_id,
    p.amount_k,
    p.verified,
    p.source_type,
    p.created_at,
    CASE
      /* 1. Provider-verified. Both callers of `bookVerifiedPayment` run a
       * server-side verify before booking and both attach an intent and a
       * provider reference, so these two anchors are the proof. The old
       * `verified` flag is deliberately NOT consulted: it records that some
       * code path once set it, not who claimed the money arrived. */
      WHEN p.payment_intent_id IS NOT NULL
       AND p.provider_ref IS NOT NULL              THEN 'PROVIDER_VERIFIED'
      /* 2. Bank feed. `bank_line_matches` anchors an imported statement line
       * to a LEDGER TRANSACTION, and a payment's posting carries the same
       * (source_type, source_id) pair the payment row does. That pair is how
       * the two are tied back together. */
      WHEN p.source_id IS NOT NULL AND EXISTS (
        SELECT 1
          FROM ledger_transactions lt
          JOIN bank_line_matches   blm ON blm.transaction_id = lt.id
         WHERE lt.business_id = p.business_id
           AND lt.source_type = p.source_type
           AND lt.source_id   = p.source_id
      )                                            THEN 'BANK_FEED_MATCH'
      /* 3. Merchant attestation, proved by a STATE TRANSITION rather than by
       * the medium the merchant used. Every chat-booked payment passes
       * through `confirmPendingDraft`, whose `claimDraft` is a conditional
       * UPDATE from 'pending' to 'confirmed'. A row can only exist if the
       * merchant was shown a preview naming the amount and the invoice and
       * answered it. That answer is the attestation; whether they typed it,
       * spoke it, or were looking at a photograph when they did is a
       * different fact, reported separately below. */
      WHEN p.source_type = 'chat'
       AND d.state = 'confirmed'
       AND d.intent IN ('RecordPayment', 'RecordSale')
                                                   THEN 'MERCHANT_ATTESTED'
      /* 4. The dashboard path: an authenticated user opened their own books
       * and entered an invoice number and an amount. The audit row carries
       * the user, which is what makes it an attestation rather than an
       * unattributed write. */
      WHEN p.source_type = 'dashboard' AND EXISTS (
        SELECT 1 FROM audit_events a
         WHERE a.business_id = p.business_id
           AND a.entity      = 'payment'
           AND a.entity_id   = p.id::text
           AND a.actor LIKE 'user:%'
      )                                            THEN 'MERCHANT_ATTESTED'
      /* 5. Everything else, INCLUDING `verified = 1` with no provider anchors
       * and chat rows whose draft is missing or never reached 'confirmed'.
       * Not a failure of the report: the point is to name what the estate
       * cannot establish rather than let the migration pick a default. */
      ELSE                                              'LEGACY_PROVENANCE_UNKNOWN'
    END AS provenance,
    /* Reported ALONGSIDE provenance and never folded into it. What the
     * merchant was looking at is context for a human reviewing the queue, not
     * a trust grade: a photograph does not lower an attestation, and typing
     * does not raise one. */
    CASE
      WHEN p.source_type <> 'chat' THEN 'NOT_A_MESSAGE'
      WHEN m.kind = 'media'        THEN 'SAW_AN_IMAGE'
      WHEN m.kind = 'voice'        THEN 'SPOKEN'
      WHEN m.kind = 'text'         THEN 'TYPED'
      WHEN m.kind IS NULL          THEN 'NO_MESSAGE_ON_FILE'
      ELSE                              m.kind
    END AS evidence_basis,
    /* And the third dimension, kept apart from both. POS is not a bank
     * transfer merely because both are electronic. */
    p.method AS method
  FROM payments p
  LEFT JOIN command_drafts d
    ON p.source_type = 'chat'
   AND d.business_id = p.business_id
   AND d.id::text    = p.source_id
  LEFT JOIN conversation_messages m ON m.id = d.conversation_message_id
),
enriched AS (
  SELECT c.*,
    EXISTS (SELECT 1 FROM receipts             r WHERE r.payment_id = c.id) AS has_receipt,
    EXISTS (SELECT 1 FROM payment_allocations  a WHERE a.payment_id = c.id) AS has_allocation
  FROM classified c
)

SELECT business_id, id AS payment_id,
       amount_k / 100.0 AS naira, method,
       has_receipt, has_allocation, created_at
  FROM enriched
 WHERE provenance     = 'MERCHANT_ATTESTED'
   AND evidence_basis = 'SAW_AN_IMAGE'
 ORDER BY business_id, created_at;

\echo ''
\echo '== 5. total payment population, for sanity =='
SELECT count(*)                                     AS all_payments,
       count(*) FILTER (WHERE verified = 1)         AS legacy_flag_set,
       count(*) FILTER (WHERE verified = 0)         AS legacy_flag_clear,
       count(*) FILTER (WHERE verified = 1
                          AND (payment_intent_id IS NULL
                            OR provider_ref IS NULL)) AS flag_set_without_anchors
  FROM payments;
