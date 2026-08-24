-- The bank-feed background sweep's worklist (fix-plan 4 G5 follow-through).
--
-- "Which businesses have a linked feed" is cross-tenant by nature, exactly
-- like the margin report and the graduation view: the sweep asking does not
-- know which tenants to ask about. Same policy shape as 0019 and 0048, and
-- FOR SELECT only for the same reason -- every sync the sweep performs runs
-- back through withBusiness under the tenant's own pin.
CREATE POLICY sweep_read_bank_feeds ON bank_feed_connections
  FOR SELECT
  TO rekoda_worker
  USING (true);
