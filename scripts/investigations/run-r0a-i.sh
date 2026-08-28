#!/usr/bin/env bash
#
# Run the R0A-i provenance classifier and print a report that can be cited.
#
# The SQL is read-only and takes one snapshot; this wrapper adds the header
# that makes its OUTPUT evidence rather than a paste: when it ran, against
# what, as whom, and - the part that matters months later - the SHA-256 of
# the classifier that produced it. A report whose script cannot be
# identified cannot be re-run to check a disputed number.
#
#   scripts/investigations/run-r0a-i.sh > /secure/path/r0a-i-2026-08-28.txt
#
# THE OUTPUT DOES NOT GO IN GIT.
#
# It is a production record: business identifiers, payment identifiers and
# amounts. It belongs in private audit storage with the rest of the
# financial evidence. `.gitignore` refuses the obvious filenames, which is a
# safety net and not permission to try.
#
# Nor does it go to a reasoning model. If any part of it is quoted anywhere,
# strip or tokenise customer names, phone numbers, bank account numbers,
# full narration, addresses and emails first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$HERE/r0a-i-payment-provenance.sql"

: "${DATABASE_URL:?set DATABASE_URL to the database to report on}"

# The classifier's own fingerprint. Two reports with different numbers and
# the same hash are a real change in the data; two with different hashes are
# not comparable at all.
if command -v sha256sum >/dev/null 2>&1; then
  SCRIPT_SHA="$(sha256sum "$SQL" | cut -d' ' -f1)"
else
  SCRIPT_SHA="$(shasum -a 256 "$SQL" | cut -d' ' -f1)"
fi

# The repository state, when there is one. A checkout with uncommitted
# changes says so, because "which version ran" is the whole point.
GIT_REV="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo 'not a git checkout')"
if ! git -C "$HERE" diff --quiet 2>/dev/null; then
  GIT_REV="$GIT_REV (working tree modified)"
fi

# The host and database, without the credentials in the URL.
SAFE_TARGET="$(printf '%s' "$DATABASE_URL" | sed -E 's#(://)[^@/]*@#\1***@#')"

cat <<HEADER
================================================================================
R0A-i  ·  LEGACY PAYMENT PROVENANCE REPORT
================================================================================
generated_at    : $(date -u '+%Y-%m-%dT%H:%M:%SZ') (UTC)
generated_by    : ${R0A_OPERATOR:-${USER:-unknown}}
target          : ${SAFE_TARGET}
classifier      : scripts/investigations/r0a-i-payment-provenance.sql
classifier_sha256: ${SCRIPT_SHA}
repository      : ${GIT_REV}

This report is READ ONLY and was taken inside a single REPEATABLE READ
snapshot, so every section below counts the same instant. Section 0 states
that snapshot as the server saw it.

APPROVAL. R0A-ii (PR-006 onward) may not run until this report has been
reviewed, reconciled against expected counts and totals, its remediation
population understood, and explicitly approved. The approval records the
classifier_sha256 above and the population_sha256 from section 6, and names
the approver by their immutable internal operator UUID rather than a
display name or an email address. See docs/runbooks/r0a-provenance.md.
================================================================================

HEADER

psql "$DATABASE_URL" --no-psqlrc -f "$SQL"
