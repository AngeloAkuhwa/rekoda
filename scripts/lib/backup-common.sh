#!/usr/bin/env bash
# Shared by scripts/backup-db.sh and scripts/restore-drill.sh (G-02).
# Sourced, never executed. Encryption is openssl AES-256-CBC with PBKDF2 and a
# passphrase read from a FILE (never an argument, never the environment of a
# child). Objects are named rekoda-<UTC stamp>.dump.enc with a .sha256 beside.

backup_die() { echo "backup: $*" >&2; exit 1; }

# Fails closed: nothing runs with a missing destination or a weak passphrase.
backup_require_config() {
  [ -n "${BACKUP_DEST:-}" ] || backup_die "BACKUP_DEST is not set (a directory or s3://bucket/prefix)"
  [ -n "${BACKUP_PASSPHRASE_FILE:-}" ] || backup_die "BACKUP_PASSPHRASE_FILE is not set"
  [ -r "$BACKUP_PASSPHRASE_FILE" ] || backup_die "BACKUP_PASSPHRASE_FILE is not readable"
  # openssl reads only the first line of a -pass file, so measure that line.
  [ "$(printf '%s' "$(head -n 1 "$BACKUP_PASSPHRASE_FILE" | tr -d '\r')" | wc -c)" -ge 32 ] \
    || backup_die "the passphrase (first line of the file) must be at least 32 bytes"
  command -v openssl >/dev/null || backup_die "openssl is required"
  case "$BACKUP_DEST" in
    s3://*) command -v aws >/dev/null || backup_die "aws cli is required for an s3:// destination" ;;
    *) [ -d "$BACKUP_DEST" ] || backup_die "BACKUP_DEST directory does not exist: $BACKUP_DEST" ;;
  esac
}

_backup_aws() {
  if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then aws --endpoint-url "$BACKUP_S3_ENDPOINT" "$@"; else aws "$@"; fi
}

backup_encrypt() { # in out
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$1" -out "$2"
}
backup_decrypt() { # in out
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$1" -out "$2" \
    || backup_die "decryption failed (wrong passphrase or damaged object)"
}

backup_sha256() { sha256sum "$1" | cut -d' ' -f1; }

backup_put() { # local-file remote-name
  case "$BACKUP_DEST" in
    s3://*) _backup_aws s3 cp --only-show-errors "$1" "${BACKUP_DEST%/}/$2" ;;
    *) cp "$1" "$BACKUP_DEST/$2.part" && mv "$BACKUP_DEST/$2.part" "$BACKUP_DEST/$2" || { rm -f "$BACKUP_DEST/$2.part"; return 1; } ;;
  esac
}
backup_get() { # remote-name local-file
  case "$BACKUP_DEST" in
    s3://*) _backup_aws s3 cp --only-show-errors "${BACKUP_DEST%/}/$1" "$2" ;;
    *) cp "$BACKUP_DEST/$1" "$2" ;;
  esac
}
backup_delete() { # remote-name
  case "$BACKUP_DEST" in
    s3://*) _backup_aws s3 rm --only-show-errors "${BACKUP_DEST%/}/$1" ;;
    *) rm -f "$BACKUP_DEST/$1" ;;
  esac
}
backup_list() { # prints object names, oldest first
  case "$BACKUP_DEST" in
    s3://*) _backup_aws s3 ls "${BACKUP_DEST%/}/" | awk '{print $4}' | grep -E '^rekoda-.*\.dump\.enc$' | sort || true ;;
    *) (cd "$BACKUP_DEST" && ls -1 | grep -E '^rekoda-.*\.dump\.enc$' | sort) || true ;;
  esac
}

# Fetch the newest object (or $1), check its checksum, decrypt to $2.
# Prints the object name.
backup_fetch_decrypt() { # [name] out-file
  # A subshell with its own EXIT trap: the temp copy of the encrypted dump is
  # removed on every path, including backup_die's exit, without touching the
  # caller's traps.
  (
    local name="${1:-}" out="$2" tmp
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    [ -n "$name" ] || name=$(backup_list | tail -n 1)
    [ -n "$name" ] || backup_die "no backup found in $BACKUP_DEST"
    backup_get "$name" "$tmp/obj" || backup_die "cannot fetch $name"
    backup_get "$name.sha256" "$tmp/sum" || backup_die "cannot fetch the checksum of $name"
    [ "$(backup_sha256 "$tmp/obj")" = "$(cut -d' ' -f1 "$tmp/sum")" ] || backup_die "checksum mismatch for $name"
    backup_decrypt "$tmp/obj" "$out"
    [ "$(head -c 5 "$out")" = "PGDMP" ] || backup_die "$name did not decrypt to a pg_dump custom archive"
    echo "$name"
  )
}

# Every function's owner, one "schema name(argument types) owner" line each, sorted bytewise. The
# restore drill compares the dump's list (`pg_restore -l`, read on stdin by backup_toc_function_owners)
# with the restored database's (BACKUP_FUNCTION_OWNERS_SQL) line by line, so a SECURITY DEFINER
# function handed to the wrong role fails the drill even while every writer role still owns some.
# Extension members are not in a dump, so they are left out of the database's list too.
BACKUP_FUNCTION_OWNERS_SQL="SELECT n.nspname || ' ' || p.proname || '(' || oidvectortypes(p.proargtypes) || ') ' || r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner WHERE p.prokind = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')"
backup_toc_function_owners() { # stdin: pg_restore -l output
  LC_ALL=C awk '$4 == "FUNCTION" { sub(/^[^ ]+ [^ ]+ [^ ]+ FUNCTION /, ""); print }' | LC_ALL=C sort
}
backup_function_owner_mismatches() { # expected-file actual-file; prints each differing line
  LC_ALL=C comm -3 <(LC_ALL=C sort "$1") <(LC_ALL=C sort "$2")
}
