-- Account lifecycle enforcement (spec §11.4; F1, PR-035).
--
-- Three rules from the lifecycle table, each held by the database rather
-- than by whoever remembers them, plus the DELETE grant PR-029 withheld
-- until "no postings" was a question the schema could answer. It can now:
-- `ledger_entries.account_id` is NOT NULL (0065), so the FK itself refuses
-- deleting a posted account — the strictest row of §11.4's table costs no
-- trigger at all.

/* ── one ACTIVE account per role per scope ──────────────────────────────
 * The 0061 unique covered inactive rows too, which would have made §11.4's
 * mandatory-role replacement unrepresentable: the predecessor keeps its
 * role forever (identity is immutable), so the successor can only carry
 * the same role once uniqueness is scoped to the active chart. The engine
 * already resolves `accountByRole` over active rows only; the index now
 * states the same sentence. */
DROP INDEX accounts_role_scope_ux;
CREATE UNIQUE INDEX accounts_role_scope_ux
  ON accounts (business_id, system_role,
               coalesce(scope_payment_connection_id, scope_financial_account_id,
                        scope_business_id))
  WHERE system_role IS NOT NULL AND active;

/* ── post into it once inactive: refused ────────────────────────────────
 * Every ingress, every writer, one refusal. The FK already guarantees the
 * account exists; this guarantees it is still part of the working chart.
 * Historical entries are untouched — deactivation is why they can be. */
CREATE OR REPLACE FUNCTION ledger_refuse_inactive_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_active boolean;
BEGIN
  SELECT active INTO is_active
  FROM accounts
  WHERE business_id = NEW.business_id AND id = NEW.account_id;
  IF is_active IS FALSE THEN
    RAISE EXCEPTION 'account is deactivated: no new postings (spec %)', '11.4'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entry_inactive_account
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_refuse_inactive_account();

/* ── a mandatory role never loses its active account ────────────────────
 * The four roles the engine may rely on at any moment (core
 * MANDATORY_ROLES, all BUSINESS-scoped). DEFERRED so the legal shape — one
 * transaction that deactivates the predecessor AND installs the successor —
 * commits, while a deactivation or delete that leaves the role orphaned is
 * refused at the door it actually exits through: COMMIT. */
CREATE OR REPLACE FUNCTION accounts_refuse_orphaned_mandatory()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.system_role IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE',
                         'RETAINED_EARNINGS', 'VAT_PAYABLE')
     /* A business being erased whole (right to erasure, migration 0022)
      * takes its chart with it; a role belonging to nobody is not orphaned. */
     AND EXISTS (SELECT 1 FROM businesses b WHERE b.id = OLD.business_id)
     AND NOT EXISTS (
       SELECT 1 FROM accounts a
       WHERE a.business_id = OLD.business_id
         AND a.system_role = OLD.system_role
         AND a.scope_business_id = OLD.scope_business_id
         AND a.active
     )
  THEN
    RAISE EXCEPTION
      'mandatory role % needs an active account: configure a replacement first (spec %)',
      OLD.system_role, '11.4'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER accounts_mandatory_role_guard
  AFTER UPDATE OF active OR DELETE ON accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION accounts_refuse_orphaned_mandatory();

/* ── the unposted DELETE, at last (§11.4) ───────────────────────────────
 * The app may delete a chart row nobody ever posted into; the FK refuses
 * the rest, and the guard above refuses orphaning a mandatory role. The
 * worker keeps nothing: no sweep deletes chart rows. */
GRANT DELETE ON accounts TO rekoda_app;
