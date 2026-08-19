-- What the model understood, before anybody agrees to it (CG2, CG5).
--
-- A draft is not a document. Nothing here has a number, appears in the ledger,
-- or can be sent to a customer — it is the interpretation of one message,
-- waiting to be previewed and confirmed. Keeping it in its own table is what
-- makes CG5 possible: "no, 3 not 4" re-runs the draft, and an ISSUED document
-- is never mutated.
--
-- `command` holds tokenised content only (CUSTOMER_7K2, never a name), because
-- it is exactly what the model produced and the model was never shown one.
CREATE TABLE IF NOT EXISTS command_drafts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id             uuid NOT NULL REFERENCES businesses(id),
  conversation_message_id uuid NOT NULL REFERENCES conversation_messages(id),
  intent                  text NOT NULL,
  command                 jsonb NOT NULL,
  model                   text,
  -- pending: understood, not yet previewed or agreed
  -- superseded: a correction replaced it
  -- confirmed: the merchant agreed; the transaction engine takes it from here
  -- abandoned: the conversation moved on
  state                   text NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'superseded', 'confirmed', 'abandoned')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- One draft per message. The interpretation of a message is a property of that
-- message, so a job that runs twice — a reclaimed lock, a retried delivery —
-- must not produce two drafts and give the merchant two previews of one sale.
CREATE UNIQUE INDEX IF NOT EXISTS command_drafts_message_ux
  ON command_drafts (conversation_message_id);

-- "What is this merchant waiting to confirm right now?"
CREATE INDEX IF NOT EXISTS command_drafts_business_state_ix
  ON command_drafts (business_id, state);

ALTER TABLE command_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON command_drafts
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON command_drafts TO rekoda_app;
GRANT SELECT, INSERT, UPDATE ON command_drafts TO rekoda_worker;
