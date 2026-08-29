-- Append-only allocations with the full-reversal constraint (spec §14.2;
-- F1, PR-049).
--
-- Payment allocations and credit applications are append-only. V1 uses ONE
-- FULL REVERSAL ROW, never a mutable or deleted allocation: "at most one
-- reversal" combined with partial amounts would strand the remainder
-- permanently and silently, so a partial change of mind is a full reversal
-- followed by a fresh allocation of the correct amount.
--
-- The rules, held by trigger on BOTH tables:
--   reversal.amount   = −original.amount, EXACTLY
--   reversal.payment  = original.payment (or customer credit)
--   reversal.invoice  = original.invoice
--   reversal.currency = original.currency
--   reversal.reason   required
--   original.reversal_of_id IS NULL       — cannot reverse a reversal
--   UNIQUE (business_id, reversal_of_id)  — a full reversal happens once

/* payment_allocations predates §14.2's shape: it gains the columns. The
 * currency default states the truth of all history; source columns stay
 * NULL on history and are demanded by the trigger on reversal rows. */
ALTER TABLE payment_allocations
  ADD COLUMN currency char(3) NOT NULL DEFAULT 'NGN'
    CONSTRAINT payment_allocations_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN reversal_of_id uuid REFERENCES payment_allocations (id),
  ADD COLUMN reason text,
  ADD COLUMN source_type text,
  ADD COLUMN source_id text;

ALTER TABLE payment_allocations
  ADD CONSTRAINT payment_allocations_amount_nonzero CHECK (amount_k <> 0);

CREATE UNIQUE INDEX payment_allocations_reversal_once_ux
  ON payment_allocations (business_id, reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;

CREATE UNIQUE INDEX credit_applications_reversal_once_ux
  ON customer_credit_applications (business_id, reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;

/* Append-only, at the privilege layer: no runtime role rewrites how money
 * answered an obligation. */
REVOKE UPDATE, DELETE ON payment_allocations FROM rekoda_app;
REVOKE UPDATE, DELETE ON payment_allocations FROM rekoda_worker;

/* ── the reversal-shape trigger, once per table ─────────────────────────*/
CREATE OR REPLACE FUNCTION payment_allocation_reversal_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE original payment_allocations%ROWTYPE;
BEGIN
  IF NEW.reversal_of_id IS NULL THEN
    IF NEW.amount_k < 0 THEN
      RAISE EXCEPTION 'a negative allocation must be a reversal row (spec %)', '14.2'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO original FROM payment_allocations
  WHERE id = NEW.reversal_of_id AND business_id = NEW.business_id;
  IF original.id IS NULL THEN
    RAISE EXCEPTION 'reversal cites no allocation of this business (spec %)', '14.2'
      USING ERRCODE = 'check_violation';
  END IF;
  IF original.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'cannot reverse a reversal (spec %)', '14.2'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_k <> -original.amount_k THEN
    RAISE EXCEPTION 'reversal must negate % exactly, got % (spec %)',
      original.amount_k, NEW.amount_k, '14.2'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.payment_id <> original.payment_id OR NEW.invoice_id <> original.invoice_id
     OR NEW.currency <> original.currency THEN
    RAISE EXCEPTION 'reversal must mirror the original payment, invoice and currency (spec %)', '14.2'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reason IS NULL OR NEW.source_type IS NULL OR NEW.source_id IS NULL THEN
    RAISE EXCEPTION 'a reversal carries reason, sourceType and sourceId (spec %)', '14.2'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_allocation_reversal_shape
  BEFORE INSERT ON payment_allocations
  FOR EACH ROW
  EXECUTE FUNCTION payment_allocation_reversal_valid();

CREATE OR REPLACE FUNCTION credit_application_reversal_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE original customer_credit_applications%ROWTYPE;
BEGIN
  IF NEW.reversal_of_id IS NULL THEN
    IF NEW.amount_minor < 0 THEN
      RAISE EXCEPTION 'a negative application must be a reversal row (spec %)', '14.2'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO original FROM customer_credit_applications
  WHERE id = NEW.reversal_of_id AND business_id = NEW.business_id;
  IF original.id IS NULL THEN
    RAISE EXCEPTION 'reversal cites no application of this business (spec %)', '14.2'
      USING ERRCODE = 'check_violation';
  END IF;
  IF original.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'cannot reverse a reversal (spec %)', '14.2'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_minor <> -original.amount_minor THEN
    RAISE EXCEPTION 'reversal must negate % exactly, got % (spec %)',
      original.amount_minor, NEW.amount_minor, '14.2'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.customer_credit_id <> original.customer_credit_id
     OR NEW.invoice_id <> original.invoice_id OR NEW.currency <> original.currency THEN
    RAISE EXCEPTION 'reversal must mirror the original credit, invoice and currency (spec %)', '14.2'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reason IS NULL THEN
    RAISE EXCEPTION 'a reversal carries a reason (spec %)', '14.2'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credit_application_reversal_shape
  BEFORE INSERT ON customer_credit_applications
  FOR EACH ROW
  EXECUTE FUNCTION credit_application_reversal_valid();
