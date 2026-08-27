-- The JournalDraft pair (spec §9.1; F1, PR-041).
--
-- Two table pairs, EDITABLE and AUTHORITATIVE. The authoritative pair
-- (`ledger_transactions` / `ledger_entries`) has no mutable lifecycle
-- state and never will: existence IS posted. The editable pair lands here.
-- A draft is a proposal — its lines cite chart accounts directly, it may
-- be edited and discarded freely — and posting is `validate → atomic
-- INSERT → immutable forever` (§9.2), with `posted_journal_id` recording
-- WHICH immutable entry a draft became. That column is UNIQUE where set: a
-- draft posts once. The read-only lock on posted drafts is PR-042's
-- trigger; until then the column is the fact, not yet the fence.

CREATE TABLE journal_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses (id),
  memo               text NOT NULL,
  created_by         text NOT NULL,
  posted_journal_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT journal_drafts_business_id_ux UNIQUE (business_id, id),
  /* The posted entry is this tenant's own (0070 gave the target). */
  CONSTRAINT journal_drafts_posted_fk
    FOREIGN KEY (business_id, posted_journal_id)
    REFERENCES ledger_transactions (business_id, id)
);

/* §9.5: postedJournalId UNIQUE, nullable. */
CREATE UNIQUE INDEX journal_drafts_posted_ux
  ON journal_drafts (posted_journal_id)
  WHERE posted_journal_id IS NOT NULL;

CREATE INDEX journal_drafts_business_ix ON journal_drafts (business_id);

CREATE TABLE journal_draft_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses (id),
  draft_id     uuid NOT NULL,
  account_id   uuid NOT NULL,
  debit_k      bigint NOT NULL DEFAULT 0,
  credit_k     bigint NOT NULL DEFAULT 0,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),

  /* Editable does not mean lawless: a draft line still cannot cite another
   * tenant's draft or account. */
  CONSTRAINT journal_draft_lines_draft_fk
    FOREIGN KEY (business_id, draft_id)
    REFERENCES journal_drafts (business_id, id) ON DELETE CASCADE,
  CONSTRAINT journal_draft_lines_account_fk
    FOREIGN KEY (business_id, account_id)
    REFERENCES accounts (business_id, id)
);

CREATE INDEX journal_draft_lines_draft_ix ON journal_draft_lines (draft_id);

ALTER TABLE journal_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_drafts
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE journal_draft_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_draft_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_draft_lines
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* The worker never authors or edits proposals. */
REVOKE INSERT, UPDATE, DELETE ON journal_drafts FROM rekoda_worker;
REVOKE INSERT, UPDATE, DELETE ON journal_draft_lines FROM rekoda_worker;
