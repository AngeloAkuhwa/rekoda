# Runbook — Backup & Restore

**Rule: a backup that has not been restore-drilled does not count as a backup.**
Drill cadence: monthly, and before any migration touching financial tables.

## What is backed up

> **Honesty note (pre-launch).** The table below is the intended
> PRODUCTION backup design. As of 29 August 2026 none of it is enabled or
> evidenced: no B2 tooling, timer or configuration exists in this
> repository, and no production server exists to run it. What exists and
> runs today is the automated restore drill in CI (below). Enabling this
> design is a launch task; when it happens, this note is replaced by the
> evidence (timer unit, bucket name, first verified upload date).

| Data                                                    | Method (planned)                        | Frequency (planned) | Destination (planned)   |
| ------------------------------------------------------- | --------------------------------------- | ----------------- | ----------------------- |
| Postgres (everything: ledger, vault ciphertexts, audit) | `pg_dump -Fc`                           | nightly 02:00 WAT | Backblaze B2, encrypted |
| Generated documents                                     | R2 is primary storage; lifecycle-copied | continuous        | R2 + B2 mirror          |
| Whole box                                               | Hetzner snapshot                        | weekly            | Hetzner                 |

Vault ciphertexts are useless without `VAULT_KEY`, which lives ONLY in the
environment — so an exfiltrated backup alone exposes no customer identity.
Corollary: **losing VAULT_KEY loses the vault.** The key custody procedure
(who holds copies, where) is part of this runbook's checklist, not optional.

## Backup (production procedure; to be installed at deploy, then verified weekly)

```bash
# On the server — to be installed as a systemd timer at first deploy.
# NOT YET SHIPPED: no timer unit or compose service exists in the repo;
# writing and enabling it is part of the launch deploy checklist.
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

## The drill runs in CI on every push

The manual drill above is the production procedure. It is backed by an
automated one that runs on every push and proves the part that actually
matters: that a real `pg_dump -Fc` followed by `pg_restore` produces a
database whose books still tie.

`packages/db/src/recovery-drill.integration.test.ts` seeds a business whose
ledger balances and whose paid invoice carries its payment, allocation and
receipt, takes a real custom-format dump, restores it into a fresh scratch
database with the actual binaries, and then interrogates the RESTORED copy:
every journal balances per business (invariant 2), no paid invoice lost its
money trail (invariant 3), and the business, its paid invoice and its
receipt all crossed. The day the dump format, a role grant or an RLS policy
stops surviving the round trip, that test fails in CI rather than at 2am
against production. A green build is a passed drill.

## Drill log

| Date       | Dump                        | Duration | Result | Operator     |
| ---------- | --------------------------- | -------- | ------ | ------------ |
| Continuous | CI, per push (§32-shaped)   | ~6s      | PASS   | recovery-drill test |
| _(first production drill due before first paying merchant)_ |  |  |  |  |
