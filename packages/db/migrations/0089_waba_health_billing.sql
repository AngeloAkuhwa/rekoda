-- Connection health and billing mode (spec §24; W1/W2, PR-062 — the
-- slice's last PR; production enablement still waits on W0).
--
-- Health: the sends themselves are the health check. A successful send on
-- the connection touches `last_healthy_at` (0084's column) and recovers an
-- UNHEALTHY connection; a failed one records WHY here, so "UNHEALTHY" is
-- never a bare adjective the merchant has to guess about.
ALTER TABLE waba_connections
  ADD COLUMN health_reason text;

-- Billing mode: W0's confirmation is a DATA change (owner decision 2), and
-- a data change that alters unit economics is not a bare UPDATE — it is an
-- auditable act. WHEN it was confirmed and BY WHOM travel with the mode.
ALTER TABLE waba_connections
  ADD COLUMN billing_mode_confirmed_at timestamptz,
  ADD COLUMN billing_mode_confirmed_by text;

/* The estate precedes the constraint: every existing connection is
 * UNCONFIRMED (0084's default, and W0 has not happened), so the gate
 * counts rather than migrates — 0064 discipline. */
DO $$
DECLARE stray bigint;
BEGIN
  SELECT count(*) INTO stray FROM waba_connections
  WHERE billing_mode <> 'UNCONFIRMED';
  IF stray > 0 THEN
    RAISE EXCEPTION 'cannot install the confirmation audit: % confirmed rows precede it', stray;
  END IF;
END;
$$;

/* A confirmed mode without its audit trail — or an audit trail on an
 * unconfirmed mode — is unrepresentable. The W0 change arrives through
 * `confirmBillingMode`, which supplies both or neither. */
ALTER TABLE waba_connections
  ADD CONSTRAINT waba_billing_mode_audited CHECK (
    (billing_mode = 'UNCONFIRMED'
      AND billing_mode_confirmed_at IS NULL
      AND billing_mode_confirmed_by IS NULL)
    OR (billing_mode <> 'UNCONFIRMED'
      AND billing_mode_confirmed_at IS NOT NULL
      AND billing_mode_confirmed_by IS NOT NULL)
  );
