-- OD-40 (PR B item 1): three separate times on a Rekoda charge.
--
--   provider_paid_at     when Paystack says the payment happened: the `paid_at` of the
--                        server-side verify response that settled the charge. Never the
--                        webhook's receipt time and never a time a webhook body claimed.
--   provider_settled_at  when Paystack confirmed the money settled. Nullable, and nothing
--                        writes it yet: Rekoda has no settlement feed for its own platform
--                        account, and a time is only recorded from verified evidence.
--   units_credited_at    when Rekoda committed the units a pack bought: the database time of
--                        the transaction that credited them, set in that transaction. A plan
--                        charge credits no units and keeps it null.
--
-- `paid_at` keeps its meaning (when Rekoda recorded the payment) and `payments.settled_at`
-- (the merchant's own payments) is untouched. Unit crediting, and the month a pack counts
-- toward, do not change.
--
-- No backfill. A historical `provider_paid_at` could only come from the stored signed event,
-- whose payload is sealed (privacy/payload-vault.ts) and so cannot be read in SQL; and no
-- per-credit record of a pack's units exists (usage_counters keeps a running total), so a
-- historical `units_credited_at` has no evidence either. Inferring either from `paid_at`
-- would be a guess presented as a fact, so every existing row stays null.
--
-- Each column is written once: the writers update only while the column is null
-- (subscriptionsRepo.settleCharge, markUnitsCredited), so a replay never overwrites it.
--
-- Rollback: a normal release rollback (docs/runbooks/deploy.md) keeps these columns; the older
-- code ignores them. The columns hold payment evidence, so they are not dropped by a manual
-- rollback either.

ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS provider_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS units_credited_at timestamptz;

COMMENT ON COLUMN subscription_charges.provider_paid_at IS
  'OD-40: Paystack''s verified paid_at for the settling payment; null when verify gave none. Written once.';
COMMENT ON COLUMN subscription_charges.provider_settled_at IS
  'OD-40: Paystack''s confirmed settlement time; null until verified settlement evidence exists.';
COMMENT ON COLUMN subscription_charges.units_credited_at IS
  'OD-40: database time of the transaction that credited a pack''s units; null for plan charges. Written once.';
