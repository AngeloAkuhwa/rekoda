-- Journal invariant triggers (spec §10; F1, PR-039).
--
-- The application validates first, because a good error message reaches the
-- caller as something they can act on (`assertBalanced`, in core, refuses
-- before a row exists). PostgreSQL enforces the same rules AGAIN, because
-- the trigger catches the writer nobody has thought of yet. With this
-- migration every row of §10's table is held by the database:
--
--   at least two lines per entry            deferred triggers, below
--   exactly one of debit/credit non-zero    CHECK, below
--   debits equal credits, functional only   deferred trigger, below
--   every line shares the entry's business  composite FK, below
--   the account is active                   0066
--   the accounting period is open           0034/0067
--   the currency is valid for the business  trigger, below
--   functional coherent with transaction    trigger, below (same-currency;
--                                           the cross-currency tolerance
--                                           ships with the first FX writer)
--   FX snapshot exists when currencies differ   0069

/* ── exactly one side per line (§10 row 2) ──────────────────────────────
 * Gate first, 0064-style: a constraint that fails half-added tells nobody
 * anything. The estate cannot contain a violating row — assertBalanced has
 * refused both-sides and zero postings since the first builder — but
 * "cannot" is what gates are for. */
DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM ledger_entries
  WHERE (debit_k = 0) = (credit_k = 0);
  IF bad > 0 THEN
    RAISE EXCEPTION 'journal invariants: % existing lines are zero or two-sided; repair before constraining', bad;
  END IF;
END;
$$;

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_one_sided CHECK ((debit_k = 0) <> (credit_k = 0));

/* ── every line shares the entry's business (§10 row 4) ─────────────────
 * As a FOREIGN KEY, not a trigger: an entry citing another tenant's
 * transaction becomes unrepresentable, the same shape as the account FK
 * from 0063. The plain transaction_id FK stays for its cascade paths. */
ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_tx_business_id_ux UNIQUE (business_id, id);
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_tx_business_fk
  FOREIGN KEY (business_id, transaction_id)
  REFERENCES ledger_transactions (business_id, id);

/* ── the currency is valid for the business (§10 row 7) ─────────────────
 * §16's invariant: JournalEntry.functionalCurrency = Business.currency.
 * Invoker rights, the 0034 reasoning: the inserting transaction is pinned
 * to NEW.business_id, exactly the row the businesses policy admits. */
CREATE OR REPLACE FUNCTION ledger_tx_currency_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE bc char(3);
BEGIN
  SELECT b.currency INTO bc FROM businesses b WHERE b.id = NEW.business_id;
  IF NEW.functional_currency IS DISTINCT FROM bc THEN
    RAISE EXCEPTION
      'functional currency % is not the business currency % (spec %)',
      NEW.functional_currency, bc, '16'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_tx_currency_valid
  BEFORE INSERT ON ledger_transactions
  FOR EACH ROW
  EXECUTE FUNCTION ledger_tx_currency_valid();

/* ── functional coherent with transaction (§10 row 8) ───────────────────
 * Same currency: the transaction amount IS the functional amount, to the
 * kobo. Cross-currency: the snapshot requirement (0069) already gates;
 * the numeric tolerance rule ships with the first writer that can post
 * one, because a tolerance nobody exercises is a rule nobody has proved. */
CREATE OR REPLACE FUNCTION ledger_entry_amount_coherent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE fc char(3);
BEGIN
  SELECT t.functional_currency INTO fc
  FROM ledger_transactions t
  WHERE t.id = NEW.transaction_id AND t.business_id = NEW.business_id;
  IF NEW.transaction_currency = fc
     AND NEW.transaction_amount_minor <> NEW.debit_k + NEW.credit_k THEN
    RAISE EXCEPTION
      'same-currency line: transaction amount % must equal its functional amount % (spec %)',
      NEW.transaction_amount_minor, NEW.debit_k + NEW.credit_k, '10'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entry_amount_coherent
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_entry_amount_coherent();

/* ── at least two lines, and they balance (§10 rows 1 and 3) ────────────
 * DEFERRED to commit, because the lines of one entry arrive as separate
 * rows and a rule checked mid-flight would refuse every legal posting.
 * The balance sums FUNCTIONAL amounts only — debit_k and credit_k — and
 * must never see a transaction amount (§16): a multi-currency entry
 * balances in the books' own currency or not at all. */
CREATE OR REPLACE FUNCTION ledger_entry_shape_at_commit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  n bigint;
  d bigint;
  c bigint;
BEGIN
  SELECT count(*), COALESCE(sum(debit_k), 0), COALESCE(sum(credit_k), 0)
  INTO n, d, c
  FROM ledger_entries
  WHERE business_id = NEW.business_id AND transaction_id = NEW.transaction_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % has % line(s): at least two (spec %)',
      NEW.transaction_id, n, '10'
      USING ERRCODE = 'check_violation';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'journal entry % does not balance: % debit vs % credit, functional kobo (spec %)',
      NEW.transaction_id, d, c, '10'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entry_shape
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION ledger_entry_shape_at_commit();

/* An entry with NO lines never fires the trigger above, so the entry side
 * asks the same question: by commit, my lines exist and there are at least
 * two. Together they close both directions. */
CREATE OR REPLACE FUNCTION ledger_tx_has_lines_at_commit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM ledger_entries
  WHERE business_id = NEW.business_id AND transaction_id = NEW.id;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % has % line(s): at least two (spec %)',
      NEW.id, n, '10'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_tx_has_lines
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION ledger_tx_has_lines_at_commit();
