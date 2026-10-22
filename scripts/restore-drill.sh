#!/usr/bin/env bash
# Restore drill (G-02, ADR 0010): fetch the newest off-box backup, decrypt it,
# restore it into a SCRATCH database, and prove the books still tie. Reports the
# object, the wall-clock restore time (the measured RTO) and row counts.
#
#   BACKUP_DEST, BACKUP_PASSPHRASE_FILE, BACKUP_S3_ENDPOINT   as scripts/backup-db.sh
#   DRILL_DATABASE_URL  superuser URL of a scratch PostgreSQL server. Its database
#                       name must contain "drill" or "scratch"; production is refused.
#                       Unset: a throwaway postgres:16-alpine container is used.
#   DRILL_OBJECT        optional object name instead of the newest
#
# Exit 0 only if every business's ledger balances (debit_k = credit_k). Record the
# result in the runbook's drill log.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/backup-common.sh
. scripts/lib/backup-common.sh

backup_require_config
umask 077
WORK=$(mktemp -d)
CONTAINER=""
cleanup() { rm -rf "$WORK"; [ -z "$CONTAINER" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

START=$(date +%s)
OBJECT=$(backup_fetch_decrypt "${DRILL_OBJECT:-}" "$WORK/restore.dump")

if [ -n "${DRILL_DATABASE_URL:-}" ]; then
  DB_NAME=$(printf '%s' "$DRILL_DATABASE_URL" | sed -E 's|^[^?]*/([^/?]+)(\?.*)?$|\1|')
  case "$DB_NAME" in
    *drill* | *scratch*) ;;
    *) backup_die "refusing DRILL_DATABASE_URL: database '$DB_NAME' is not named *drill* or *scratch*" ;;
  esac
  URL="$DRILL_DATABASE_URL"
  psql "$URL" -v ON_ERROR_STOP=1 -qc 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;' >/dev/null
  pg_restore --no-owner -d "$URL" "$WORK/restore.dump"
  PSQL=(psql "$URL" -v ON_ERROR_STOP=1 -At)
else
  PW=$(openssl rand -hex 16)
  CONTAINER=$(docker run -d -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=rekoda_drill postgres:16-alpine)
  for _ in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres -d rekoda_drill >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres -d rekoda_drill >/dev/null || backup_die "scratch postgres did not start"
  docker cp "$WORK/restore.dump" "$CONTAINER:/tmp/restore.dump"
  docker exec "$CONTAINER" pg_restore --no-owner -U postgres -d rekoda_drill /tmp/restore.dump
  PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d rekoda_drill -v ON_ERROR_STOP=1 -At)
fi
END=$(date +%s)

DRIFT=$("${PSQL[@]}" -c "SELECT count(*) FROM (SELECT business_id FROM ledger_entries GROUP BY business_id HAVING sum(debit_k) <> sum(credit_k)) d;")
BUSINESSES=$("${PSQL[@]}" -c 'SELECT count(*) FROM businesses;')
ENTRIES=$("${PSQL[@]}" -c 'SELECT count(*) FROM ledger_entries;')
INVOICES=$("${PSQL[@]}" -c 'SELECT count(*) FROM invoices;')

echo "restore-drill: object=$OBJECT restore_seconds=$((END - START)) businesses=$BUSINESSES ledger_entries=$ENTRIES invoices=$INVOICES unbalanced_businesses=$DRIFT"
[ "$DRIFT" = "0" ] || backup_die "DRILL FAILED: $DRIFT business(es) whose ledger does not balance"
echo "restore-drill: PASS"
