-- Reporting read layer (dashboard overview + cash flow).
--
-- The ledger has always been the source of truth (ADR 0004, ADR 0015); what
-- it lacked was a way to be READ by period without scanning every entry a
-- business has ever written. One business-leading composite fixes that for
-- the overview ("this month") and the cash-flow series (last N months) alike.
--
-- Business-leading, as everywhere: an index that does not start with
-- business_id cannot serve a query RLS will allow.
CREATE INDEX IF NOT EXISTS ledger_entries_business_created_ix
  ON ledger_entries (business_id, created_at);
