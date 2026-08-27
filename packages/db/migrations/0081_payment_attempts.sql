-- PaymentAttempt, and connection-scoped identity (spec §6.1, §22.3;
-- P1, PR-054).
--
-- An intent is an expectation of money on a specific connection; an
-- attempt is ONE TRY against that intent. The provider's attempt id is
-- scoped to the connection that produced it (§22.3) — never assumed
-- globally unique — and the §6.5 verification column that has waited
-- since 0057 ("LINKED LATER, when P1 introduces PaymentAttempt") gains
-- its foreign key today.

ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_business_id_ux UNIQUE (business_id, id);

/* The intent's connection reference becomes tenant-safe: an intent citing
 * another tenant's connection is unrepresentable. */
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_connection_fk
  FOREIGN KEY (business_id, payment_connection_id)
  REFERENCES payment_connections (business_id, id);

CREATE TABLE payment_attempts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL REFERENCES businesses (id),
  payment_intent_id      uuid NOT NULL,
  payment_connection_id  uuid NOT NULL,
  /* The provider's own id for this try. Connection-scoped (§22.3). */
  provider_attempt_id    text NOT NULL,
  status                 text NOT NULL DEFAULT 'INITIATED'
    CHECK (status IN ('INITIATED', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
  method                 text,
  failure_reason         text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_attempts_business_id_ux UNIQUE (business_id, id),
  CONSTRAINT payment_attempts_intent_fk
    FOREIGN KEY (business_id, payment_intent_id)
    REFERENCES payment_intents (business_id, id),
  CONSTRAINT payment_attempts_connection_fk
    FOREIGN KEY (business_id, payment_connection_id)
    REFERENCES payment_connections (business_id, id),
  /* §22.3, verbatim. */
  CONSTRAINT payment_attempts_provider_ux
    UNIQUE (business_id, payment_connection_id, provider_attempt_id)
);

CREATE INDEX payment_attempts_intent_ix ON payment_attempts (business_id, payment_intent_id);

ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_attempts
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* A try that happened stays on file; only its status resolves. */
REVOKE DELETE ON payment_attempts FROM rekoda_app;
REVOKE DELETE ON payment_attempts FROM rekoda_worker;

/* The 0057 column, linked at last — additively, exactly as §6.5 promised. */
ALTER TABLE payment_verifications
  ADD CONSTRAINT payment_verifications_attempt_fk
  FOREIGN KEY (business_id, payment_attempt_id)
  REFERENCES payment_attempts (business_id, id);
