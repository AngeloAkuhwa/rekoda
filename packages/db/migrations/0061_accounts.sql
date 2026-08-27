-- The chart of accounts becomes rows (spec §8, §11; PR-029; F1 begins).
--
-- Today the chart is a seventeen-key TypeScript constant and
-- `ledger_entries.account` is a text key into it. This migration gives every
-- business a real `accounts` table with SCOPED SYSTEM ROLES: the engine
-- resolves a role within a scope, never a name, because renaming an account
-- is something merchants do.
--
-- Typed scope columns rather than one polymorphic id, because a polymorphic
-- id cannot be a foreign key at all, and a trigger that checks existence is
-- a foreign key somebody has to remember to write (§11.1). Each scope FK is
-- composite on (business_id, id), so a scope belonging to another tenant is
-- unrepresentable.
--
-- ADDITIVE ONLY. No writer changes here: seeding is PR-030, the
-- ledger_entries.account_id linkage is PR-031, and the backfill PR-032.

/* ── FinancialAccount ─────────────────────────────────────────────────────
 * Where money physically sits: a bank account, a till, a provider
 * settlement pocket. §11.2 scopes BANK and CASH to one of these — a till IS
 * a financial account — and B1 (PR-073) extends this table with connection
 * identity. Minimal here because the scope FK needs a real referent, and a
 * column pointing at a table that does not exist is not a design.          */
CREATE TABLE IF NOT EXISTS financial_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  kind         text NOT NULL CHECK (kind IN ('bank', 'till', 'provider_settlement')),
  label        text NOT NULL CHECK (length(btrim(label)) > 0),
  currency     char(3) NOT NULL DEFAULT 'NGN',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  /* The composite target every scope FK aims at. */
  CONSTRAINT financial_accounts_business_id_ux UNIQUE (business_id, id)
);

ALTER TABLE financial_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON financial_accounts
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- The usual 0001 default-privileges correction. A place money sat is
-- history: deactivate it, never erase it.
REVOKE DELETE ON financial_accounts FROM rekoda_app;
REVOKE DELETE ON financial_accounts FROM rekoda_worker;

/* payment_connections needs a composite unique target for the same FK
 * shape. The primary key already makes id unique; the pair is what lets the
 * FK carry the tenant. */
CREATE UNIQUE INDEX IF NOT EXISTS payment_connections_business_id_ux
  ON payment_connections (business_id, id);

/* ── Account ──────────────────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  /* Display code, the merchant-visible ordering key. Unique per business. */
  code         text NOT NULL CHECK (length(btrim(code)) > 0),
  /* The merchant's own name for it. Renameable, which is exactly why the
   * engine never resolves by it. */
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  type         text NOT NULL
                 CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  /* Presentation only: a contra account renders negative beneath what it
   * reduces (accumulated depreciation under equipment). */
  contra       boolean NOT NULL DEFAULT false,

  /* ── the scoped system role (§11.1–11.3) ── */
  system_role        text,
  system_scope_type  text
                       CHECK (system_scope_type IN
                         ('BUSINESS', 'PAYMENT_CONNECTION', 'FINANCIAL_ACCOUNT')),
  scope_business_id            uuid,
  scope_payment_connection_id  uuid,
  scope_financial_account_id   uuid,

  active         boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT accounts_business_id_ux UNIQUE (business_id, id),
  CONSTRAINT accounts_code_ux UNIQUE (business_id, code),
  CONSTRAINT accounts_active_together CHECK (active = (deactivated_at IS NULL)),

  /* All-or-none (§11.3): a role, its scope type and exactly one scope
   * column are set together, or none of them is. */
  CONSTRAINT accounts_scope_all_or_none CHECK (
    (system_role IS NULL AND system_scope_type IS NULL
      AND scope_business_id IS NULL
      AND scope_payment_connection_id IS NULL
      AND scope_financial_account_id IS NULL)
    OR
    (system_role IS NOT NULL AND system_scope_type IS NOT NULL
      AND (CASE WHEN scope_business_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN scope_payment_connection_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN scope_financial_account_id IS NOT NULL THEN 1 ELSE 0 END) = 1)
  ),

  /* The set scope column is the one the scope type names. */
  CONSTRAINT accounts_scope_column_matches CHECK (
    system_scope_type IS NULL
    OR (system_scope_type = 'BUSINESS' AND scope_business_id IS NOT NULL)
    OR (system_scope_type = 'PAYMENT_CONNECTION' AND scope_payment_connection_id IS NOT NULL)
    OR (system_scope_type = 'FINANCIAL_ACCOUNT' AND scope_financial_account_id IS NOT NULL)
  ),

  /* A BUSINESS scope can only be this business: anything else would be a
   * cross-tenant reference wearing a valid FK. */
  CONSTRAINT accounts_scope_business_self CHECK (
    scope_business_id IS NULL OR scope_business_id = business_id
  ),

  /* §11.2 as a CHECK: ACCOUNTS_RECEIVABLE scoped to a payment connection is
   * unrepresentable rather than merely wrong. Mirrors ROLE_SCOPE in
   * @rekoda/core/chart, and the integration suite asserts the two agree. */
  CONSTRAINT accounts_role_scope_compatible CHECK (
    system_role IS NULL OR (system_role, system_scope_type) IN (
      ('ACCOUNTS_RECEIVABLE', 'BUSINESS'),
      ('ACCOUNTS_PAYABLE', 'BUSINESS'),
      ('RETAINED_EARNINGS', 'BUSINESS'),
      ('CONTRACT_LIABILITY', 'BUSINESS'),
      ('CUSTOMER_CREDIT', 'BUSINESS'),
      ('OWNER_EQUITY', 'BUSINESS'),
      ('OPENING_BALANCE_EQUITY', 'BUSINESS'),
      ('SALES_REVENUE', 'BUSINESS'),
      ('SALES_RETURNS', 'BUSINESS'),
      ('INVENTORY_ASSET', 'BUSINESS'),
      ('COGS', 'BUSINESS'),
      ('PAYMENT_PROCESSING_FEES', 'BUSINESS'),
      ('OPERATING_EXPENSES', 'BUSINESS'),
      ('DEPRECIATION', 'BUSINESS'),
      ('VAT_PAYABLE', 'BUSINESS'),
      ('INPUT_VAT_RECOVERABLE', 'BUSINESS'),
      ('WITHHOLDING_RECEIVABLE', 'BUSINESS'),
      ('PAYMENT_PROVIDER_CLEARING', 'PAYMENT_CONNECTION'),
      ('PROVIDER_CHARGEBACK_PAYABLE', 'PAYMENT_CONNECTION'),
      ('BANK', 'FINANCIAL_ACCOUNT'),
      ('CASH', 'FINANCIAL_ACCOUNT')
    )
  ),

  /* Tenant-safe composite FKs (§11.1): the referenced scope exists, is of
   * the expected type, and belongs to the same business — as a FOREIGN KEY,
   * not a trigger somebody has to remember. */
  CONSTRAINT accounts_scope_connection_fk
    FOREIGN KEY (business_id, scope_payment_connection_id)
    REFERENCES payment_connections (business_id, id),
  CONSTRAINT accounts_scope_financial_fk
    FOREIGN KEY (business_id, scope_financial_account_id)
    REFERENCES financial_accounts (business_id, id)
);

/* One account per role per scope (§11.3). Exactly one scope column is set,
 * so coalescing them yields the scope's identity whichever kind it is. */
CREATE UNIQUE INDEX accounts_role_scope_ux
  ON accounts (business_id, system_role,
               coalesce(scope_payment_connection_id, scope_financial_account_id,
                        scope_business_id))
  WHERE system_role IS NOT NULL;

CREATE INDEX accounts_business_active_ix ON accounts (business_id) WHERE active;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounts
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* DELETE is nobody's until PR-035 builds the postings-aware lifecycle:
 * `ledger_entries.account_id` does not exist yet (PR-031), so "no postings"
 * is a question the database cannot answer today, and the safe reading of
 * an unanswerable question is the strict one. §11.4's unposted-delete
 * arrives with the lifecycle PR. */
REVOKE DELETE ON accounts FROM rekoda_app;
REVOKE DELETE ON accounts FROM rekoda_worker;

/* ── role and scope are SET ONCE (§11.4: refused, always) ─────────────────
 * The same shape as payments_initial_source_set_once (migration 0058): the
 * trigger catches the writer nobody has thought of yet, and there is no
 * flag that bypasses it. Name and code stay editable; identity does not. */
CREATE OR REPLACE FUNCTION accounts_role_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.system_role IS DISTINCT FROM OLD.system_role
     OR NEW.system_scope_type IS DISTINCT FROM OLD.system_scope_type
     OR NEW.scope_business_id IS DISTINCT FROM OLD.scope_business_id
     OR NEW.scope_payment_connection_id IS DISTINCT FROM OLD.scope_payment_connection_id
     OR NEW.scope_financial_account_id IS DISTINCT FROM OLD.scope_financial_account_id
  THEN
    RAISE EXCEPTION 'accounts.system_role and its scope are immutable (spec %)', '11.4'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION 'accounts.type is immutable: statement placement is not editable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_role_set_once
  BEFORE UPDATE ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION accounts_role_immutable();
