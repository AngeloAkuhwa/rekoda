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
  [ "$(wc -c <"$BACKUP_PASSPHRASE_FILE")" -ge 32 ] || backup_die "the passphrase must be at least 32 bytes"
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
    *) cp "$1" "$BACKUP_DEST/$2.part" && mv "$BACKUP_DEST/$2.part" "$BACKUP_DEST/$2" ;;
  esac
}
backup_get() { # remote-name local-file
  case "$BACKUP_DEST" in
    s3://*) _backup_aws s3 cp --only-show-errors "${BACKUP_DEST%/}/$1" "$2" ;;
    *) cp "$BACKUP_DEST/$1" "$2" ;;
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
  local name="${1:-}" out="$2" tmp
  [ -n "$name" ] || name=$(backup_list | tail -n 1)
  [ -n "$name" ] || backup_die "no backup found in $BACKUP_DEST"
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  backup_get "$name" "$tmp/obj" || backup_die "cannot fetch $name"
  backup_get "$name.sha256" "$tmp/sum" || backup_die "cannot fetch the checksum of $name"
  [ "$(backup_sha256 "$tmp/obj")" = "$(cut -d' ' -f1 "$tmp/sum")" ] || backup_die "checksum mismatch for $name"
  backup_decrypt "$tmp/obj" "$out"
  [ "$(head -c 5 "$out")" = "PGDMP" ] || backup_die "$name did not decrypt to a pg_dump custom archive"
  echo "$name"
}
