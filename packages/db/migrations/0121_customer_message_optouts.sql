-- A merchant's CUSTOMER may stop the messages (PR-135).
--
-- Rekoda already had STOP, and it was the wrong STOP for this: it lives on
-- `users.opted_out_at`, keyed by a verified phone number, and it governs
-- what REKODA sends a MERCHANT. A customer on a merchant's WABA is neither
-- of those things. Reusing that column would have been wrong twice: it
-- would need the customer's raw number to key it, and a customer who also
-- happens to run their own Rekoda shop would silence their own books by
-- asking a shop to stop texting them.
--
-- So this is a separate fact, and it is keyed the way every other
-- per-customer fact in the estate is keyed (waba_service_windows,
-- away_assistant_replies): the participant BLIND INDEX, scoped to the
-- business and the WABA number the conversation happens on. No raw phone
-- number is stored, and the same person reaching two merchants is two
-- unrelated rows, which is the property the two-level index exists to
-- protect.
--
-- One row per participant, updated in place: `opted_out_at` set by STOP,
-- NULL by START, `updated_at` recording when the state last moved. That is
-- the auditable transition without keeping a word anybody said.

CREATE TABLE customer_message_optouts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses(id),
  -- The WABA phone number id the thread belongs to: the same scope the
  -- blind index was computed under, so a key is only ever compared with
  -- one built the same way.
  channel_account_id text NOT NULL,
  -- The blind index the thread routes by, never a raw number (F.3/F.4).
  customer_hash      text NOT NULL,
  index_key_version  text NOT NULL,
  -- NULL means "may be messaged". Set = the moment they asked to stop.
  opted_out_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_message_optouts_ux
    UNIQUE (business_id, channel_account_id, customer_hash, index_key_version)
);

-- Reading this is a per-send question, on the hot path of every customer
-- message; the unique constraint above is the index that answers it.

-- 0001's ALTER DEFAULT PRIVILEGES already granted both application roles
-- full DML on every new table, so what they must NOT hold needs a REVOKE
-- rather than the absence of a GRANT. A consent record is not something
-- an application process may delete: START clears the timestamp, it does
-- not erase that the person ever asked.
REVOKE DELETE ON customer_message_optouts FROM rekoda_app;
REVOKE DELETE ON customer_message_optouts FROM rekoda_worker;

ALTER TABLE customer_message_optouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_message_optouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_message_optouts
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
