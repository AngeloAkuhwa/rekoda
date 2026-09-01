-- Group E's remainder: the platform-cost subledger's tenant-owned references
-- (remediation R1 ruling 1; A was 0132, B 0133, C 0134, D 0135, the WABA edge
-- 0138). This closes ruling 1.
--
-- `platform_cost_events` is not an ordinary tenant table and the difference is
-- the whole problem. `business_id` is NULLABLE by design, and 0107 says why:
-- "some costs are not attributable to one merchant (hosting, a platform OTP,
-- a global rate-limit probe)". So the usual reasoning does not carry over.
--
-- MATCH FULL was proposed for these and it does not work. It rejects ANY row
-- mixing null and non-null key values, which includes (business_id present,
-- payment_id absent) -- the shape of every cost row attributed to a merchant
-- but not to one payment. Applied, it fails eight margin tests.
--
-- MATCH SIMPLE alone does not work either, and this is the part worth being
-- exact about. It skips the check when EITHER column is null, so
-- (business_id NULL, payment_id = another merchant's payment) is not checked
-- at all: a row could name a payment while claiming to be unattributed, and
-- that is precisely the row the margin model must never see.
--
-- So: MATCH SIMPLE for the reference, and a CHECK that closes the hole MATCH
-- SIMPLE leaves. Naming a tenant-owned row REQUIRES saying whose it is; the
-- foreign key then has both halves and is always checked. Together they are
-- MATCH FULL's guarantee without MATCH FULL's false rejection:
--
--   (null,     null)  allowed, unchanged: an unattributed platform cost
--   (business, null)  allowed, unchanged: attributed, not payment-specific
--   (null,     row )  REFUSED by the CHECK      <- the hole
--   (business, row )  REFUSED by the FK if the row is another tenant's
--
-- Three columns, not two. All three parents already expose a unique key on
-- (business_id, id): `payments` and `settlements` as table constraints,
-- `payment_connections` as a plain unique index, which PostgreSQL accepts as
-- a foreign-key target just the same. Nothing had to be added.
--
-- `cost_schedule_id` is deliberately excluded: `provider_cost_schedules` has
-- no `business_id`. It is platform reference data with no tenant to carry, so
-- a single-column key is the correct and complete statement about it.
--
-- Existing rows verified against all four propositions before adding.
ALTER TABLE platform_cost_events
  ADD CONSTRAINT platform_cost_events_payment_attributed_ck
  CHECK (payment_id IS NULL OR business_id IS NOT NULL);
ALTER TABLE platform_cost_events
  ADD CONSTRAINT platform_cost_events_payment_business_fk
  FOREIGN KEY (business_id, payment_id) REFERENCES payments (business_id, id) NOT VALID;
ALTER TABLE platform_cost_events VALIDATE CONSTRAINT platform_cost_events_payment_business_fk;
ALTER TABLE platform_cost_events DROP CONSTRAINT platform_cost_events_payment_id_fkey;

ALTER TABLE platform_cost_events
  ADD CONSTRAINT platform_cost_events_settlement_attributed_ck
  CHECK (settlement_id IS NULL OR business_id IS NOT NULL);
ALTER TABLE platform_cost_events
  ADD CONSTRAINT platform_cost_events_settlement_business_fk
  FOREIGN KEY (business_id, settlement_id) REFERENCES settlements (business_id, id) NOT VALID;
ALTER TABLE platform_cost_events VALIDATE CONSTRAINT platform_cost_events_settlement_business_fk;
ALTER TABLE platform_cost_events DROP CONSTRAINT platform_cost_events_settlement_id_fkey;

ALTER TABLE platform_cost_events
  ADD CONSTRAINT platform_cost_events_connection_attributed_ck
  CHECK (payment_connection_id IS NULL OR business_id IS NOT NULL);
ALTER TABLE platform_cost_events
  ADD CONSTRAINT platform_cost_events_connection_business_fk
  FOREIGN KEY (business_id, payment_connection_id) REFERENCES payment_connections (business_id, id) NOT VALID;
ALTER TABLE platform_cost_events VALIDATE CONSTRAINT platform_cost_events_connection_business_fk;
ALTER TABLE platform_cost_events DROP CONSTRAINT platform_cost_events_payment_connection_id_fkey;
