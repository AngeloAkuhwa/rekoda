#!/usr/bin/env bash
# Nightly encrypted logical backup of the Rekoda database to an off-box
# destination (G-02; the logical half of ADR 0010 and docs/runbooks/backup-restore.md).
# Run on the host by a systemd timer (see the runbook), never from CI.
#
#   BACKUP_DEST             directory (a mounted off-box volume) or s3://bucket/prefix
#   BACKUP_PASSPHRASE_FILE  file holding the passphrase (>= 32 bytes), mode 0600
#   BACKUP_S3_ENDPOINT      optional, for R2 / B2 S3-compatible endpoints
#   BACKUP_DUMP_CMD         optional; must write a pg_dump -Fc archive to stdout.
#                           Default: pg_dump inside the production compose postgres.
#   BACKUP_RETAIN_DAYS      directory destinations only (default 30); for s3:// set a
#                           bucket lifecycle rule instead.
#
# Fails closed: a missing setting, an empty or non-archive dump, or an upload that
# does not read back with the same checksum is a non-zero exit (a failed unit; no
# notifier consumes it yet, see the runbook). The passphrase and the dump never appear in an argument or a log.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/backup-common.sh
. scripts/lib/backup-common.sh

backup_require_config
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"
case "$RETAIN_DAYS" in '' | *[!0-9]* | 0) backup_die "BACKUP_RETAIN_DAYS must be a positive whole number of days" ;; esac
umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# Directory destinations: age out old objects and stale staging files BEFORE the
# upload, so a full destination can recover instead of failing every night.
# (s3:// uses a bucket lifecycle rule; keep at least one version, see the runbook.)
case "$BACKUP_DEST" in
  s3://*) ;;
  *) find "$BACKUP_DEST/" -maxdepth 1 -type f -name 'rekoda-*.dump.enc*' -mtime "+$RETAIN_DAYS" -delete || true ;;
esac
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="rekoda-$STAMP-$$.dump.enc"

if [ -n "${BACKUP_DUMP_CMD:-}" ]; then
  bash -o pipefail -c "$BACKUP_DUMP_CMD" >"$WORK/dump"
else
  docker compose -f docker-compose.prod.yml exec -T postgres \
    pg_dump -U rekoda_owner -d rekoda -Fc >"$WORK/dump"
fi
[ -s "$WORK/dump" ] || backup_die "the dump is empty"
[ "$(head -c 5 "$WORK/dump")" = "PGDMP" ] || backup_die "the dump is not a pg_dump custom archive"

backup_encrypt "$WORK/dump" "$WORK/$NAME"
rm -f "$WORK/dump"
backup_sha256 "$WORK/$NAME" >"$WORK/$NAME.sha256"

# Stage under a name backup_list never selects, read it back, and only then
# publish: checksum first, the listed object last. A failure at any step leaves
# the previous backup as the newest one, never a half-published object.
# A staged object that never gets published is removed, success or failure.
trap 'rm -rf "$WORK"; backup_delete "$NAME.pending" >/dev/null 2>&1 || true' EXIT
backup_put "$WORK/$NAME" "$NAME.pending"
backup_get "$NAME.pending" "$WORK/readback"
[ "$(backup_sha256 "$WORK/readback")" = "$(cat "$WORK/$NAME.sha256")" ] \
  || backup_die "read-back checksum mismatch for $NAME; the backup is NOT trusted"
backup_put "$WORK/$NAME.sha256" "$NAME.sha256"
backup_put "$WORK/$NAME" "$NAME"
backup_delete "$NAME.pending" || true

echo "backup: ok $NAME $(stat -c %s "$WORK/$NAME") bytes"
