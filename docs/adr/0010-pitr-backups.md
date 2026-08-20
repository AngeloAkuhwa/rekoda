# 0010 — Continuous WAL archiving (PITR), not nightly dumps

**Status:** Accepted
**Date:** 2026-08-19
**Refines:** [0006](0006-hosting-hetzner-cloudflare.md)

## Context

ADR 0006 specified "nightly `pg_dump` to Backblaze B2 + weekly Hetzner
snapshots". For a general SaaS that is adequate. For a **ledger** it is not:
the recovery-point objective is up to 24 hours, so a disk failure at 23:00
destroys a full day of every merchant's financial records — invoices they have
already sent to customers, payments they have already been paid.

There is no acceptable story for that. "We lost yesterday" is not a sentence a
bookkeeping product survives, and the single-box topology of ADR 0006 makes it
a realistic scenario rather than a theoretical one.

The fix costs a few dollars a month.

## Decision

**pgBackRest with continuous WAL archiving to S3-compatible object storage**
(Cloudflare R2 or Backblaze B2 — both speak S3; B2 is ~$6/TB/month).

- Full backup weekly, differential daily, **WAL streamed continuously** →
  point-in-time recovery with an **RPO of minutes**, not a day.
- Repository encrypted at rest; credentials in the environment, never the repo.
- **Keep the nightly `pg_dump -Fc` as well.** It is an independent logical
  format that survives a physical-format or version problem that would take
  pgBackRest down with it. Two formats, two failure modes.
- Documents in R2 are already durable and are backed up by lifecycle policy,
  not by pgBackRest.

**A backup that has not been restore-drilled does not count as a backup.**
Ship `scripts/restore-drill.sh` in the same PR as the backup configuration:

1. spin a throwaway Postgres container,
2. restore the latest PITR to a chosen timestamp,
3. run the **per-business ledger-balance invariant** across every business —
   `SUM(debit) = SUM(credit)` per `business_id` — and report any drift,
4. report restored-to timestamp, wall-clock duration (the real RTO), and row
   counts against the live primary.

Run it **monthly by cron and on every release tag**, and log the result in
`docs/runbooks/backup-restore.md`. **The first drill must pass before the first
paying merchant**, not after.

## Consequences

RPO drops from ~24 hours to minutes for roughly the cost of a coffee. RTO
becomes a measured number instead of a hope, because the drill reports it.

The drill's ledger-balance sweep doubles as a **correctness canary**: it is the
same invariant the trial-balance monitoring job asserts in production, so a
restore that balances proves both the backup _and_ the ledger.

This does not remove the single-point-of-failure — it bounds the data loss.
The availability answer remains ADR 0006's scale-out path: when revenue
justifies it, a streaming replica on a second small Hetzner node takes RTO from
"restore duration" to "minutes", and that is a compose-file change.

## Sources

- https://mysticmind.dev/postgresql-point-in-time-recovery-with-pgbackrest-and-s3-compatible-storage/
- https://ramnode.com/guides/series/postgres-superstack/pgbackrest
