-- The shop a customer can open (MASTER-PLAN §5.3.5, "Door 1").
--
-- Rekoda's first page with no session behind it, and the table exists because
-- of what that costs.
--
-- ── why this is not columns on `businesses` ────────────────────────────────
--
-- A public page has to turn a slug somebody typed into a tenant. `businesses`
-- is under strict row-level security keyed on the pinned tenant, which is the
-- chicken and the egg: nothing can read the row until it knows which row.
-- The obvious fix is a policy letting anyone SELECT a published business, and
-- that is the wrong fix. Row-level security is row-level: such a policy would
-- expose the WHOLE row for every shop that ever published, including the
-- plan, the TIN, the RC number, the owner's user id and the date a card last
-- failed. None of that is a shop.
--
-- So the public face of a business is its own table, holding only what the
-- merchant chose to publish. Nothing can land here by accident, the public
-- read path physically cannot reach a business's financial row, and the
-- boundary is a table rather than a promise.
--
-- The WhatsApp number is COPIED rather than joined for the same reason. It is
-- a published fact, deliberately chosen, and a join would put the public path
-- one query away from `users`. A merchant may also publish a shop line that
-- is not the number they sign in with.
CREATE TABLE IF NOT EXISTS shops (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL UNIQUE REFERENCES businesses(id),
  -- The handle in the URL: rekoda.app/s/<slug>. Globally unique, because a
  -- URL is global; lowercase letters, digits and single hyphens only, so a
  -- link survives being typed off a shop sign.
  slug          text NOT NULL UNIQUE
                  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 40),
  -- What the shop calls itself. Defaults to the business name and is theirs
  -- to change: the name on a CAC certificate is not always the name on the
  -- shop front.
  display_name  text NOT NULL,
  -- Where a customer reaches them. E.164, and published on purpose.
  whatsapp_e164 text NOT NULL,
  -- One line under the name, in the merchant's words. Never generated.
  tagline       text,
  -- Null until the merchant switches it on. A slug can be reserved without
  -- the shop being live, so nobody loses a name while they are still setting
  -- prices, and nothing is public until somebody said so.
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The public page's only lookup. Partial: an unpublished shop is not findable
-- by slug, which is the difference between reserved and live.
CREATE INDEX IF NOT EXISTS shops_published_slug_ix
  ON shops (slug)
  WHERE published_at IS NOT NULL;

ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE shops FORCE ROW LEVEL SECURITY;

-- Readable by anyone, which is the entire point of the table: every column in
-- it is something the merchant published.
CREATE POLICY shop_public_read ON shops
  FOR SELECT
  USING (true);

-- Written only under a tenant pin. The read policy above is SELECT-only, so
-- INSERT, UPDATE and DELETE are governed by this one alone: a session on one
-- business cannot publish, rename or take down another's shop.
CREATE POLICY shop_tenant_write ON shops
  FOR ALL
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON shops TO rekoda_app;
-- A background process has no business publishing a shop.
REVOKE INSERT, UPDATE, DELETE ON shops FROM rekoda_worker;
