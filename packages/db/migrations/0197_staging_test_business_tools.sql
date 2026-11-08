-- G-119 / OWN-77 (PR B item 6): staging-only, test-business-only date moves and one-shot send
-- faults, so the blocked acceptance steps (walkthrough 17, 18, 19, 22; ACCEPT-01 2, 3, 9, 10) can be
-- run on staging without improvised SQL.
--
-- Fail-closed in two layers. The API refuses unless REKODA_STAGING_TOOLS=1, the Paystack key is a
-- TEST key and the §47 confirmation is unset (apps/api/src/health/staging-tools.*). This migration is
-- the database layer: nothing below acts unless
--   * the database carries the staging marker (`staging_environment`, one row, written by the
--     database OWNER on the staging host only; no application role can write it), and
--   * the business is designated a test business (`staging_test_businesses`).
-- On production neither exists, so even a mis-set flag moves nothing.
--
-- A date move goes through `staging_move_date`, a SECURITY DEFINER function owned by
-- `rekoda_plan_writer` (0196): the OD-37 sanctioned path for `plan_expires_at`. It checks the marker,
-- the designation, the field against the plan, a compare-before value and 90-day bounds, then writes
-- the change and its append-only audit row in one statement. A revert is the same function moving
-- the value back only if it still holds what the move wrote (compare-and-revert).
--
-- Rollback: a normal release rollback keeps these tables; the older code ignores them. To remove
-- the tools from a staging database by hand (owner): DELETE FROM staging_environment;

-- The marker. One row or none; only the owner writes it.
CREATE TABLE IF NOT EXISTS staging_environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by text NOT NULL,
  note text
);
REVOKE ALL ON staging_environment FROM PUBLIC, rekoda_app, rekoda_worker;
GRANT SELECT ON staging_environment TO rekoda_app, rekoda_worker, rekoda_plan_writer;

-- Which businesses the tools may touch. Designated through the tools themselves (audited), never
-- undesignated by the application.
CREATE TABLE IF NOT EXISTS staging_test_businesses (
  business_id uuid PRIMARY KEY REFERENCES businesses(id),
  designated_at timestamptz NOT NULL DEFAULT now(),
  designated_by text NOT NULL,
  reason text NOT NULL
);
ALTER TABLE staging_test_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging_test_businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staging_test_businesses
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
REVOKE ALL ON staging_test_businesses FROM rekoda_app, rekoda_worker;
GRANT SELECT, INSERT ON staging_test_businesses TO rekoda_app;
GRANT SELECT ON staging_test_businesses TO rekoda_plan_writer;

-- Every action, append-only: operator, business, field, before, after, reason, time, outcome.
CREATE TABLE IF NOT EXISTS staging_tool_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  operator text NOT NULL,
  action text NOT NULL CHECK (action IN ('designate', 'move_date', 'revert_date', 'arm_fault',
                                         'consume_fault')),
  field text CHECK (field IS NULL OR field IN ('trial_end', 'paid_to', 'grace_clock',
                                               'send_timeout', 'sender_refused')),
  before_value timestamptz,
  after_value timestamptz,
  reason text NOT NULL,
  outcome text NOT NULL,
  reverts_action_id uuid REFERENCES staging_tool_actions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS staging_tool_actions_one_revert_ux
  ON staging_tool_actions (reverts_action_id) WHERE reverts_action_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS staging_tool_actions_business_ix
  ON staging_tool_actions (business_id, created_at);
ALTER TABLE staging_tool_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging_tool_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staging_tool_actions
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
REVOKE ALL ON staging_tool_actions FROM rekoda_app, rekoda_worker;
GRANT SELECT, INSERT ON staging_tool_actions TO rekoda_app, rekoda_plan_writer;

-- One-shot send faults: armed by an operator, consumed by exactly one send for that business.
CREATE TABLE IF NOT EXISTS staging_send_faults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  kind text NOT NULL CHECK (kind IN ('send_timeout', 'sender_refused')),
  armed_at timestamptz NOT NULL DEFAULT now(),
  armed_by text NOT NULL,
  consumed_at timestamptz
);
-- At most one armed fault per business at a time.
CREATE UNIQUE INDEX IF NOT EXISTS staging_send_faults_one_armed_ux
  ON staging_send_faults (business_id) WHERE consumed_at IS NULL;
ALTER TABLE staging_send_faults ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging_send_faults FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staging_send_faults
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
REVOKE ALL ON staging_send_faults FROM rekoda_app, rekoda_worker;
GRANT SELECT, INSERT ON staging_send_faults TO rekoda_app;
GRANT UPDATE (consumed_at) ON staging_send_faults TO rekoda_app;

-- The plan writer moves the grace clock too (not a guarded column, but one audited path for every
-- date the acceptance steps need).
GRANT UPDATE (payment_failed_at) ON businesses TO rekoda_plan_writer;

CREATE OR REPLACE FUNCTION public.staging_move_date(
  p_business uuid,
  p_field text,
  p_expected timestamptz,
  p_new timestamptz,
  p_operator text,
  p_reason text,
  p_reverts uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_plan text;
  v_current timestamptz;
  v_action uuid;
  v_revert record;
BEGIN
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'staging_move_date: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staging_environment) THEN
    RAISE EXCEPTION 'staging_move_date: this database is not marked as staging' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staging_test_businesses WHERE business_id = p_business) THEN
    RAISE EXCEPTION 'staging_move_date: not a designated test business' USING ERRCODE = '42501';
  END IF;
  IF p_operator IS NULL OR length(p_operator) < 3 OR p_reason IS NULL OR length(p_reason) < 4 THEN
    RAISE EXCEPTION 'staging_move_date: operator and reason are required' USING ERRCODE = '22023';
  END IF;

  SELECT plan,
         CASE WHEN p_field IN ('trial_end', 'paid_to') THEN plan_expires_at ELSE payment_failed_at END
    INTO v_plan, v_current
    FROM public.businesses WHERE id = p_business FOR UPDATE;

  IF p_field = 'trial_end' AND v_plan IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION 'staging_move_date: trial_end needs a business on its trial' USING ERRCODE = '22023';
  ELSIF p_field = 'paid_to' AND (v_plan IN ('trial', 'expired') OR v_current IS NULL) THEN
    RAISE EXCEPTION 'staging_move_date: paid_to needs a dated paid plan' USING ERRCODE = '22023';
  ELSIF p_field = 'grace_clock' AND v_current IS NULL THEN
    RAISE EXCEPTION 'staging_move_date: grace_clock needs a renewal in grace' USING ERRCODE = '22023';
  ELSIF p_field NOT IN ('trial_end', 'paid_to', 'grace_clock') THEN
    RAISE EXCEPTION 'staging_move_date: unknown field' USING ERRCODE = '22023';
  END IF;

  IF v_current IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'staging_move_date: the value changed since it was read' USING ERRCODE = '40001';
  END IF;

  IF p_reverts IS NULL THEN
    IF p_new IS NULL OR p_new < now() - interval '90 days' OR p_new > now() + interval '90 days' THEN
      RAISE EXCEPTION 'staging_move_date: the new value must be within 90 days of now'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    -- A revert puts back exactly what a move of this business replaced, once.
    SELECT * INTO v_revert FROM public.staging_tool_actions
     WHERE id = p_reverts AND business_id = p_business AND action = 'move_date';
    IF NOT FOUND OR v_revert.field IS DISTINCT FROM p_field
       OR v_revert.after_value IS DISTINCT FROM p_expected
       OR v_revert.before_value IS DISTINCT FROM p_new THEN
      RAISE EXCEPTION 'staging_move_date: not a revert of that move' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_field = 'grace_clock' THEN
    UPDATE public.businesses SET payment_failed_at = p_new WHERE id = p_business;
  ELSE
    UPDATE public.businesses SET plan_expires_at = p_new WHERE id = p_business;
  END IF;

  INSERT INTO public.staging_tool_actions
    (business_id, operator, action, field, before_value, after_value, reason, outcome,
     reverts_action_id)
  VALUES (p_business, p_operator, CASE WHEN p_reverts IS NULL THEN 'move_date' ELSE 'revert_date' END,
          p_field, v_current, p_new, p_reason, 'applied', p_reverts)
  RETURNING id INTO v_action;
  RETURN v_action;
END $$;

ALTER FUNCTION public.staging_move_date(uuid, text, timestamptz, timestamptz, text, text, uuid)
  OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.staging_move_date(uuid, text, timestamptz, timestamptz, text, text, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staging_move_date(uuid, text, timestamptz, timestamptz, text, text, uuid)
  TO rekoda_app;
