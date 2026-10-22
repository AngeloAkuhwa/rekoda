# Runbook — Backup & Restore

**Rule: a backup that has not been restore-drilled does not count as a backup.**
Drill cadence: monthly, and before any migration touching financial tables.

## What is backed up

> **Honesty note (pre-launch).** The table below is the intended
> PRODUCTION backup design. As of 22 October 2026 the nightly encrypted
> dump and the restore drill exist as scripts and systemd units in this
> repository (see "Backup scripts" below), but none of it is enabled or
> evidenced: no destination, credentials or timer are configured and no
> production server exists to run it. Continuous WAL archiving (ADR 0010,
> OD-7) does not exist. What runs today is the automated restore drill in
> CI (below). When the timer is enabled, this note is replaced by the
> evidence (bucket name, first verified upload date, first off-box drill).

| Data                                                    | Method (planned)                        | Frequency (planned) | Destination (planned)   |
| ------------------------------------------------------- | --------------------------------------- | ------------------- | ----------------------- |
| Postgres (everything: ledger, vault ciphertexts, audit) | `pg_dump -Fc`                           | nightly 02:00 WAT   | Backblaze B2, encrypted |
| Generated documents                                     | R2 is primary storage; lifecycle-copied | continuous          | R2 + B2 mirror          |
| Whole box                                               | Hetzner snapshot                        | weekly              | Hetzner                 |

Vault ciphertexts are useless without `VAULT_KEY`, which lives ONLY in the
environment — so an exfiltrated backup alone exposes no customer identity.
Corollary: **losing VAULT_KEY loses the vault.** The key custody procedure
(who holds copies, where) is part of this runbook's checklist, not optional.

## Backup scripts (G-02, CODE COMPLETE 22 Oct 2026; NOT enabled anywhere)

`scripts/backup-db.sh` takes a `pg_dump -Fc`, encrypts it (AES-256, PBKDF2,
passphrase from `BACKUP_PASSPHRASE_FILE`), writes a `.sha256`, uploads to
`BACKUP_DEST` (a mounted off-box directory or `s3://bucket/prefix`, with
`BACKUP_S3_ENDPOINT` for R2/B2), reads it back and compares the checksum. Any
failure is a non-zero exit, so a failed systemd unit is the signal. No notifier consumes it yet
(the alert work is G-12/G-20); until one does, check `systemctl status rekoda-backup` and the newest object's date weekly.
`scripts/restore-drill.sh` fetches the newest object, verifies and decrypts it,
restores into a scratch database (a throwaway container, or `DRILL_DATABASE_URL`
whose name must contain `drill` or `scratch`) and exits non-zero unless every
business's ledger balances; it prints the restore time (a floor on the real recovery time) and counts.
Units: `deploy/systemd/rekoda-backup.{service,timer}` with
`/etc/rekoda/backup.env` (root-only). Still needed from the owner: the off-box
destination and credentials, the passphrase custody (lose it and the backups are
unreadable), the first real drill logged below, and OD-7 (continuous WAL/PITR per
ADR 0010 is NOT implemented; this is the nightly logical half only, RPO up to 24h).

### Operator prerequisites

- **Install:** copy `deploy/systemd/rekoda-backup.{service,timer}` to `/etc/systemd/system/`, create
  `/etc/rekoda/backup.env` (root-only, mode 0600), then `systemctl daemon-reload` and
  `systemctl enable --now rekoda-backup.timer`. The checkout is expected at `/opt/rekoda`.
- **`backup.env`:** `BACKUP_DEST`, `BACKUP_PASSPHRASE_FILE` (a file whose first line is at least 32 bytes
  long, mode 0600, custody recorded off the host), optionally `BACKUP_S3_ENDPOINT` and the
  `AWS_*` credentials for an `s3://` destination, `BACKUP_RETAIN_DAYS` (directory destinations only,
  default 30), `BACKUP_DUMP_CMD` (default: `pg_dump` inside the production compose postgres; a pipeline
  here runs with `pipefail`). For R2 or B2 also set `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`,
  which newer aws CLI versions otherwise reject.
- **Drill variables:** `DRILL_DATABASE_URL` (a superuser URL of a scratch server whose database name
  contains `drill` or `scratch`; unset uses a throwaway `postgres:16-alpine` container, removed with its
  data volume) and `DRILL_OBJECT` (a specific object instead of the newest). In URL mode the host's
  `pg_restore` and `psql` must be at least the server's major version (16).
- **Tools:** bash, GNU coreutils (`sha256sum`, `stat -c`), `openssl` 1.1.1 or later (`-pbkdf2`, `-iter`),
  PostgreSQL client tools, `docker`, and the `aws` CLI for an `s3://` destination.
- **Retention:** a directory destination ages out objects older than `BACKUP_RETAIN_DAYS` only after a
  new backup has been verified and published, so a failing run never deletes the last good backup (stale
  `.pending` and `.part` debris is cleared up front, which frees space only if that debris is what fills
  the destination; if it is full of real backups, the nightly run fails until someone frees space by hand). **`s3://` retention:** the script does not expire S3 objects, and a bucket lifecycle rule cannot
  guarantee that a minimum number of backups survives: every backup has its own timestamped key, so
  versioning does not keep an older one, and expiry keeps running while the nightly job fails. Before
  enabling the timer, either set the expiry well beyond the longest outage you would tolerate without
  noticing (with the weekly check of the newest object's date below), or leave expiry off until a
  count-based prune exists. That prune is an open hardening item for G-02, not part of this change.
- **A drill needs data.** It fails on a restore with no ledger entries, since an empty archive proves
  nothing; run it against a database that holds real or staging books.

### What the checksum does and does not give you

The `.sha256` detects corruption and a truncated copy. It is not authentication: AES-CBC carries no
integrity of its own, and anyone with write access to the destination can replace an object and its
checksum together, or roll back to an older valid pair (the drill would still pass against it). The
passphrase protects confidentiality, not freshness. Until the encryption is moved to an authenticated
format, scope the credentials to what each script calls: the nightly backup needs PutObject and GetObject (it
reads back what it staged) and DeleteObject only for its own `.pending` staging objects, or leave those
to a lifecycle rule; the restore drill additionally needs ListBucket, since it finds the newest object
by listing, turn on bucket versioning or object lock so an overwrite or delete keeps a prior
version, and compare the newest object's date with today's. This is an open hardening item for G-02, not
closed by this change.

### Restore by hand (no scripts)

Objects are named `rekoda-<UTC stamp>-<pid>.dump.enc` with a `.sha256` beside each.

```bash
# A subshell, so a failure stops the procedure without closing your SSH session.
(
set -euo pipefail
OBJ=rekoda-<stamp>-<pid>.dump.enc
# The .sha256 file holds a bare hash; refuse to go on if it does not match the object.
[ "$(sha256sum "$OBJ" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$OBJ.sha256")" ] \
  || { echo "checksum mismatch: do not use this object" >&2; exit 1; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -pass file:/path/to/passphrase-file \
  -in "$OBJ" -out restore.dump
# The target must be an empty database on a server where these roles exist; without
# them every GRANT and row-level-security policy that names one is skipped, and the
# restore comes up with missing privileges and policies:
psql "$SCRATCH_URL" -c "DO \$\$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['rekoda_owner','rekoda_app','rekoda_worker','rekoda_provenance_owner','rekoda_operator'] LOOP IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF; END LOOP; END \$\$;"
pg_restore --no-owner -d "$SCRATCH_URL" restore.dump
)
```

In an incident against the real server, restore into a new empty database, check the ledger, then
switch the application over; do not restore over a database you may still need.

## Restore drill (monthly)

1. Provision a scratch Postgres (local docker is fine).
2. Pull the newest object from the destination, check its `.sha256` and decrypt it (see "Restore by hand").
3. `pg_restore -d "$SCRATCH_URL" --no-owner restore.dump` (the file written by the decrypt step)
4. Run the integrity checks (`scripts/restore-drill.sh` does this):
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
(`docker compose -f docker-compose.prod.yml stop api worker web`), restore, run integrity checks, start, then
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
against production. A green build is a passed run of that integration test only; it does not exercise `scripts/restore-drill.sh`, which is not run end to end in CI. Throwaway runs against a local PostgreSQL 16 with a synthetic dump are described in PR #308 only; there is no dated drill-log entry and no off-box drill.

## Drill log

| Date                                                     | Dump                      | Duration | Result | Operator            |
| -------------------------------------------------------- | ------------------------- | -------- | ------ | ------------------- |
| Continuous                                               | CI, per push (§32-shaped) | ~6s      | PASS   | recovery-drill test |
| _(first off-box drill due before first paying merchant)_ |                           |          |        |                     |
