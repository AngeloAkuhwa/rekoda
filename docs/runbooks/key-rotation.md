# Runbook — Key rotation

The estate holds several independent secrets, each with a different blast
radius. This lists them, what each protects, and how to rotate it without an
outage. **Rotating a key does NOT re-encrypt data already sealed under the
old one** unless a step below says so explicitly — read the per-key note.

## The keys, by blast radius

| Env var                  | Protects                                                        | Rotation cost                                  |
| ------------------------ | -------------------------------------------------------------- | ---------------------------------------------- |
| `VAULT_KEY`              | The identity vault AND sealed event payloads (AES-256-GCM)     | HIGH — old ciphertexts need re-wrap; **losing it loses the vault** |
| `CONNECTION_KEY`         | Merchants' Paystack secret keys, WABA access tokens, settlement account numbers | HIGH — same re-wrap; guards the highest-value material in the estate |
| `MATCH_KEY`              | Deterministic identity match index (keyed HMAC)                | HIGH — changing it orphans every blind index; treated as permanent |
| `META_APP_SECRET`        | The Meta webhook HMAC                                           | LOW — stateless; rotate any time                |
| Paystack secret key      | Verifies Paystack webhooks and calls their API                 | LOW — rotate in Paystack dashboard + env        |
| `REKODA_API_SECRET`      | Signs setup grants and session-adjacent artefacts              | MEDIUM — rotating invalidates live setup grants |
| `REKODA_OPERATOR_SECRET` | The operator-endpoint header credential                        | LOW — rotate any time; invalidates old ops scripts |
| `OTP_PEPPER`             | Server-side pepper for OTP hashing                             | LOW — rotating invalidates in-flight OTPs only  |
| `BACKUP_PASSPHRASE`      | Encrypts offsite dumps                                          | MEDIUM — old dumps still need the old passphrase |

## Every key is shape-validated at boot (PR-106)

`VAULT_KEY`, `MATCH_KEY` and `CONNECTION_KEY` must be **64 hex characters**
(`openssl rand -hex 32`) — validated at startup, not at first use. A
malformed key fails the deploy immediately with the variable's name, rather
than booting clean and throwing at a money path. `CONNECTION_KEY` may be
empty (the capabilities it protects are then off), but a **non-empty** value
must be a real key. Generate one with:

```bash
openssl rand -hex 32
```

## Fingerprint enrolment at boot (remediation A6)

A wrong `VAULT_KEY` or `MATCH_KEY` does not error — it decrypts nothing and
encrypts new secrets under a key the old data does not share. So the API
refuses to start with a key the database was not enrolled with:

- On **first boot** against a database, the process records a non-secret
  fingerprint of each key in `key_fingerprints` (SHA-256 over a versioned
  domain separator, truncated to 16 hex chars — safe to store and to log,
  useless for recovering the key).
- On **every later boot** it recomputes and compares. A mismatch aborts
  startup with `KeyFingerprintMismatch`, naming both fingerprints (never a
  key) so you can tell which side is wrong.

**If you see `KeyFingerprintMismatch` and did not intend a rotation**, the
deployed secret is wrong — a paste error, a stale secret store, or a restore
pointed at the wrong environment. Fix the deployed value; do not touch the
table.

**If it is a deliberate rotation**, the application roles cannot update the
enrolled row (they hold INSERT and SELECT only — migration 0120). In the
same change that re-wraps the data (see below), update the fingerprint as
the owner:

```sql
-- as the owner role, inside the rotation window
UPDATE key_fingerprints
   SET fingerprint = '<new fingerprint>', created_at = now()
 WHERE key_name = 'VAULT_KEY';
```

The new fingerprint is printed by the failed boot attempt ("this process
holds ..."), or computed as the first 16 hex chars of
`sha256("rekoda-key-fingerprint-v1:" + key)`.

## Low-cost rotation (stateless keys)

`META_APP_SECRET`, Paystack secret, `REKODA_OPERATOR_SECRET`, `OTP_PEPPER`:

1. Generate/obtain the new value.
2. Set it in the environment.
3. Redeploy (`docs/runbooks/deploy.md`).
4. For `META_APP_SECRET` / Paystack: update the value in the provider's
   dashboard **in the same window** — a mismatch shows up immediately as
   `badSignatures` climbing on `/v1/ops/health` (see `incident.md`), which
   is the intended detection signal.

## High-cost rotation (data-encrypting keys)

`VAULT_KEY` and `CONNECTION_KEY` seal data at rest. The vault's `v1` format
binds each ciphertext to its purpose (AAD), so a naive key swap makes every
sealed value undecryptable. Rotation is therefore a **re-wrap migration**,
not an env change:

1. Stand up the new key alongside the old (`VAULT_KEY_NEXT`).
2. Run the re-wrap job: decrypt under the old key, re-encrypt under the new,
   in tenant-pinned batches, inside transactions.
3. Verify a sample decrypts under the new key only.
4. Promote `VAULT_KEY_NEXT` → `VAULT_KEY`, redeploy, retire the old key.

> The re-wrap job is not built yet (no key has needed rotating). It is owed
> before the first key rotation, and named here so it is not discovered as
> missing during one. `MATCH_KEY` is deliberately excluded: it keys a blind
> index that cannot be recomputed without re-deriving every identity, so it
> is treated as permanent for V1.

## Custody

`VAULT_KEY` and `CONNECTION_KEY` custody — who holds copies, where, and how a
lost key is recovered from custody rather than from a backup (a backup
without the key is inert, `backup-restore.md`) — is an owner-held procedure,
not a repository artefact.
