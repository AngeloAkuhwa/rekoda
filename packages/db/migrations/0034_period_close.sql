-- Closing a month, enforced by the database rather than by a screen.
--
-- The statement PDF is meant to be handed to a bank, a landlord or a grant
-- officer. Nothing has stopped a posting landing in a month that was already
-- reported: an expense carries the day it was paid, a recurring entry carries
-- the day it fell due, and opening balances carry the merchant's own date. So
-- a figure somebody sent out in September could change in October, and
-- neither copy would say so.
--
-- The watermark is one period rather than a list of closed ones. Closing is
-- monotonic, "closed through August" is a fact a merchant can hold in their
-- head, and reopening is then one visible act rather than a set operation
-- nobody can picture. The history of who closed and reopened what lives in
-- audit_events, which is already the answer to that question.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS books_closed_through text;

COMMENT ON COLUMN businesses.books_closed_through IS
  'Lagos period (YYYY-MM) through which the books are closed. Null means open.';

-- The refusal, at the only place every posting passes through.
--
-- A check the writer is trusted to make is exactly the weaker thing this
-- exists to replace: a caller that forgets, a writer added later, or a hand
-- typed statement would all walk straight past it. The trigger cannot be
-- walked past.
--
-- Invoker rights on purpose. Every tenant table is under FORCE ROW LEVEL
-- SECURITY, so a definer-rights function owned by the table owner would be
-- filtered like any other caller and return nothing while looking like it
-- worked (see 0002_identity.sql). It does not need definer rights anyway:
-- ledger_transactions carries WITH CHECK (business_id = app.business_id), so
-- an insert that reached this trigger was necessarily made under a pin equal
-- to NEW.business_id, which is exactly the row the businesses policy admits.
--
-- Lagos is UTC+1 all year with no daylight saving, so the month a posting
-- falls in never turns on an hour.
CREATE OR REPLACE FUNCTION ledger_refuse_closed_period()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  closed_through text;
  falls_in       text;
BEGIN
  SELECT b.books_closed_through INTO closed_through
  FROM businesses b
  WHERE b.id = NEW.business_id;

  IF closed_through IS NULL THEN
    RETURN NEW;
  END IF;

  falls_in := to_char(NEW.created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM');

  IF falls_in <= closed_through THEN
    RAISE EXCEPTION
      'books are closed through % and this entry falls in %',
      closed_through, falls_in
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ledger_tx_period_closed ON ledger_transactions;
CREATE TRIGGER ledger_tx_period_closed
  BEFORE INSERT ON ledger_transactions
  FOR EACH ROW
  EXECUTE FUNCTION ledger_refuse_closed_period();

-- The entries too. They carry their own created_at, stamped from the same
-- occurredAt, and a transaction inside an open month whose entries were
-- dated into a closed one would report exactly the movement this prevents.
DROP TRIGGER IF EXISTS ledger_entry_period_closed ON ledger_entries;
CREATE TRIGGER ledger_entry_period_closed
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_refuse_closed_period();
