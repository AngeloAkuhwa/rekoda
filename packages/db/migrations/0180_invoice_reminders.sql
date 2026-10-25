-- N1 slice 1 (OWN-43, OWN-57): a merchant can have Rekoda send a payment reminder for one unpaid
-- invoice, by email or WhatsApp, with a history, a stop control and an opt-out.
--
--   businesses.public_contact_phone / _approved_at
--       the PUBLIC business phone shown in a reminder (never the private sign-in number). Reminders
--       are refused until the owner has approved one.
--   invoices.reminders_stopped_at
--       the merchant's "stop reminders for this invoice" control. NULL: reminders may go.
--   reminder_attestations
--       the merchant's statement, before the first email reminder to a customer, that they have a
--       lawful basis to contact that customer about the debt. Append-only: who, when, which
--       customer, which policy version. It is a record, not a legal conclusion.
--   customer_email_optouts
--       a customer's opt-out of Rekoda reminder email from ONE merchant, keyed by the SHA-256 of the
--       lower-cased address (never the address). Written by the signed link in the email.
--   invoice_reminders
--       one row per reminder asked for: channel, outcome, an accurate reason code when nothing was
--       sent, the balance it quoted, and the client idempotency key. Never deleted.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS public_contact_phone text,
  ADD COLUMN IF NOT EXISTS public_contact_approved_at timestamptz;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS reminders_stopped_at timestamptz;

CREATE TABLE IF NOT EXISTS reminder_attestations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id),
  customer_id         uuid NOT NULL,
  channel             text NOT NULL CHECK (channel IN ('email')),
  policy_version      text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 40),
  attested_by_user_id uuid NOT NULL REFERENCES users(id),
  attested_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminder_attestations_customer_fk
    FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id)
);
CREATE INDEX IF NOT EXISTS reminder_attestations_customer_ix
  ON reminder_attestations (business_id, customer_id, channel, attested_at DESC);

CREATE TABLE IF NOT EXISTS customer_email_optouts (
  business_id  uuid NOT NULL REFERENCES businesses(id),
  address_hash text NOT NULL CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  opted_out_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, address_hash)
);

CREATE TABLE IF NOT EXISTS invoice_reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id),
  invoice_id      uuid NOT NULL,
  customer_id     uuid,
  channel         text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  -- sending: the row was written before the provider was called, so a crash leaves it visible.
  -- uncertain: the provider may or may not have the message (timeout); never resent automatically.
  status          text NOT NULL CHECK (status IN ('sending', 'sent', 'blocked', 'failed', 'uncertain')),
  reason_code     text CHECK (reason_code IS NULL OR length(reason_code) <= 60),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  balance_k       bigint,
  attestation_id  uuid REFERENCES reminder_attestations(id),
  requested_by    uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CONSTRAINT invoice_reminders_invoice_fk
    FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id),
  CONSTRAINT invoice_reminders_customer_fk
    FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_reminders_idem_ux
  ON invoice_reminders (business_id, idempotency_key);
CREATE INDEX IF NOT EXISTS invoice_reminders_invoice_ix
  ON invoice_reminders (business_id, invoice_id, created_at DESC);

ALTER TABLE reminder_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reminder_attestations
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE customer_email_optouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_email_optouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_email_optouts
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE invoice_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_reminders
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- Attestations and reminders are evidence: written, never rewritten or deleted (a reminder row's
-- status moves forward while it is being sent, so it keeps UPDATE).
GRANT SELECT, INSERT ON reminder_attestations TO rekoda_app;
REVOKE UPDATE, DELETE ON reminder_attestations FROM rekoda_app;
REVOKE ALL ON reminder_attestations FROM rekoda_worker;

-- An opt-out can be repeated (it keeps its first moment) but is never lifted by the API role.
GRANT SELECT, INSERT ON customer_email_optouts TO rekoda_app;
REVOKE UPDATE, DELETE ON customer_email_optouts FROM rekoda_app;
REVOKE ALL ON customer_email_optouts FROM rekoda_worker;

GRANT SELECT, INSERT, UPDATE ON invoice_reminders TO rekoda_app;
REVOKE DELETE ON invoice_reminders FROM rekoda_app;
-- The scheduled sender (slice 2) is a worker job; it gets what it needs when it exists.
REVOKE ALL ON invoice_reminders FROM rekoda_worker;
