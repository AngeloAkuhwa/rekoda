-- The away assistant's configured limits (spec §3.2, Appendix D; W4, PR-090).
--
-- "The assistant answers when the merchant cannot, within configured
-- limits" — and a limit that is not a row is a vibe. Two tables:
--
-- away_assistant_settings is the merchant's own switch and ceiling. OFF by
-- default: an assistant nobody enabled answers nobody. The daily ceiling is
-- per customer per day, and 0 means ZERO replies (owner ruling: 0 is never
-- unlimited) — the merchant who wants silence keeps the toggle off or the
-- ceiling at nought, and both read the same way.
--
-- away_assistant_replies is the meter the ceiling is enforced against:
-- one row per (customer, Lagos day), counted by atomic increment so two
-- messages racing cannot slip past the limit together. The customer is the
-- same blind index every WABA identity uses (F.4); raw numbers never land
-- here.
--
-- What is NOT here is any grant of authority: the assistant holds no
-- command surface at all, and Appendix D's absolute rule — never HIGH_RISK,
-- with no history parameter to soften it — is enforced in the risk layer
-- (PR-017a), not by these rows.

CREATE TABLE away_assistant_settings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  enabled       integer NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- Automated replies per customer per Lagos day. 0 means zero.
  daily_reply_limit integer NOT NULL DEFAULT 5 CHECK (daily_reply_limit >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT away_assistant_settings_ux UNIQUE (business_id)
);

CREATE TABLE away_assistant_replies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  -- The blind index the thread routes by, never a raw number (F.3/F.4).
  customer_hash text NOT NULL,
  day           text NOT NULL,
  replies       integer NOT NULL DEFAULT 0 CHECK (replies >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT away_assistant_replies_ux UNIQUE (business_id, customer_hash, day)
);

-- 0001 default-privileges trap: ALTER DEFAULT PRIVILEGES already granted
-- both application roles full DML on these tables, so what they must NOT
-- hold needs REVOKE, not the absence of a GRANT. No DELETE for anybody:
-- disabling the assistant is an UPDATE, and the reply meter is evidence of
-- what an automation sent in the business's name.
REVOKE DELETE ON away_assistant_settings FROM rekoda_app;
REVOKE DELETE ON away_assistant_settings FROM rekoda_worker;
REVOKE DELETE ON away_assistant_replies FROM rekoda_app;
REVOKE DELETE ON away_assistant_replies FROM rekoda_worker;

ALTER TABLE away_assistant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE away_assistant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON away_assistant_settings
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE away_assistant_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE away_assistant_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON away_assistant_replies
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
