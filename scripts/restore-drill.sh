#!/usr/bin/env bash
# Restore drill (G-02, ADR 0010): fetch the newest off-box backup, decrypt it,
# restore it into a SCRATCH database, and prove the books still tie. Reports the
# object, the wall-clock restore time (a floor on the real RTO) and row counts.
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
cleanup() { rm -rf "$WORK"; [ -z "$CONTAINER" ] || docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The dump references the runtime roles in grants and policies; a scratch
# server has none, so create them (no login, no privileges) before restoring.
ROLES_SQL="DO \$\$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['rekoda_owner','rekoda_app','rekoda_worker','rekoda_provenance_owner','rekoda_operator'] LOOP IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF; END LOOP; END \$\$;"

START=$(date +%s)
OBJECT=$(backup_fetch_decrypt "${DRILL_OBJECT:-}" "$WORK/restore.dump")

if [ -n "${DRILL_DATABASE_URL:-}" ]; then
  DB_NAME=$(printf '%s' "$DRILL_DATABASE_URL" | sed -E 's|^[^?]*/([^/?]+)(\?.*)?$|\1|')
  case "$DB_NAME" in
    *drill* | *scratch*) ;;
    # Never echo the URL or the parsed text: a keyword DSN or a path-less URL
    # parses to the whole string, password included.
    *) backup_die "refusing DRILL_DATABASE_URL: its database name is not *drill* or *scratch*" ;;
  esac
  URL="$DRILL_DATABASE_URL"
  # The name check above reads the URL text; libpq may resolve a different
  # database (dbname=, a keyword DSN, a URI with no path). So the database the
  # server resolved is checked in the SAME session that drops the schema.
  psql "$URL" -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
DO $$ BEGIN
  IF current_database() !~ '(drill|scratch)' THEN
    RAISE EXCEPTION 'refusing to reset database %: not named *drill* or *scratch*', current_database();
  END IF;
END $$;
DO $$ DECLARE s text; BEGIN
  FOR s IN SELECT nspname FROM pg_namespace
           WHERE nspname <> 'public' AND nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
  LOOP EXECUTE format('DROP SCHEMA %I CASCADE', s); END LOOP;
END $$;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
SQL
  psql "$URL" -v ON_ERROR_STOP=1 -q -c "$ROLES_SQL" >/dev/null
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
  docker exec "$CONTAINER" psql -U postgres -d rekoda_drill -v ON_ERROR_STOP=1 -q -c "$ROLES_SQL" >/dev/null
  docker cp "$WORK/restore.dump" "$CONTAINER:/tmp/restore.dump"
  docker exec "$CONTAINER" pg_restore --no-owner -U postgres -d rekoda_drill /tmp/restore.dump
  PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d rekoda_drill -v ON_ERROR_STOP=1 -At)
fi
END=$(date +%s)

DRIFT=$("${PSQL[@]}" -c "SELECT count(*) FROM (SELECT business_id FROM ledger_entries GROUP BY business_id HAVING sum(debit_k) <> sum(credit_k)) d;")
BUSINESSES=$("${PSQL[@]}" -c 'SELECT count(*) FROM businesses;')
ENTRIES=$("${PSQL[@]}" -c 'SELECT count(*) FROM ledger_entries;')
INVOICES=$("${PSQL[@]}" -c 'SELECT count(*) FROM invoices;')

[ "$ENTRIES" -gt 0 ] || backup_die "DRILL FAILED: the restored database holds no ledger entries (an empty or data-less archive proves nothing)"
echo "restore-drill: object=$OBJECT restore_seconds=$((END - START)) businesses=$BUSINESSES ledger_entries=$ENTRIES invoices=$INVOICES unbalanced_businesses=$DRIFT"
[ "$DRIFT" = "0" ] || backup_die "DRILL FAILED: $DRIFT business(es) whose ledger does not balance"
echo "restore-drill: PASS"
