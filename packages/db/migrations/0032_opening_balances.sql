-- One opening entry per business, enforced by the database.
--
-- Opening balances say what a business was already holding on the day it
-- started with Rekoda: cash in the till, money in the bank, stock on the
-- shelf. Owner's equity has been in the chart since ADR 0004 and nothing has
-- ever posted to it, so until now every business came into existence with
-- nothing, and a merchant who spent from money they already had got a
-- negative cash balance on their own balance sheet.
--
-- The entry is a ledger posting like any other, which is why there is no new
-- table: the ledger already holds the figures, and a second copy of them
-- somewhere else would be a second answer to the same question.
--
-- What the ledger cannot express on its own is "only once". A partial unique
-- index does, and does it against a race rather than against a polite caller:
-- two requests arriving together both read no opening entry, both post, and
-- without this the business ends up holding its opening stock twice.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_tx_opening_ux
  ON ledger_transactions (business_id)
  WHERE source_type = 'opening';
