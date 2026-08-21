-- Self-service billing's storage (ADR 0024).
--
-- Two things were missing before M4 could persist anything: where a paid
-- merchant's cycle lives, and where the money Rekoda charges is recorded.
--
-- `plan_expires_at` answers the first and is REUSED rather than joined by a
-- second date. It has always meant "when the current plan period ends"; on a
-- trial that is a hard stop and on a paid plan it is the renewal. One column
-- with one meaning cannot disagree with itself, and `businesses_plan_expiry_ix`
-- from 0017 already indexes exactly the sweep's question. `planFor` continues
-- to expire ONLY trials, so a paid merchant whose renewal job is late keeps
-- working.

ALTER TABLE businesses
  -- The proration denominator. Without it an upgrade cannot say what fraction
  -- of a cycle is left, only when it ends.
  ADD COLUMN IF NOT EXISTS cycle_started_at timestamptz,
  -- The day of the month renewals anchor to, so 31 January renews on 28
  -- February and then RETURNS to 31 March instead of walking backwards a few
  -- days every short month.
  ADD COLUMN IF NOT EXISTS renewal_anchor_day smallint
    CHECK (renewal_anchor_day IS NULL OR renewal_anchor_day BETWEEN 1 AND 31),
  -- The grace clock. Set when a renewal charge fails, cleared when one
  -- succeeds. Seven days from here, reminders on days 1 and 5 (ADR 0024).
  ADD COLUMN IF NOT EXISTS payment_failed_at timestamptz,
  -- A downgrade takes effect at the next renewal, so the plan the merchant
  -- chose has to wait somewhere. Null means renew onto the same plan.
  ADD COLUMN IF NOT EXISTS pending_plan text;

-- The grace sweep asks "who failed, and how long ago", which names no tenant.
CREATE INDEX IF NOT EXISTS businesses_payment_failed_ix
  ON businesses (payment_failed_at)
  WHERE payment_failed_at IS NOT NULL;

-- ── what Rekoda charged, and for what ───────────────────────────────────────
--
-- Deliberately NOT in `payments` or `payment_intents`. Those are the
-- merchant's books: money their customers paid them, which posts to their
-- ledger. A subscription charge is money the merchant paid US. Putting it in
-- their books would inflate their revenue with our revenue, and no accountant
-- would forgive that.
--
-- Nothing here posts to `ledger_transactions` for the same reason. It is an
-- expense of the business in real life, but recording it automatically would
-- mean Rekoda deciding what appears in a merchant's profit and loss without
-- being asked.
CREATE TABLE IF NOT EXISTS subscription_charges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id),
  -- The same vocabulary `planChangeKind` uses, plus the two non-plan lines.
  kind                text NOT NULL CHECK (kind IN (
                        'first_purchase', 'renewal', 'upgrade', 'add_on', 'seat')),
  -- The plan being paid for. Null on an add-on pack, which buys capacity
  -- against whatever plan is current.
  plan                text,
  -- The add-on pack's id, from core's ADD_ON_PACKS. Null on a plan charge.
  pack_id             text,
  quantity            integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- Kobo, like every other amount in this database. Zero is legal: a
  -- downgrade records the fact without taking money.
  amount_k            bigint NOT NULL CHECK (amount_k >= 0),
  currency            text NOT NULL DEFAULT 'NGN',
  status              text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  provider            text NOT NULL DEFAULT 'paystack',
  -- Ours, and globally unique for the same reason `payment_intents.reference`
  -- is: a provider callback names the reference before the tenant is known.
  reference           text NOT NULL,
  provider_reference  text,
  -- The cycle this charge buys. An add-on buys the calendar month it lands in.
  period_start        timestamptz,
  period_end          timestamptz,
  failure_reason      text,
  refunded_amount_k   bigint NOT NULL DEFAULT 0 CHECK (refunded_amount_k >= 0),
  paid_at             timestamptz,
  failed_at           timestamptz,
  refunded_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (refunded_amount_k <= amount_k)
);

CREATE UNIQUE INDEX IF NOT EXISTS subscription_charges_reference_ux
  ON subscription_charges (reference);

CREATE UNIQUE INDEX IF NOT EXISTS subscription_charges_provider_ref_ux
  ON subscription_charges (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- One subscription charge per business per cycle. This is what stops a
-- renewal sweep that runs twice, or two workers that both claim the same
-- business, from billing a merchant twice for one month: the second INSERT is
-- rejected by the database rather than by a check somebody has to remember.
-- Upgrades are excluded, because a merchant may legitimately move up more
-- than once inside one cycle.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_charges_cycle_ux
  ON subscription_charges (business_id, period_start)
  WHERE kind IN ('first_purchase', 'renewal');

CREATE INDEX IF NOT EXISTS subscription_charges_business_ix
  ON subscription_charges (business_id, created_at DESC);

ALTER TABLE subscription_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscription_charges
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- Resolution is pre-tenant here exactly as it is for `payment_intents`: a
-- provider webhook names a reference, and which business it belongs to is the
-- answer rather than the input. SELECT only, and only for the worker.
CREATE POLICY worker_resolve ON subscription_charges
  FOR SELECT
  TO rekoda_worker
  USING (true);

GRANT SELECT, INSERT, UPDATE ON subscription_charges TO rekoda_app;
GRANT SELECT, INSERT, UPDATE ON subscription_charges TO rekoda_worker;

-- Never deleted. A charge that turned out to be wrong is refunded, which is a
-- status and an amount, not the removal of the fact that it happened.
REVOKE DELETE ON subscription_charges FROM rekoda_app;
REVOKE DELETE ON subscription_charges FROM rekoda_worker;
