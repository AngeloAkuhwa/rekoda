-- Independent review of the PR #432 remediation (B-2, IMPORTANT): every column that records who
-- acted on an operator item follows the operator-actor contract.
--
-- 0233 and 0235 enforce `operator:<subject>` (a subject of 1 to 255 printable characters, exactly as
-- `auditActorOf` produces it) in the requeue and refund functions. The other actor columns PR #432
-- added had no rule at all, and the application credential writes most of them directly:
--   dead_job_exceptions.recovery_requested_by   an operator's recovery (0194)
--   dead_job_exceptions.closed_by               an operator's resolution, or system:recovery (0194)
--   subscription_charges.blocked_resolved_by    an operator's or a sweep's close (0195)
--   subscription_charges.unapplied_resolved_by  an operator's resolution (main; checked NOT VALID)
--   staging_test_businesses.designated_by,
--   staging_send_faults.armed_by                the staging tools (0197), operator only
--   staging_tool_actions.operator               an operator, or system:send consuming a fault
-- A malformed actor (`alice`, a space, a newline, 256 characters) is now refused. A system actor is
-- `system:<name>` with a lower-case name, as every system writer in the code spells it.
--
-- What this does NOT do (OD-54): a holder of the application credential can still write a
-- WELL-FORMED operator actor of its choosing into these columns and into audit_events, because the
-- API process, not the database, verifies the operator's identity on app-plane routes. Moving those
-- writes to the operator process is the owner decision recorded as OD-54.
--
-- `unapplied_resolved_by` exists on main, so its constraint is added NOT VALID: rows already on
-- staging are not re-checked (a deploy must not fail on test history); every new write is.
-- Not a compatibility break: the release's writers produce only these forms. Re-running is safe.

DO $$
DECLARE
  operator_only constant text := '^operator:[!-~]{1,255}$';
  operator_or_system constant text := '^(operator:[!-~]{1,255}|system:[a-z][a-z_-]{0,63})$';
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
      ('dead_job_exceptions', 'recovery_requested_by', operator_only, true),
      ('dead_job_exceptions', 'closed_by', operator_or_system, true),
      ('subscription_charges', 'blocked_resolved_by', operator_or_system, true),
      ('subscription_charges', 'unapplied_resolved_by', operator_or_system, false),
      ('staging_test_businesses', 'designated_by', operator_only, true),
      ('staging_tool_actions', 'operator', operator_or_system, true),
      ('staging_send_faults', 'armed_by', operator_only, true)
    ) AS v(tbl, col, pattern, validate)
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', c.tbl, c.tbl || '_' || c.col || '_actor');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I ~ %L)%s',
                   c.tbl, c.tbl || '_' || c.col || '_actor', c.col, c.col, c.pattern,
                   CASE WHEN c.validate THEN '' ELSE ' NOT VALID' END);
  END LOOP;
END $$;
