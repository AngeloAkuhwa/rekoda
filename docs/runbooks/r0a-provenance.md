# R0A · The legacy payment provenance report

**Status: this gate is OPEN and blocking.** PR-006 through PR-009 and PR-115
cannot start until the report described here has been run against
production, reviewed, and approved. Nothing in this runbook is optional, and
progress elsewhere in the build is not a substitute for any of it (build
plan §7).

## What the report is for

Spec §6.2 requires every payment to carry how its arrival was established.
Payments recorded before that column existed carry nothing, and the honest
answer for some of them is that nobody can now say. R0A-i reconstructs what
can be reconstructed FROM EVIDENCE and names the rest, so that remediation
is a decision somebody makes rather than a default a migration picks.

The classifier is `scripts/investigations/r0a-i-payment-provenance.sql`. It
writes nothing, and the database is told so twice: the whole report runs
inside one `REPEATABLE READ, READ ONLY` transaction. That is not decoration.
`READ ONLY` means the server refuses a write, so read-only stops being a
property of the file that a later edit could quietly remove. `REPEATABLE
READ` means all six sections see ONE SNAPSHOT: without it a payment booked
between section 1 and section 5 appears in one and not the other, and the
reviewer reconciling the counts finds a discrepancy that is real,
unexplainable and not a bug.

## Running it

```
export DATABASE_URL=...            # a read replica is fine and preferred
export R0A_OPERATOR=<your name>    # appears in the header
scripts/investigations/run-r0a-i.sh > /secure/audit/r0a-i-$(date -u +%F).txt
```

The wrapper prints the header that makes the output citable: when, against
what, as whom, the SHA-256 of the classifier, and the repository revision.
Two reports with different numbers and the same classifier hash record a
real change in the data; two with different hashes are not comparable at
all.

## Where the output goes, and where it does not

**Not in Git.** It is a production record carrying business identifiers,
payment identifiers and amounts. It belongs in private audit storage with
the rest of the financial evidence. `.gitignore` refuses the obvious
filenames; that is a safety net, not permission.

**Not into a reasoning model.** If any part of it is quoted anywhere,
tokenise or strip customer names, phone numbers, bank account numbers, full
bank narration, addresses and emails first. Counts, totals and provenance
grades carry no personal data and are safe to discuss; rows are not.

## Reviewing it

1. **Reconcile the totals.** Section 5's `all_payments` must equal the sum
   of section 1's `payments`. They are taken from the same snapshot, so a
   difference is a defect in the classifier and not in the data.
2. **Read section 3, the remediation queue.** These are payments that had
   paper issued on them - a receipt, an allocation - whose provenance the
   estate cannot establish. This is the population the backfill will touch,
   and understanding it is what approval means.
3. **Read section 4 separately.** These are attested, and listed only
   because the merchant may want to re-check what they confirmed off a
   photograph. They are NOT remediation, and a review that merges the two
   lists has misread the report.
4. **Note section 6's `population_sha256`** for the row you are approving.
   Counts matching is not the same as the population matching: two sets of
   412 payments are equally numerous and need not be the same 412.

## What remediation may and may not do

**It may not rewrite `LEGACY_PROVENANCE_UNKNOWN` into something that
pretends Rekoda knew the provenance historically.** That is the whole point
of the grade. Where later evidence establishes what happened, the
remediation APPENDS that evidence with its own date and actor, and the
historical record still says that at the time of the payment the provenance
was unknown. Where nothing establishes it, it stays unknown - permanently,
and that is an acceptable outcome. A migration that produced no unknowns
would be a migration that invented something.

## The approval

Approval is a sentence somebody signs, recorded on the manifest the backfill
opens (`migration_manifests`, migration 0057 and 0116):

```
I have reviewed the R0A-i report of <date>,
  classifier_sha256   <64 hex>
  source_report_sha256 <64 hex of the report file itself>
  population_sha256   <64 hex, section 6, LEGACY_PROVENANCE_UNKNOWN>
  expected_row_count  <n>
reconciled its counts and totals, understand the remediation population,
and approve the R0A-ii backfill against exactly that population.
```

`approved_by_user_id` is the approver's **immutable internal operator
UUID**, not a display name and not an email address. People are renamed and
addresses are reassigned; the one thing that must still resolve in five
years is who approved this. `approved_by` remains for the human-readable
note beside it.

The database refuses a half-recorded approval: a manifest carrying an
approver with no report fingerprint, or a fingerprint with nobody's id on
it, violates `migration_manifests_approval_complete`. That is the shape a
fabricated approval takes, so it is unrepresentable rather than discouraged.

## Before the backfill runs

The migration recomputes section 6's checksum over the population it is
about to touch and compares it with `item_set_checksum`. **A run whose
recomputed checksum differs is operating on rows nobody approved and must
stop.** Rows change between the report and the run in normal operation;
that is not a reason to proceed, it is the reason to take a fresh report and
have it approved.
