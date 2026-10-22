-- G-115 (OWN-33, owner ruling 22 Oct 2026 "Option B"): whether a paid cycle
-- may be prorated automatically depends on WHO created it, not on how long it
-- is. A cycle bought through the provider's approved monthly flow prorates; an
-- operator-defined arrangement (complimentary, manual, custom length) goes to
-- support review, even at 30 days.
--
-- Nothing durable said which it was: the operator's `plan_changed` audit row
-- and a paid charge each hint at it, but neither is a property of the CURRENT
-- cycle. This column is that property, written by the one subscription-state
-- writer together with the cycle itself.
--   'provider' - the current cycle was applied by a settled provider charge
--   'operator' - the current cycle was set by an authorised operator
--   NULL       - unknown (a historical row whose origin cannot be proved, or
--                an unpaid plan); every consumer treats it as support review.
ALTER TABLE businesses
  ADD COLUMN subscription_origin text
  CHECK (subscription_origin IN ('provider', 'operator'));

-- Conservative backfill from persisted evidence only. For a business on a paid
-- plan, the most recent of (a) a settled charge for the CURRENT plan and (b) an
-- operator plan_changed row naming the current plan decides. An identical operator
-- re-post (same plan and expiry) is not counted: it kept the cycle's origin. Anything else
-- stays NULL (unknown) rather than being guessed from duration or expiry.
UPDATE businesses b
SET subscription_origin = ev.origin
FROM (
  SELECT b2.id AS business_id,
    CASE
      WHEN a.at IS NULL AND c.at IS NOT NULL THEN 'provider'
      WHEN c.at IS NULL AND a.at IS NOT NULL THEN 'operator'
      WHEN c.at > a.at THEN 'provider'
      WHEN a.at >= c.at THEN 'operator'
    END AS origin
  FROM businesses b2
  LEFT JOIN LATERAL (
    SELECT max(coalesce(sc.paid_at, sc.created_at)) AS at
    FROM subscription_charges sc
    WHERE sc.business_id = b2.id AND sc.status = 'paid'
      -- an upgrade never creates a cycle (it keeps the dates and the origin), so it is
      -- not evidence of who created one; before OWN-34 it could settle on an operator cycle
      AND sc.kind IN ('first_purchase', 'renewal')
      AND sc.plan = b2.plan
      -- a paid charge whose plan change was refused (G-104) never created this cycle
      AND sc.superseded_at IS NULL AND sc.unapplied_at IS NULL
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT max(ae.created_at) AS at
    FROM audit_events ae
    WHERE ae.business_id = b2.id AND ae.action = 'plan_changed'
      AND ae.source_type = 'operator'
      AND ae.new_value ->> 'plan' = b2.plan
      -- an identical re-post (same plan, same dated expiry) kept the cycle and its
      -- origin (setPlan), so it is not evidence that an operator created it
      AND NOT (ae.new_value ->> 'expiresAt' IS NOT NULL
               AND ae.old_value ->> 'plan' IS NOT DISTINCT FROM ae.new_value ->> 'plan'
               AND ae.old_value ->> 'expiresAt' IS NOT DISTINCT FROM ae.new_value ->> 'expiresAt')
  ) a ON true
  WHERE b2.plan NOT IN ('trial', 'expired')
) ev
WHERE b.id = ev.business_id AND ev.origin IS NOT NULL;
