-- Second independent review of PR #432 (G4b-2): the settlement process checks it holds the
-- database's vault key before it starts.
--
-- The API and the worker refuse to boot with a `VAULT_KEY` whose fingerprint is not the one the
-- database enrolled (0120, `bootChecks.assertKeyUnchanged`). Settlement checked only that its key
-- was 64 hex characters: 0217 left it no read on `key_fingerprints`. With a wrong key it started,
-- reported healthy, and every `billing.process` job then failed to open its sealed provider event
-- and retried to dead, so paid charges stayed pending while monitoring showed green.
--
-- Since 0237 settlement may READ the fingerprints (non-secret SHA-256 truncations, no tenant data)
-- and `bootChecks.assertKeyEnrolled` refuses to start unless its key's fingerprint is the enrolled
-- one. It may not enrol one (no INSERT): the API and the worker enrol, so a settlement process
-- that starts first on a fresh database refuses until they have, and its restart policy brings it
-- up once they have.
--
-- Not a compatibility break. Re-running is safe.

GRANT SELECT ON key_fingerprints TO rekoda_settlement;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON key_fingerprints FROM rekoda_settlement;
