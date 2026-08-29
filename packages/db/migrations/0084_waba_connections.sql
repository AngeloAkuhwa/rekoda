-- The WABA connection model (spec §24; W1/W2, PR-058).
--
-- The merchant's own WABA, connected by them, routed by us. This is the
-- ADDITIVE onboarding infrastructure the readiness ruling allows against
-- test numbers; production enablement waits on W0 (Meta approvals), and
-- the billing mode stays OPEN COMMERCIAL — the column carries all three
-- §24 modes plus UNCONFIRMED, so confirming it is a data change, never a
-- code branch (owner decision 2).
--
--   waba_connections        phoneNumberId → BusinessId routing. The
--                           phone_number_id is GLOBALLY unique: one number
--                           routes to exactly one business, and an unknown
--                           one is refused, never guessed.
--   waba_templates          per-WABA templates; category chosen at send
--                           time and metered to its own §4.2 unit.
--   waba_service_windows    the 24-hour customer service window, per
--                           connection per customer — the customer's
--                           identity a HASH, never a raw number.

CREATE TABLE waba_connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL REFERENCES businesses (id),
  waba_id              text NOT NULL,
  phone_number_id      text NOT NULL,
  /* What the merchant reads on the card: +234 801 ... . Display only. */
  display_phone        text,
  status               text NOT NULL DEFAULT 'PENDING_SIGNUP'
    CHECK (status IN ('PENDING_SIGNUP', 'CONNECTED', 'UNHEALTHY', 'REVOKED')),
  billing_mode         text NOT NULL DEFAULT 'UNCONFIRMED'
    CHECK (billing_mode IN ('UNCONFIRMED', 'MERCHANT_DIRECT', 'REKODA_CREDIT_LINE', 'PARTNER_BILLED')),
  /* The merchant's token: vault blob only, tail for the card. */
  access_token_cipher  text,
  token_tail           text,
  connected_at         timestamptz,
  revoked_at           timestamptz,
  last_healthy_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT waba_connections_business_id_ux UNIQUE (business_id, id),
  /* THE routing key: globally unique, whoever owns it. */
  CONSTRAINT waba_connections_phone_number_ux UNIQUE (phone_number_id)
);

CREATE INDEX waba_connections_business_ix ON waba_connections (business_id);

CREATE TABLE waba_templates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL REFERENCES businesses (id),
  waba_connection_id    uuid NOT NULL,
  name                  text NOT NULL,
  language              text NOT NULL DEFAULT 'en',
  /* §4.2's metering categories: an eightfold cost difference is not a
   * detail. SERVICE is the in-window reply that needs no template. */
  category              text NOT NULL
    CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION', 'SERVICE')),
  status                text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED')),
  provider_template_id  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT waba_templates_connection_fk
    FOREIGN KEY (business_id, waba_connection_id)
    REFERENCES waba_connections (business_id, id),
  CONSTRAINT waba_templates_name_ux
    UNIQUE (business_id, waba_connection_id, name, language)
);

CREATE TABLE waba_service_windows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses (id),
  waba_connection_id  uuid NOT NULL,
  /* The customer's WhatsApp identity, hashed. Raw numbers never land here. */
  customer_hash       text NOT NULL,
  window_expires_at   timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT waba_windows_connection_fk
    FOREIGN KEY (business_id, waba_connection_id)
    REFERENCES waba_connections (business_id, id),
  CONSTRAINT waba_windows_customer_ux
    UNIQUE (business_id, waba_connection_id, customer_hash)
);

ALTER TABLE waba_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE waba_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waba_connections
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* Routing is inherently pre-tenant: a webhook names a phoneNumberId, and
 * which business it belongs to is the ANSWER, not the input. The same
 * narrow shape as worker_resolve on payment_intents (0010): one extra
 * policy, one role, SELECT only. The API role stays fully tenant-scoped. */
CREATE POLICY worker_resolve ON waba_connections
  FOR SELECT
  TO rekoda_worker
  USING (true);

ALTER TABLE waba_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE waba_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waba_templates
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE waba_service_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE waba_service_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waba_service_windows
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* A connection is revoked, never erased; a template pauses; a window
 * expires by its own clock. */
REVOKE DELETE ON waba_connections FROM rekoda_app;
REVOKE DELETE ON waba_connections FROM rekoda_worker;
REVOKE DELETE ON waba_templates FROM rekoda_app;
REVOKE DELETE ON waba_templates FROM rekoda_worker;
