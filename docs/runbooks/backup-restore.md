# Runbook — Backup & Restore

**Rule: a backup that has not been restore-drilled does not count as a backup.**
Drill cadence: monthly, and before any migration touching financial tables.

## What is backed up

| Data | Method | Frequency | Destination |
|---|---|---|---|
| Postgres (everything: ledger, vault ciphertexts, audit) | `pg_dump -Fc` | nightly 02:00 WAT | Backblaze B2, encrypted |
| Generated documents | R2 is primary storage; lifecycle-copied | continuous | R2 + B2 mirror |
| Whole box | Hetzner snapshot | weekly | Hetzner |

Vault ciphertexts are useless without `VAULT_KEY`, which lives ONLY in the
environment — so an exfiltrated backup alone exposes no customer identity.
Corollary: **losing VAULT_KEY loses the vault.** The key custody procedure
(who holds copies, where) is part of this runbook's checklist, not optional.

## Backup (automated; verify weekly)

```bash
# On the server — installed as a systemd timer at deploy (M0 compose ships it):
pg_dump "$DATABASE_URL" -Fc -f /backups/rekoda-$(date +%F).dump
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in /backups/rekoda-$(date +%F).dump \
  -out /backups/rekoda-$(date +%F).dump.enc -pass env:BACKUP_PASSPHRASE
b2 upload-file rekoda-backups /backups/rekoda-$(date +%F).dump.enc db/rekoda-$(date +%F).dump.enc
```

Weekly verification: confirm the newest B2 object exists and its size is
within 20% of the previous week's.

## Restore drill (monthly)

1. Provision a scratch Postgres (local docker is fine).
2. Pull the newest dump from B2; decrypt with `BACKUP_PASSPHRASE`.
3. `pg_restore -d "$SCRATCH_URL" --no-owner rekoda-<date>.dump`
4. Run the integrity checks:
   ```sql
   -- the ledger must balance, in total and per business
   SELECT business_id, SUM(debit_k) - SUM(credit_k) AS drift
   FROM ledger_entries GROUP BY business_id HAVING SUM(debit_k) <> SUM(credit_k);
   -- must return zero rows
   ```
5. Spot-check one business: invoice count, latest document number, an
   audit-trail tail.
6. Record the drill (date, dump used, duration, result) in this file's
   drill log below.

## Real restore (incident)

Same as the drill against the production server, plus: stop the app first
(`docker compose stop api web`), restore, run integrity checks, start, then
verify webhooks re-deliver (Meta and Paystack both retry) — idempotency
keys make replays safe.

## Drill log

| Date | Dump | Duration | Result | Operator |
|---|---|---|---|---|
| _(first drill due before first paying merchant)_ | | | | |
