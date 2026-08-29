-- Payment evidence and payment truth (canonical spec §6.1, §6.3–6.5, §23).
--
-- The build plan calls this 0052_payment_evidence. 0052 became the
-- entitlements migration while R0A-ii waited, so this is 0057. The number is
-- a sequence position, not an identifier; the PR is PR-003.
--
-- ADDITIVE ONLY. Six tables, no writers, no readers, no foreign key from
-- `payments` yet. Nothing in this migration manufactures trust, which is why
-- it needs no approval gate: it gives evidence somewhere to live that is not
-- a payment, and PR-004 and PR-005 fill it.
--
-- The reason this is a whole PR rather than a column on `payments`: adding
-- revocation and idempotency later means migrating a populated APPEND-ONLY
-- table, which is exactly the situation append-only makes expensive.

/* ── 1. PaymentEvidence (spec §6.1, §23) ──────────────────────────────────
 * Something somebody showed us. It proves nothing.
 *
 * A screenshot of a bank app is personal data; the fact that a claim was
 * made is a financial record. §23 keeps the two on different clocks, which
 * is why the retention columns live here rather than in a sweep's config.  */
CREATE TABLE IF NOT EXISTS payment_evidence (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id),
  customer_id         uuid REFERENCES customers(id),
  /** How it reached us: a chat image, a forwarded document, an upload. */
  source              text NOT NULL,
  /** Where the raw media lives. Null once purged; the claim survives it. */
  media_ref           text,
  media_mime_type     text,
  /** What the customer said it was worth. An assertion, never a Payment. */
  claimed_amount_k    bigint,
  resolution_state    text NOT NULL DEFAULT 'UNRESOLVED'
                        CHECK (resolution_state IN ('UNRESOLVED', 'RESOLVED', 'EXPIRED')),
  /* An abandoned dispute is the MOST likely state for a claim to be in, not
   * the least, so an unresolved claim must not live forever automatically. */
  resolution_deadline timestamptz,
  resolved_at         timestamptz,
  raw_purged_at       timestamptz,
  retention_policy_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  /* RESOLVED and EXPIRED both carry a resolution time; §23 is explicit that
   * expiry sets `resolvedAt` too, because the retention countdown starts
   * from the same instant either way. */
  CONSTRAINT payment_evidence_resolved_together
    CHECK ((resolution_state = 'UNRESOLVED') = (resolved_at IS NULL))
);

CREATE INDEX payment_evidence_business_ix ON payment_evidence (business_id, created_at);
/* The sweep's question: what is still open and past its deadline. */
CREATE INDEX payment_evidence_due_ix ON payment_evidence (resolution_deadline)
  WHERE resolution_state = 'UNRESOLVED';

/* ── 2. PaymentVerification (spec §6.3) ───────────────────────────────────
 * The act of establishing that money arrived, and by what means.
 *
 * APPEND-ONLY, enforced below by REVOKE rather than by convention. A
 * payment's confirmation can be strengthened later; it is never rewritten.  */
CREATE TABLE IF NOT EXISTS payment_verifications (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id               uuid NOT NULL REFERENCES businesses(id),
  payment_id                uuid NOT NULL REFERENCES payments(id),
  source                    text NOT NULL
    CHECK (source IN ('PROVIDER_VERIFIED', 'BANK_FEED_MATCH',
                      'MERCHANT_ATTESTED', 'MANUAL_RECONCILIATION')),
  payment_evidence_id       uuid REFERENCES payment_evidence(id),
  /** The bank line, for BANK_FEED_MATCH and MANUAL_RECONCILIATION. */
  financial_transaction_id  uuid,
  /** For PROVIDER_VERIFIED. See the claims table for how it is built. */
  provider_source_identity  text,
  /** LINKED LATER, when P1 (PR-054) introduces PaymentAttempt. */
  payment_attempt_id        uuid,
  provider_reference        text,
  /** Who, for MERCHANT_ATTESTED and MANUAL_RECONCILIATION. */
  actor_id                  text,
  verified_at               timestamptz NOT NULL DEFAULT now(),
  reason                    text,
  metadata                  jsonb,
  /** Set only by a backfill, so a rollback can be exact. */
  source_migration          text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- `LEGACY_PROVENANCE_UNKNOWN` is deliberately absent from the CHECK above.
-- Spec §6.2: it is an initial historical state and never a verification
-- source. A verification event means some evidence or assertion actually
-- occurred; an event recording that nothing is known is a contradiction in
-- terms, and permitting it would let the remediation queue look worked when
-- it was not.

CREATE INDEX payment_verifications_payment_ix
  ON payment_verifications (business_id, payment_id, verified_at);

/* ── 3. PaymentVerificationRevocation (spec §6.4) ──────────────────────────
 * The compensating event. Append-only without one is not integrity, it is a
 * trap: a human matches a bank line to the wrong payment and that payment is
 * externally verified forever on evidence that was never its own.
 *
 * There is no revoking a revocation. If the revocation was the mistake, the
 * correction is ordinary: append a fresh verification saying so.            */
CREATE TABLE IF NOT EXISTS payment_verification_revocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id),
  verification_id uuid NOT NULL REFERENCES payment_verifications(id),
  /* Both REQUIRED by §6.4. A revocation with no reason is an unexplained
   * withdrawal of trust, which is worse than the wrong match it corrects. */
  reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_id        text NOT NULL CHECK (length(btrim(actor_id)) > 0),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  /* One revocation per verification: revoking twice has no meaning, and the
   * second row would make the reconstruction in §6.5 ambiguous. */
  CONSTRAINT payment_verification_revocations_once UNIQUE (verification_id)
);

CREATE INDEX payment_verification_revocations_business_ix
  ON payment_verification_revocations (business_id, occurred_at);

/* ── 4. PaymentVerificationClaim (spec §6.5) ──────────────────────────────
 * MUTABLE. Not audit truth, not financial truth. It says which evidence is
 * currently spoken for, and nothing else.
 *
 * ROW EXISTENCE IS THE STATE. No status column and no RELEASED row: a
 * retained released row would be a mutable statement of something the
 * immutable events already say, and the two could disagree.
 *
 * Non-authoritative but financially safety-critical. Trust never reads it,
 * so losing it corrupts nothing that exists; but without it two writers can
 * both believe they hold the same bank line, and a duplicate verification is
 * exactly as damaging as a corrupted one.                                   */
CREATE TABLE IF NOT EXISTS payment_verification_claims (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              uuid NOT NULL REFERENCES businesses(id),
  verification_id          uuid NOT NULL REFERENCES payment_verifications(id),
  financial_transaction_id uuid,
  /**
   * `businessId + paymentConnectionId + providerTransactionReference`,
   * normalised. NOT `payment_attempt_id`: PaymentAttempt does not arrive
   * until PR-054, while PR-005 must already record provider-verified
   * payments correctly, roughly fifty PRs earlier. A claim keyed on a table
   * that does not exist yet is not a constraint, it is a plan to have one.
   */
  provider_source_identity text,
  /** The explicit confirmation action: a command draft, or an audit event. */
  confirmation_event_id    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  /* Exactly one key. The four sources do not share a notion of sameness, so
   * there is no single global uniqueness rule to fall back on. */
  CONSTRAINT payment_verification_claims_one_key CHECK (
    (financial_transaction_id IS NOT NULL)::int
    + (provider_source_identity IS NOT NULL)::int
    + (confirmation_event_id IS NOT NULL)::int = 1
  ),
  /* One verification holds at most one claim, so the reconstruction in §6.5
   * is a bijection rather than a best effort. */
  CONSTRAINT payment_verification_claims_per_verification UNIQUE (verification_id)
);

-- Every predicate reads a column of the table it indexes, which is the only
-- thing PostgreSQL accepts. An earlier draft predicated these on
-- `WHERE revoked_at IS NULL` against `payment_verifications`, which has no
-- such column because revocation is a separate table: a partial-index
-- predicate cannot see another table and cannot use a subquery.
CREATE UNIQUE INDEX payment_verification_claims_txn_ux
  ON payment_verification_claims (business_id, financial_transaction_id)
  WHERE financial_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX payment_verification_claims_provider_ux
  ON payment_verification_claims (business_id, provider_source_identity)
  WHERE provider_source_identity IS NOT NULL;
CREATE UNIQUE INDEX payment_verification_claims_confirmation_ux
  ON payment_verification_claims (business_id, confirmation_event_id)
  WHERE confirmation_event_id IS NOT NULL;

/* ── tenant isolation on the four ─────────────────────────────────────── */
ALTER TABLE payment_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_evidence
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE payment_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_verifications
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE payment_verification_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_verification_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_verification_revocations
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE payment_verification_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_verification_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_verification_claims
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* ── append-only, in the database rather than by convention ───────────── */
-- Migration 0001's ALTER DEFAULT PRIVILEGES hands both application roles
-- UPDATE and DELETE on every new table, so append-only is a REVOKE.
REVOKE UPDATE, DELETE ON payment_verifications FROM rekoda_app;
REVOKE UPDATE, DELETE ON payment_verifications FROM rekoda_worker;
REVOKE UPDATE, DELETE ON payment_verification_revocations FROM rekoda_app;
REVOKE UPDATE, DELETE ON payment_verification_revocations FROM rekoda_worker;

-- The claim projection keeps DELETE: revoking DELETES the claim, in the same
-- transaction as the revocation event, which is what releases the evidence
-- so a corrected verification can take it. UPDATE it does not need, because
-- a claim never changes what it claims.
REVOKE UPDATE ON payment_verification_claims FROM rekoda_app;
REVOKE UPDATE ON payment_verification_claims FROM rekoda_worker;

/* ── 5 and 6. The migration manifests ─────────────────────────────────────
 * OPERATOR INFRASTRUCTURE, NOT MERCHANT DATA.
 *
 * A migration spans every tenant, so `migration_manifests` has no
 * `business_id` and cannot honestly wear tenant RLS. An earlier draft put all
 * six tables behind the tenant policy, which was incoherent for a
 * cross-tenant table with no tenant column: the policy would have matched
 * nothing and hidden every row from everybody, including the operator who
 * needed it during a rollback.
 *
 * NORMALISED, not an array. One row holding hundreds of thousands of uuids is
 * awkward to index, join, page and reason about during a rollback under
 * pressure, which is exactly when it would be needed.
 *
 * A historical migration audit record must SURVIVE ITS OWN ROLLBACK.
 * Rollback appends state; it never deletes the manifest or its items.        */
CREATE TABLE IF NOT EXISTS migration_manifests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  /** Which version of the code ran, so "it ran" names what ran. */
  code_version            text,
  /** Rows at or before this instant were in scope. */
  cutoff_at               timestamptz NOT NULL,
  status                  text NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'ROLLED_BACK')),
  /**
   * `expected_row_count` beside `affected_row_count` is what turns "the
   * migration ran" into "the migration did what the approved report said it
   * would".
   */
  expected_row_count      bigint,
  affected_row_count      bigint,
  /**
   * A hash over the approved item set. Counts matching is not the same as
   * the population matching: this proves the rows that ran are IDENTICAL to
   * the rows that were reviewed, rather than merely as numerous.
   */
  item_set_checksum       text,
  /** Ties the run back to the specific report somebody signed off. */
  approved_by             text,
  source_report_reference text,
  started_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz,
  created_by              text NOT NULL,
  rolled_back_at          timestamptz,
  rolled_back_by          text,
  reason                  text,
  /* A rollback names itself. A manifest marked rolled back with no hand on
   * it is the one record nobody can question later. */
  CONSTRAINT migration_manifests_rollback_attributed
    CHECK ((rolled_back_at IS NULL) = (rolled_back_by IS NULL))
);

CREATE TABLE IF NOT EXISTS migration_manifest_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id         uuid NOT NULL REFERENCES migration_manifests(id),
  /* Carried on the ITEM even though the manifest is not a tenant table, so
   * the audit record stays tenant-attributable. */
  business_id         uuid NOT NULL,
  payment_id          uuid NOT NULL,
  /** `prior_value` beside `assigned_value` is what makes rollback exact. */
  old_initial_source  text,
  new_initial_source  text,
  verification_id     uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_manifest_items_once UNIQUE (manifest_id, payment_id)
);

CREATE INDEX migration_manifest_items_manifest_ix
  ON migration_manifest_items (manifest_id, business_id);

-- NO RLS on either. They have no tenant to scope to, and a policy that
-- matches nothing is worse than no policy: it hides the evidence from the
-- operator holding the rollback.
--
-- Instead the application roles are granted NOTHING AT ALL. Not INSERT, not
-- UPDATE, not DELETE, and not SELECT: a merchant-facing service has no
-- business reading a cross-tenant migration record, and any operational need
-- for one is a decision to argue and record rather than a default to inherit
-- from 0001's ALTER DEFAULT PRIVILEGES.
REVOKE ALL ON migration_manifests FROM rekoda_app;
REVOKE ALL ON migration_manifests FROM rekoda_worker;
REVOKE ALL ON migration_manifest_items FROM rekoda_app;
REVOKE ALL ON migration_manifest_items FROM rekoda_worker;
