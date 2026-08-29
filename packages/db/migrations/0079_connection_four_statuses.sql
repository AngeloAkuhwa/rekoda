-- PaymentConnection: four independent statuses, additive and backfilled
-- (spec §17.1; P1, PR-051).
--
-- Today one blended `status` with nine values plus a separate `kyc_status`
-- — the exact DRIFT §17.1 names. The four axes are independent because
-- they FAIL independently: a connection can be operationally healthy and
-- commercially suspended, and blending them makes that state
-- unrepresentable. Canonically:
--
--   operational_status   can it technically transact right now
--   kyc_status           has the merchant been verified by the provider
--                        (already its own column since 0010 — kept)
--   commercial_status    is there an agreed commercial arrangement
--   compliance_status    is it permitted under Rekoda's own policy
--   production_enabled   DERIVED; all four must permit it
--
-- Additive: the blended `status` stays authoritative for every current
-- reader; the P1 slice cuts gating over to `production_enabled` in its
-- own PR, and only then does the blended column's meaning narrow.

ALTER TABLE payment_connections
  ADD COLUMN operational_status text NOT NULL DEFAULT 'NOT_CONFIGURED'
    CONSTRAINT pc_operational_enum CHECK (operational_status IN
      ('NOT_CONFIGURED', 'PENDING_SETUP', 'ACTIVE', 'SUSPENDED', 'FAILED', 'DISCONNECTED')),
  ADD COLUMN commercial_status text NOT NULL DEFAULT 'UNCONFIRMED'
    CONSTRAINT pc_commercial_enum CHECK (commercial_status IN
      ('UNCONFIRMED', 'AGREED', 'SUSPENDED')),
  ADD COLUMN compliance_status text NOT NULL DEFAULT 'PERMITTED'
    CONSTRAINT pc_compliance_enum CHECK (compliance_status IN
      ('PERMITTED', 'UNDER_REVIEW', 'BLOCKED'));

/* Derived, in the schema, so no writer can hold a stale copy: all four
 * must permit it (§17.1). */
ALTER TABLE payment_connections
  ADD COLUMN production_enabled boolean
    GENERATED ALWAYS AS (
      operational_status = 'ACTIVE'
      AND kyc_status IN ('verified', 'approved')
      AND commercial_status = 'AGREED'
      AND compliance_status = 'PERMITTED'
    ) STORED;

/* ── the backfill, from the blended vocabulary ──────────────────────────
 * Operational is what the blend mostly meant. Commercial: a merchant who
 * supplied their OWN provider key holds their own arrangement with the
 * provider — AGREED; platform arrangements stay UNCONFIRMED until the
 * §18 OPEN COMMERCIAL items close (owner decisions, W0). Compliance:
 * whatever Rekoda enabled, its policy permitted. */
UPDATE payment_connections SET
  operational_status = CASE
    WHEN status = 'active' THEN 'ACTIVE'
    WHEN status = 'suspended' THEN 'SUSPENDED'
    WHEN status = 'failed' THEN 'FAILED'
    WHEN status = 'disconnected' THEN 'DISCONNECTED'
    WHEN status = 'not_configured' THEN 'NOT_CONFIGURED'
    ELSE 'PENDING_SETUP'
  END,
  commercial_status = CASE
    WHEN key_mode = 'merchant_key' AND merchant_key_cipher IS NOT NULL THEN 'AGREED'
    ELSE 'UNCONFIRMED'
  END;

/* ── the gate (0064 pattern): nothing production-enabled today may lose
 * it to this backfill silently — an ACTIVE, verified, merchant-keyed
 * connection derives enabled. */
DO $$
DECLARE broken bigint;
BEGIN
  SELECT count(*) INTO broken FROM payment_connections
  WHERE status = 'active' AND kyc_status IN ('verified', 'approved')
    AND key_mode = 'merchant_key' AND merchant_key_cipher IS NOT NULL
    AND production_enabled IS DISTINCT FROM true;
  IF broken > 0 THEN
    RAISE EXCEPTION 'four-status backfill: % live merchant-keyed connections failed to derive production_enabled', broken;
  END IF;
END;
$$;
