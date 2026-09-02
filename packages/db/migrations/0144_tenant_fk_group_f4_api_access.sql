-- Group F, part four: API access (0141, 0142 and 0143 before).
--
-- Two edges from the public API's own tables:
--   api_keys.application_id            -> api_applications
--   api_key_rate_windows.api_key_id    -> api_keys
--
-- Both said only that the parent exists. What that allowed is specific: a key
-- minted under another merchant's application, and a rate-limit window
-- counting one merchant's calls against another merchant's key. The second is
-- the one that matters most, because the window IS the ceiling: a window
-- attached to the wrong key spends someone else's allowance.
--
-- The usual checks, run rather than assumed: business_id is NOT NULL on both
-- children and BOTH reference columns are NOT NULL, so neither constraint is
-- ever skipped. Neither parent exposed UNIQUE (business_id, id), so this adds
-- both first, additively. No existing row points across a tenant. NOT VALID
-- then VALIDATE here, and each weaker key dropped only after its stronger one
-- is valid.
--
-- Order matters inside this file: api_keys is a child of api_applications and
-- the parent of api_key_rate_windows, so its own unique key has to exist
-- before the window edge can reference it.
--
-- `api_key_rate_windows` is worth one note for whoever reads this next: it has
-- no `id` column at all. Its primary key is (api_key_id, window_start), so it
-- can never be a parent, and repointing api_key_id moves the row's identity.
-- 0110 declared the key it replaces as a plain REFERENCES with no ON DELETE
-- action, and the composite below keeps exactly that: no cascade is added and
-- none is removed.
ALTER TABLE api_applications ADD CONSTRAINT api_applications_business_id_ux UNIQUE (business_id, id);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_business_id_ux UNIQUE (business_id, id);

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_application_business_fk
  FOREIGN KEY (business_id, application_id) REFERENCES api_applications (business_id, id) NOT VALID;
ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_application_business_fk;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_application_id_fkey;

ALTER TABLE api_key_rate_windows
  ADD CONSTRAINT api_key_rate_windows_key_business_fk
  FOREIGN KEY (business_id, api_key_id) REFERENCES api_keys (business_id, id) NOT VALID;
ALTER TABLE api_key_rate_windows VALIDATE CONSTRAINT api_key_rate_windows_key_business_fk;
ALTER TABLE api_key_rate_windows DROP CONSTRAINT api_key_rate_windows_api_key_id_fkey;
