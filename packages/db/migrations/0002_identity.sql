-- Identity bootstrap: reading memberships before a tenant is known.
--
-- `memberships` is under tenant_isolation, which keys on `app.business_id`.
-- But the first question a sign-in has to answer is *which* business — and at
-- that moment there is nothing to pin, so an unpinned SELECT correctly returns
-- nothing and the merchant can never get in.
--
-- The narrow fix is a second pin, `app.user_id`, set by withUser() in
-- packages/db/src/client.ts, with a policy that is deliberately:
--
--   * SELECT-only     — a pinned user can discover memberships, never mint one.
--                       Writes still go through tenant_isolation's WITH CHECK.
--   * one table       — businesses, ledgers and everything else stay untouched.
--   * fail-closed     — nullif() makes an unpinned transaction see nothing
--                       rather than everything, same as the tenant policy.
--
-- Permissive policies OR together, so a transaction pinned to a business still
-- sees that business's full membership list exactly as before.
--
-- Why not SECURITY DEFINER: the tenant tables are under FORCE ROW LEVEL
-- SECURITY, so the policies apply to the table owner too. A definer-rights
-- function owned by that role is filtered like any other caller and would have
-- returned zero rows while looking like it worked.

CREATE POLICY membership_self ON memberships
  FOR SELECT
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
