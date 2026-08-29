-- Vault-key identity (remediation A6): a non-secret fingerprint per key,
-- enrolled on first boot, compared on every boot after.
--
-- A wrong encryption key does not error - it decrypts nothing and encrypts
-- new secrets under a key the old data does not share. This table is what
-- lets the process refuse to start instead. Fingerprints are SHA-256
-- truncations over a domain separator: safe to store, safe to log, useless
-- for recovering a key.
--
-- No RLS: one row per key name, no tenant data. The app and worker roles
-- may enroll (INSERT) and read; neither may UPDATE or DELETE - changing an
-- enrolled fingerprint is a deliberate rotation step performed as the owner
-- per docs/runbooks/key-rotation.md, never something an application process
-- can do to itself.

CREATE TABLE IF NOT EXISTS key_fingerprints (
  key_name    text PRIMARY KEY,
  fingerprint text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- REVOKE, not just GRANT: migration 0001's ALTER DEFAULT PRIVILEGES already
-- hands both application roles SELECT, INSERT, UPDATE and DELETE on every
-- new table, so without these two lines "may enroll and read" would quietly
-- include rewriting the enrolled fingerprint - the exact move this table
-- exists to make impossible from an application credential.
REVOKE UPDATE, DELETE ON key_fingerprints FROM rekoda_app;
REVOKE UPDATE, DELETE ON key_fingerprints FROM rekoda_worker;
