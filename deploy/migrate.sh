#!/bin/sh
# The deploy's migrate job: `docker compose -f docker-compose.prod.yml run
# --rm migrate` (docs/runbooks/deploy.md). Two steps, both as the OWNER:
#
#   1. apply every pending migration (packages/db/src/migrate.ts), which
#      refuses a role without SUPERUSER or BYPASSRLS;
#   2. give rekoda_app and rekoda_worker the passwords their URLs in .env
#      carry (packages/db/src/provision.ts), which refuses a URL naming any
#      other role.
#
# The owner password arrives as a mounted secret file and becomes a URL only
# here, inside this short-lived container: no long-running service, and no
# `docker inspect` of any container, ever holds it.
set -eu

secret=/run/secrets/postgres_owner_password
if [ ! -r "$secret" ]; then
  echo "migrate: $secret is not mounted (see secrets/ in docs/runbooks/deploy.md)" >&2
  exit 1
fi
password=$(cat "$secret")
case "$password" in
  '' | *[!0-9A-Za-z]*)
    echo 'migrate: the owner password must be letters and digits only (openssl rand -hex 32)' >&2
    exit 1
    ;;
esac
if [ "${#password}" -lt 24 ]; then
  echo 'migrate: the owner password must be at least 24 characters (openssl rand -hex 32)' >&2
  exit 1
fi

# The runtime URLs, as .env gives them to the api and the worker (this job
# loads the same file), before DATABASE_URL is replaced by the owner's.
APP_DATABASE_URL="${DATABASE_URL:?DATABASE_URL (the rekoda_app URL) is not set in .env}"
WORKER_DATABASE_URL="${WORKER_DATABASE_URL:?WORKER_DATABASE_URL is not set in .env}"
export APP_DATABASE_URL WORKER_DATABASE_URL

DATABASE_URL="postgres://${POSTGRES_OWNER:?}:${password}@${POSTGRES_HOST:?}:5432/${POSTGRES_DB:?}"
export DATABASE_URL

node /repo/packages/db/dist/migrate.js
node /repo/packages/db/dist/provision.js
