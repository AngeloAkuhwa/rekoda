-- OD-49 (owner ruling, 11 Nov 2026, the PR #432 remediation brief §3): rows written before 0203
-- that Rekoda's plan durations would refuse are NOT rewritten, but they may not pass into the MVP
-- unnoticed and may not keep granting an entitlement.
--
--   1. `subscription_nonconformity(...)` is THE rule, in one place: given a row's plan fields it
--      names what is wrong with it, or returns NULL. Pure (no table read), so every runtime role
--      may call it; it is what the plan reader (`usageRepo.planFor`, the single gate every ingress
--      asks) and the release preflight both use.
--   2. `rekoda_private.subscription_conformance_report()` lists every non-conforming row, with whether
--      it is ACTIVE (it could grant something now) and the fixed reason code. Business id and plan
--      only: no name, phone or any other customer detail. Owner (migration/deploy role) only.
--   3. The deploy preflight (scripts/deploy-staging.sh, docs/runbooks/deploy.md) runs it after
--      the migration and before any service starts, and REFUSES to start the release while an
--      active row is listed. An operator corrects each one through the audited operator writer
--      (0207: the standard period, or `expired` with a reason); nothing here edits a row.
--
-- The rule (the same lengths as 0203 and `@rekoda/core`):
--   paid (chat, integrate, complete)  has an end, a cycle start, a known interval; the end is after
--                                     the start and no later than one interval after it, plus the
--                                     at most three days a month-end renewal anchor restores
--   trial                             has a start and an end; the end is no later than 14 days
--                                     after the start (one minute allowed: signups before 0203
--                                     took the end from the API host's clock)
--   expired                           no future end
-- Active: a paid or trial row (a paid plan keeps its allowances past its date until the grace
-- sweep lapses it, so it is active whatever its date), or any row with a future end; an old trial
-- whose end has passed is listed as history, not active.
--
-- Rollback: drop the two functions; nothing else changes. Re-running is safe.

CREATE OR REPLACE FUNCTION public.subscription_nonconformity(
  p_plan text,
  p_expires timestamptz,
  p_cycle_started timestamptz,
  p_interval text,
  p_trial_started timestamptz,
  p_now timestamptz
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_plan IN ('chat', 'integrate', 'complete') THEN CASE
      WHEN p_expires IS NULL THEN 'open_ended_paid_plan'
      WHEN p_cycle_started IS NULL THEN 'paid_plan_without_cycle_start'
      WHEN p_interval IS NULL OR p_interval NOT IN ('monthly', 'annual') THEN 'paid_plan_unknown_interval'
      WHEN p_expires <= p_cycle_started THEN 'paid_plan_ends_before_it_starts'
      WHEN p_expires > ((p_cycle_started AT TIME ZONE 'Africa/Lagos')
                        + CASE p_interval WHEN 'annual' THEN interval '12 months'
                                          ELSE interval '1 month' END)
                       AT TIME ZONE 'Africa/Lagos' + interval '3 days'
        THEN 'paid_plan_longer_than_its_interval'
    END
    WHEN p_plan = 'trial' THEN CASE
      WHEN p_trial_started IS NULL THEN 'trial_without_start'
      WHEN p_expires IS NULL THEN 'open_ended_trial'
      WHEN p_expires > p_trial_started + interval '336 hours' + interval '1 minute'
        THEN 'trial_longer_than_14_days'
    END
    WHEN p_plan = 'expired' THEN CASE
      WHEN p_expires > p_now THEN 'expired_plan_with_future_end'
    END
    ELSE 'unknown_plan'
  END
$$;

REVOKE ALL ON FUNCTION public.subscription_nonconformity(text, timestamptz, timestamptz, text, timestamptz, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscription_nonconformity(text, timestamptz, timestamptz, text, timestamptz, timestamptz)
  TO rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator;

CREATE OR REPLACE FUNCTION rekoda_private.subscription_conformance_report()
RETURNS TABLE (business_id uuid, plan text, reason text, active boolean)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT b.id, b.plan, r.reason,
         (b.plan IN ('chat', 'integrate', 'complete')
          OR (b.plan = 'trial' AND (b.plan_expires_at IS NULL OR b.plan_expires_at > now()))
          OR b.plan_expires_at > now()) AS active
  FROM public.businesses b
  CROSS JOIN LATERAL (
    SELECT public.subscription_nonconformity(b.plan, b.plan_expires_at, b.cycle_started_at,
             b.billing_interval, b.trial_started_at, now()) AS reason) r
  WHERE r.reason IS NOT NULL
  ORDER BY active DESC, b.id
$$;

REVOKE ALL ON FUNCTION rekoda_private.subscription_conformance_report() FROM PUBLIC;
