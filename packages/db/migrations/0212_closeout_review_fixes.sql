-- Independent review of PR #432 at fe9c3c5 (OWN-90 closeout round): the database half of the
-- findings that held.
--
--   1. The worker's queue and outbox writes are limited to the columns that coordinate them. With
--      UPDATE on every column it could rewrite any job's kind, payload and business (enqueue any
--      work for any business by recycling an old row) and any outbox event's payload.
--   2. A webhook delivery is queued only through `webhook_queue_delivery(outbox event, endpoint)`,
--      which copies the type, payload and business from the outbox row and only for an active
--      endpoint of that same business. With INSERT and UPDATE on every column the worker could
--      queue a forged, correctly signed webhook (an "invoice.paid" that never happened) to any
--      merchant's endpoint. Its direct writes are now the delivery's progress columns only.
--   3. The release preflight (0208) also flags a trial or paid cycle whose start is in the future
--      (the second-trial pattern 0207 closed) and treats an unknown plan as active, and the paid
--      bound is the standard end itself: one interval after the cycle start, or, when the start was
--      a month's clamped last day (an anchor beyond it), the last day of the target month. Before,
--      any end up to the last day of the target month passed, almost two periods for a cycle that
--      started on the 1st.
--   4. The retention deletion locks the business before it reads the notice, so a notice cleared
--      and re-stamped meanwhile cannot slip through on the 30-day test.
--   5. An application-opened charge must also have no unapplied or blocked review text.
--
-- Rollback: none past 0196 (OWN-86); applied with the api and worker stopped. Re-running is safe.

-- 1. The queue and the outbox: coordination columns only.
REVOKE UPDATE ON jobs FROM rekoda_worker;
GRANT UPDATE (state, attempts, run_at, locked_at, locked_by, last_error, failure_category, updated_at)
  ON jobs TO rekoda_worker;
REVOKE UPDATE ON outbox_events FROM rekoda_worker;
GRANT UPDATE (dispatched_at, attempts, last_error, locked_at, next_attempt_at)
  ON outbox_events TO rekoda_worker;

-- 2. Webhook deliveries: queued from the outbox row itself; the worker records only progress.
REVOKE INSERT, UPDATE ON webhook_deliveries FROM rekoda_worker;
GRANT UPDATE (status, attempts, next_attempt_at, last_status, last_error, delivered_at, locked_at)
  ON webhook_deliveries TO rekoda_worker;

CREATE OR REPLACE FUNCTION public.webhook_queue_delivery(p_outbox_event uuid, p_endpoint uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.webhook_deliveries (business_id, endpoint_id, outbox_event_id, event_type, payload)
  SELECT o.business_id, e.id, o.id, o.type, o.payload
  FROM public.outbox_events o
  JOIN public.webhook_endpoints e ON e.business_id = o.business_id
  WHERE o.id = p_outbox_event AND e.id = p_endpoint AND e.status = 'active'
  ON CONFLICT (endpoint_id, outbox_event_id) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION public.webhook_queue_delivery(uuid, uuid) FROM PUBLIC, rekoda_app;
GRANT EXECUTE ON FUNCTION public.webhook_queue_delivery(uuid, uuid) TO rekoda_worker;

-- 3. The preflight rule.
CREATE OR REPLACE FUNCTION rekoda_private.paid_period_bound(p_start timestamptz, p_interval text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    -- A start on a month's last day may be an anchor (29th to 31st) clamped into a short month:
    -- its renewal lands on the anchor day, up to the target month's last day.
    WHEN (p_start AT TIME ZONE 'Africa/Lagos')::date
         = (date_trunc('month', p_start AT TIME ZONE 'Africa/Lagos') + interval '1 month - 1 day')::date
    THEN ((date_trunc('month', (p_start AT TIME ZONE 'Africa/Lagos')
             + CASE p_interval WHEN 'monthly' THEN interval '1 month'
                               WHEN 'annual' THEN interval '12 months' END)
           + interval '1 month - 1 day')::date
          + ((p_start AT TIME ZONE 'Africa/Lagos')::time)) AT TIME ZONE 'Africa/Lagos'
    ELSE rekoda_private.add_billing_interval(p_start, p_interval)
  END
$$;

CREATE OR REPLACE FUNCTION rekoda_private.subscription_period_violation(
  p_plan text,
  p_expires timestamptz,
  p_cycle_start timestamptz,
  p_interval text,
  p_trial_start timestamptz,
  p_now timestamptz
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_trial_start IS NOT NULL AND p_trial_start > p_now + interval '1 minute'
      THEN 'trial_starts_in_future'
    WHEN p_plan IN ('chat', 'integrate', 'complete') THEN
      CASE
        WHEN p_expires IS NULL THEN 'paid_open_ended'
        WHEN p_cycle_start IS NULL THEN 'paid_no_cycle_start'
        WHEN p_interval IS NULL OR p_interval NOT IN ('monthly', 'annual') THEN 'paid_unknown_interval'
        WHEN p_cycle_start > p_now + interval '1 minute' THEN 'paid_cycle_starts_in_future'
        WHEN p_expires <= p_cycle_start THEN 'paid_ends_before_start'
        WHEN p_expires > rekoda_private.paid_period_bound(p_cycle_start, p_interval) + interval '1 minute'
          THEN 'paid_longer_than_interval'
      END
    WHEN p_plan = 'trial' THEN
      CASE
        WHEN p_expires IS NULL THEN 'trial_open_ended'
        WHEN p_expires > p_trial_start + interval '336 hours' + interval '1 minute'
          THEN 'trial_longer_than_14_days'
      END
    WHEN p_plan = 'expired' THEN
      CASE WHEN p_expires IS NOT NULL AND p_expires > p_now THEN 'expired_future_end' END
    ELSE 'unknown_plan'
  END
$$;

CREATE OR REPLACE FUNCTION rekoda_private.subscription_period_preflight(
  p_now timestamptz DEFAULT now()
) RETURNS TABLE (
  business_id uuid,
  plan text,
  status text,
  reason text,
  plan_expires_at timestamptz,
  cycle_started_at timestamptz,
  billing_interval text,
  trial_started_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT b.id, b.plan::text,
         CASE WHEN b.plan NOT IN ('chat', 'integrate', 'complete', 'trial', 'expired') THEN 'active'
              WHEN v.reason = 'trial_starts_in_future' THEN 'active'
              WHEN b.plan IN ('chat', 'integrate', 'complete', 'trial')
                   AND (b.plan_expires_at IS NULL OR b.plan_expires_at > p_now)
              THEN 'active' ELSE 'inactive' END,
         v.reason, b.plan_expires_at, b.cycle_started_at, b.billing_interval::text,
         b.trial_started_at
  FROM public.businesses b
  CROSS JOIN LATERAL (
    SELECT rekoda_private.subscription_period_violation(
      b.plan::text, b.plan_expires_at, b.cycle_started_at, b.billing_interval::text,
      b.trial_started_at, p_now) AS reason) v
  WHERE v.reason IS NOT NULL
  ORDER BY 3, b.id
$$;

REVOKE ALL ON FUNCTION rekoda_private.paid_period_bound(timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rekoda_private.subscription_period_violation(text, timestamptz, timestamptz, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION rekoda_private.subscription_period_preflight(timestamptz) FROM PUBLIC;

-- 4. Retention: the notice is read under the business lock.
CREATE OR REPLACE FUNCTION public.retention_delete_business(
  target uuid,
  cutoff timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  -- core RETENTION (packages/core/src/retention.ts): abandonedTrialDays 90, noticeDays 30.
  v_ended_by timestamptz := now() - interval '90 days';
  v_warned_by timestamptz := now() - interval '30 days';
  v_warned boolean;
BEGIN
  SELECT (b.retention_notified_at IS NOT NULL AND b.retention_notified_at <= v_warned_by)
    INTO v_warned
  FROM public.businesses b WHERE b.id = target
  FOR UPDATE OF b;
  IF v_warned IS NOT TRUE THEN
    RETURN -1;
  END IF;
  RETURN public.retention_delete_business_unchecked(target, least(cutoff, v_ended_by));
END $$;

REVOKE ALL ON FUNCTION public.retention_delete_business(uuid, timestamptz) FROM PUBLIC, rekoda_app;
GRANT EXECUTE ON FUNCTION public.retention_delete_business(uuid, timestamptz) TO rekoda_worker;

-- 5. The pristine-insert rule of 0209, with the review text included.
CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_settlement_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RETURN NEW;
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.priced_at := coalesce(NEW.priced_at, NEW.created_at);
    IF NEW.priced_at > NEW.created_at + interval '1 minute'
       OR NEW.priced_at < NEW.created_at - interval '5 minutes' THEN
      RAISE EXCEPTION 'a charge is priced at most five minutes before it is opened (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    IF current_user = 'rekoda_settlement' THEN
      RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM 'pending'
       OR NEW.paid_at IS NOT NULL OR NEW.paid_amount_k IS NOT NULL
       OR NEW.provider_reference IS NOT NULL OR NEW.provider_paid_at IS NOT NULL
       OR NEW.provider_settled_at IS NOT NULL OR NEW.units_credited_at IS NOT NULL
       OR NEW.failed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL
       OR NEW.refunded_at IS NOT NULL OR coalesce(NEW.refunded_amount_k, 0) <> 0
       OR NEW.applied_period_start IS NOT NULL OR NEW.applied_period_end IS NOT NULL
       OR NEW.checkout_url IS NOT NULL OR NEW.checkout_started_at IS NOT NULL
       OR NEW.superseded_at IS NOT NULL OR NEW.abandoned_at IS NOT NULL
       OR NEW.unapplied_at IS NOT NULL OR NEW.unapplied_reason IS NOT NULL
       OR NEW.unapplied_resolved_at IS NOT NULL OR NEW.unapplied_resolution IS NOT NULL
       OR NEW.unapplied_resolved_by IS NOT NULL
       OR NEW.blocked_resolved_by IS NOT NULL OR NEW.blocked_resolution IS NOT NULL
       OR NEW.blocked_at IS NOT NULL OR NEW.blocked_reason IS NOT NULL
       OR NEW.blocked_resolved_at IS NOT NULL OR NEW.blocked_close_failed_at IS NOT NULL THEN
      RAISE EXCEPTION 'the application opens only a new pending charge; settlement records the rest (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF current_user = 'rekoda_settlement'
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    IF NEW.priced_at IS DISTINCT FROM OLD.priced_at
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'what a charge buys is set when it is opened (OD-37)' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.plan IS DISTINCT FROM OLD.plan
     OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.amount_k IS DISTINCT FROM OLD.amount_k
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.priced_at IS DISTINCT FROM OLD.priced_at THEN
    RAISE EXCEPTION 'what a charge buys is set when it is opened (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'paid' AND NEW.status = 'refunded') THEN
    RAISE EXCEPTION 'only settlement moves a charge''s status, apart from a refund (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.paid_at IS DISTINCT FROM OLD.paid_at
     OR NEW.paid_amount_k IS DISTINCT FROM OLD.paid_amount_k
     OR NEW.provider_paid_at IS DISTINCT FROM OLD.provider_paid_at
     OR NEW.provider_settled_at IS DISTINCT FROM OLD.provider_settled_at
     OR NEW.units_credited_at IS DISTINCT FROM OLD.units_credited_at THEN
    RAISE EXCEPTION 'only settlement records a payment on a charge (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('paid', 'refunded')
     AND ((OLD.unapplied_at IS NOT NULL AND NEW.unapplied_at IS NULL)
          OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL)) THEN
    RAISE EXCEPTION 'a paid charge set aside cannot be put back (OD-37)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_settlement_guard() FROM PUBLIC;
