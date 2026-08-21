-- What every merchant costs to serve, readable at last.
--
-- `usage_events` has recorded provider cost per business since metering
-- shipped, and nothing has ever read it. The question it answers is
-- cross-tenant by nature: "which merchants cost more than they pay" cannot be
-- asked one pinned tenant at a time, because the operator asking does not
-- know which tenants to ask about.
--
-- ── what these policies do and do not change ────────────────────────────────
-- Be precise about this, because the obvious reading is wrong. These do NOT
-- hand `rekoda_worker` reach it lacked. `tenant_isolation` compares
-- business_id against a session GUC, and any role may set that GUC to any
-- value, so a process holding the worker credential can already pin an
-- arbitrary tenant and read the whole of it. It does exactly that on every
-- job it claims.
--
-- What these add is the ability to answer in ONE query rather than one query
-- per tenant. That is the difference between a report and a loop over the
-- estate, and it is why the reach that matters is which CREDENTIAL a process
-- holds, not which policy exists. `rekoda_app` -- the credential the API and
-- every merchant request run under -- gains nothing here and still sees
-- nothing without a pinned tenant.
--
-- FOR SELECT, though, and deliberately: writing across tenants is reach the
-- worker genuinely does not have, and a future handler must not acquire it by
-- inheriting a policy written for a report.
CREATE POLICY ops_read_usage ON usage_events
  FOR SELECT
  TO rekoda_worker
  USING (true);

CREATE POLICY ops_read_businesses ON businesses
  FOR SELECT
  TO rekoda_worker
  USING (true);

-- The margin query groups by (billing_period, business_id). The index from
-- 0000 leads on business_id, which is the wrong way round for a question that
-- starts with a month and does not name a tenant.
CREATE INDEX IF NOT EXISTS usage_period_business_ix
  ON usage_events (billing_period, business_id);
