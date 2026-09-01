-- Four status columns become closed sets (remediation R1, ruling 3).
--
-- `invoices.status`, `orders.status`, `expenses.status` and
-- `reconciliations.status` are plain `text` with nothing but a default. A typo
-- in a writer, or a value retired in code and left behind in a row, is stored
-- without complaint and then read by every report that filters on it. On
-- invoices that is money: the ageing, the receivables total and the four
-- statements all read `status IN ('issued', 'partially_paid')`, so a status
-- the readers do not recognise silently leaves a debt out of the books.
--
-- The ruling was explicit that these sets must not be guessed from the column
-- comments, and it was right not to trust them: three of the four comments
-- were WRONG, and this migration's companion commit corrects them.
--
--   invoices         comment said 4, omitted `credited` (issue.ts:1210)
--   orders           comment said 4, and named `paid`, which nothing writes.
--                    The real set is 7: three inserts and four transitions
--   reconciliations  comment said 4, including `UNMATCHED`, which is dead —
--                    it survives only in prose, never as a value
--   expenses         comment was correct
--
-- Each set below was derived from the WRITERS, then checked against the Zod
-- contracts, the TypeScript unions and the fixtures. The evidence is written
-- up in docs/audits/status-enum-evidence-2026-09-01.md, and
-- status-drift.integration.test.ts keeps these constraints and that evidence
-- in agreement from here on.
--
-- No `NOT VALID` and no separate `VALIDATE`: there is no deployed database
-- carrying rows these sets would reject, and a constraint that has never been
-- validated is a constraint nobody can rely on.

-- issued -> partially_paid -> paid, plus two terminal states.
-- `credited` is set by issueCreditNote when the credit reaches the total.
ALTER TABLE invoices ADD CONSTRAINT invoices_status_ck CHECK (
  status IN ('issued', 'partially_paid', 'paid', 'voided', 'credited'));

-- Three ways in — a customer order is `placed`, a quote is `quoted`, a
-- purchase order is `open` — and four ways on, each written by `markOrder`
-- with the expected current status in its WHERE.
ALTER TABLE orders ADD CONSTRAINT orders_status_ck CHECK (
  status IN ('placed', 'quoted', 'open', 'confirmed', 'cancelled', 'received', 'validated'));

ALTER TABLE expenses ADD CONSTRAINT expenses_status_ck CHECK (
  status IN ('recorded', 'voided'));

-- Upper case, unlike the other three, because these come straight from the
-- core's ReconciliationOutcome union and are stored as the engine names them.
ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_status_ck CHECK (
  status IN ('MATCHED', 'PARTIAL', 'EXCEPTION'));
