#!/usr/bin/env bash
# The production stack, booted from a clean checkout on a clean machine, and
# attacked (G-01). CI runs this on every change (the "Deployment" job); it
# follows docs/runbooks/deploy.md step for step, with placeholder values
# instead of real ones, and fails on the first thing that is not as the
# runbook says:
#
#   config and build; no secret in any image layer; images run as non-root;
#   PostgreSQL unreachable from the host; migrations as the owner, then the
#   runtime roles' passwords; the api and the worker refusing the owner
#   credential; the stack healthy; /health, the site, the legal facts, the
#   webhooks and the security headers through Caddy over HTTPS; a forged
#   X-Forwarded-For unable to reset the per-IP bucket; the worker claiming
#   and finishing a job; restarts and a full down/up losing nothing; a
#   rollback to the previous image by changing one line.
#
# It writes .env and secrets/ in the checkout and removes them (and the
# stack's volumes) on exit, so it refuses to run where a .env already exists.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.prod.yml)
SITE=rekoda.localhost
API=api.rekoda.localhost
WORK=$(mktemp -d)
FAILED=1

step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'DEPLOY SMOKE FAILED: %s\n' "$*" >&2
  exit 1
}
cleanup() {
  if [ "$FAILED" = 1 ] && [ -f .env ]; then
    printf '\n== logs (failure)\n'
    "${COMPOSE[@]}" ps -a || true
    "${COMPOSE[@]}" logs --no-color --tail 150 || true
  fi
  if [ -f .env ]; then "${COMPOSE[@]}" --profile ops down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf .env secrets "$WORK"
}

[ ! -e .env ] || fail '.env already exists; this test never overwrites a real one'
[ ! -e secrets ] || fail 'secrets/ already exists; this test never overwrites a real one'
trap cleanup EXIT

rand() { openssl rand -hex 32; }
set_env() {
  # Replace NAME's line (active or `# NAME=`) with NAME=value, or append it.
  local name=$1 value=$2
  if grep -qE "^(# )?${name}=" .env; then
    sed -i -E "s|^(# )?${name}=.*|${name}=${value}|" .env
  else
    printf '%s=%s\n' "$name" "$value" >>.env
  fi
}
health() { curl -fsS --resolve "$API:443:127.0.0.1" --cacert "$WORK/root.crt" "https://$API/health"; }
psql_owner() { "${COMPOSE[@]}" exec -T postgres psql -U rekoda_owner -d rekoda -v ON_ERROR_STOP=1 -tA -c "$1"; }

step 'a throwaway .env and owner secret (placeholders, generated here, nothing real)'
OWNER_PW=$(rand)
APP_PW=$(rand)
WORKER_PW=$(rand)
VAULT=$(rand)
MATCH=$(rand)
CONNECTION=$(rand)
API_SECRET=$(rand)
PEPPER=$(rand)
META_SECRET=$(rand)
VERIFY=$(rand)
# The runbook's layout: secrets/ is readable by the deploy user alone, and
# the file inside by the postgres and node users of the containers it is
# bind-mounted into, which compose (outside swarm) cannot re-own.
mkdir -m 700 secrets
printf '%s\n' "$OWNER_PW" >secrets/postgres_owner_password
chmod 644 secrets/postgres_owner_password
umask 077
cp .env.example .env
set_env REKODA_RELEASE ci-a
set_env REKODA_API_PUBLIC_URL "https://$API"
set_env REKODA_ACME_EMAIL ops@example.com
set_env REKODA_EDGE_PROXIES ''
set_env NEXT_PUBLIC_SITE_URL "https://$SITE"
set_env REKODA_WEB_URL "https://$SITE"
set_env REKODA_CORS_ORIGINS "https://$SITE"
set_env NEXT_PUBLIC_LEGAL_ENTITY CI-PLACEHOLDER-ENTITY
set_env NEXT_PUBLIC_LEGAL_RC_NUMBER RC-CI-000
set_env NEXT_PUBLIC_LEGAL_ADDRESS CI-PLACEHOLDER-ADDRESS
set_env NEXT_PUBLIC_PRIVACY_EMAIL privacy@example.com
set_env NEXT_PUBLIC_SUPPORT_EMAIL support@example.com
set_env DATABASE_URL "postgres://rekoda_app:$APP_PW@postgres:5432/rekoda"
set_env WORKER_DATABASE_URL "postgres://rekoda_worker:$WORKER_PW@postgres:5432/rekoda"
set_env VAULT_KEY "$VAULT"
set_env MATCH_KEY "$MATCH"
set_env CONNECTION_KEY "$CONNECTION"
set_env REKODA_API_SECRET "$API_SECRET"
set_env OTP_PEPPER "$PEPPER"
set_env META_APP_SECRET "$META_SECRET"
set_env META_VERIFY_TOKEN "$VERIFY"
set_env OPERATOR_OIDC_ISSUER https://idp.example.invalid/
set_env OPERATOR_OIDC_AUDIENCE rekoda-ci
set_env OPERATOR_OIDC_JWKS_URL https://idp.example.invalid/.well-known/jwks.json
set_env REKODA_RATE_LIMIT_MAX 20
printf '%s\n' "$OWNER_PW" "$APP_PW" "$WORKER_PW" "$VAULT" "$MATCH" "$CONNECTION" \
  "$API_SECRET" "$PEPPER" "$META_SECRET" "$VERIFY" >"$WORK/secrets.txt"
umask 022

step 'compose config'
"${COMPOSE[@]}" config -q

step 'build both images, tagged ci-a'
COMMIT=$(git rev-parse --short HEAD)
"${COMPOSE[@]}" build --build-arg "REKODA_COMMIT=$COMMIT"

step 'no secret reached an image: not in any layer, not in the config'
# Counted over the whole stream, never `grep -q`: under pipefail an early
# match kills `docker save` with SIGPIPE and the pipeline reads as a miss.
for image in rekoda-app:ci-a rekoda-web:ci-a; do
  hits=$(docker save "$image" | grep -a -c -F -f "$WORK/secrets.txt" || true)
  [ "${hits:-0}" = 0 ] || fail "$image contains one of the generated secrets"
  config=$(docker image inspect --format '{{json .Config.Env}}' "$image")
  if grep -E -q '"(VAULT_KEY|MATCH_KEY|CONNECTION_KEY|OTP_PEPPER|REKODA_API_SECRET|META_APP_SECRET|DATABASE_URL|WORKER_DATABASE_URL)=' <<<"$config"; then
    fail "$image bakes a secret-shaped variable"
  fi
done
echo 'ok'

step 'the images run as a non-root user and cannot rewrite their own code'
for image in rekoda-app:ci-a rekoda-web:ci-a; do
  uid=$(docker run --rm --entrypoint id "$image" -u)
  [ "$uid" != 0 ] || fail "$image runs as root"
done
docker run --rm --entrypoint sh rekoda-app:ci-a -c 'test -f /repo/apps/api/dist/main.js && test ! -w /repo/apps/api/dist/main.js' ||
  fail 'the app image can rewrite its own code'
docker run --rm --entrypoint sh rekoda-app:ci-a -c 'test -f /repo/packages/db/migrations/meta/_journal.json && test ! -e /repo/apps/api/src && test ! -e /repo/apps/web' ||
  fail 'the app image is missing its migrations or carries sources it does not run'
docker run --rm --entrypoint sh rekoda-web:ci-a -c 'grep -q CI-PLACEHOLDER-ENTITY /repo/apps/web/.next/server/app/terms.html' ||
  fail 'the web image was not built with its legal facts'
docker run --rm --entrypoint sh rekoda-web:ci-a -c 'test ! -w /repo/apps/web/.next/server/app/terms.html && test ! -w /repo/apps/web/.next/server && test -w /repo/apps/web/.next/cache' ||
  fail 'the web image can rewrite its compiled pages, or cannot write its cache'
echo 'ok'

step 'PostgreSQL starts, and is not reachable from the host'
"${COMPOSE[@]}" up -d --wait postgres
if "${COMPOSE[@]}" port postgres 5432 >/dev/null 2>&1; then fail 'postgres publishes a port'; fi
if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then fail 'something answers on 5432'; fi
echo 'ok'

step 'migrate: every migration as the owner, then the runtime roles'
"${COMPOSE[@]}" run --rm -T migrate | tee "$WORK/migrate.log"
grep -q '^applied: ' "$WORK/migrate.log" || fail 'migrate applied nothing'
grep -q '^runtime role passwords set: rekoda_app, rekoda_worker$' "$WORK/migrate.log" ||
  fail 'the runtime roles were not provisioned'
MIGRATIONS=$(jq '.entries | length' packages/db/migrations/meta/_journal.json)
[ "$(psql_owner 'SELECT count(*) FROM rekoda_migrations')" = "$MIGRATIONS" ] ||
  fail "expected $MIGRATIONS migrations recorded"

step 'the api and the worker refuse the owner credential (RLS boot check)'
OWNER_URL="postgres://rekoda_owner:$OWNER_PW@postgres:5432/rekoda"
if timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps -e "DATABASE_URL=$OWNER_URL" api >"$WORK/owner-api.log" 2>&1; then
  fail 'the api started as the owner'
fi
grep -q 'SUPERUSER' "$WORK/owner-api.log" || { cat "$WORK/owner-api.log"; fail 'the api did not name the bypass role'; }
if timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps -e "WORKER_DATABASE_URL=$OWNER_URL" worker >"$WORK/owner-worker.log" 2>&1; then
  fail 'the worker started with the owner as its worker credential'
fi
grep -q 'SUPERUSER' "$WORK/owner-worker.log" || { cat "$WORK/owner-worker.log"; fail 'the worker did not name the bypass role'; }
echo 'ok: both refused'

step 'the stack comes up healthy'
"${COMPOSE[@]}" up -d --wait --wait-timeout 300
for service in api worker web; do
  for container in $("${COMPOSE[@]}" ps -q "$service"); do
    seen=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}{{range .Mounts}}{{println .Destination}}{{end}}' "$container")
    if grep -q -F -e "$OWNER_PW" -e /run/secrets <<<"$seen"; then
      fail "$service holds the owner credential"
    fi
  done
done
echo 'ok: no serving process holds the owner credential'

step "Caddy's local CA (the .localhost hostnames get an internal certificate)"
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/root.crt" >/dev/null 2>&1; then break; fi
  sleep 2
done
[ -s "$WORK/root.crt" ] || fail 'Caddy never issued its local root'

step '/health through the proxy, over HTTPS'
for _ in $(seq 1 30); do health >"$WORK/health.json" 2>/dev/null && break || sleep 2; done
cat "$WORK/health.json"
echo
jq -e --arg c "$COMMIT" --argjson m "$MIGRATIONS" \
  '.status == "ok" and .database == "up" and .migrations == $m and .release == "ci-a" and .commit == $c' \
  "$WORK/health.json" >/dev/null || fail '/health does not report the release, commit and schema'
jq -e 'keys == ["commit","database","migrations","release","status"]' "$WORK/health.json" >/dev/null ||
  fail '/health says more than it should'

step 'the site through the proxy: pages, legal facts, headers, redirect'
site() { curl -sS --resolve "$SITE:443:127.0.0.1" --cacert "$WORK/root.crt" "$@"; }
[ "$(site -o /dev/null -w '%{http_code}' "https://$SITE/")" = 200 ] || fail 'the home page is not 200'
site "https://$SITE/terms" >"$WORK/terms.html"
grep -q CI-PLACEHOLDER-ENTITY "$WORK/terms.html" || fail '/terms does not show the built legal facts'
[ "$(site -o /dev/null -w '%{http_code}' "https://$SITE/sitemap.xml")" = 200 ] ||
  fail 'the sitemap (the one revalidating route) is not 200'
site -D - -o /dev/null "https://$SITE/" | tr -d '\r' >"$WORK/site-headers.txt"
grep -qi '^content-security-policy:' "$WORK/site-headers.txt" || fail 'the site sends no CSP'
grep -qi '^strict-transport-security:' "$WORK/site-headers.txt" || fail 'the site sends no HSTS'
if grep -qi '^server:' "$WORK/site-headers.txt"; then fail 'the site names its server'; fi
[ "$(curl -sS -o /dev/null -w '%{http_code}' --resolve "$SITE:80:127.0.0.1" "http://$SITE/")" = 308 ] ||
  fail 'plain HTTP is not redirected to HTTPS'
echo 'ok'

step 'the API host: headers, and the webhooks reach the API byte for byte'
api() { curl -sS --resolve "$API:443:127.0.0.1" --cacert "$WORK/root.crt" "$@"; }
api -D - -o /dev/null "https://$API/health" | tr -d '\r' >"$WORK/api-headers.txt"
grep -qi '^strict-transport-security:' "$WORK/api-headers.txt" || fail 'the API sends no HSTS'
grep -qi '^x-content-type-options: nosniff' "$WORK/api-headers.txt" || fail 'the API sends no nosniff'
if grep -qi '^server:' "$WORK/api-headers.txt"; then fail 'the API names its server'; fi
[ "$(api "https://$API/webhooks/meta?hub.mode=subscribe&hub.verify_token=$VERIFY&hub.challenge=4815162342")" = 4815162342 ] ||
  fail "Meta's handshake does not reach the API"
BODY='{"object":"whatsapp_business_account","entry":[]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_SECRET" | sed 's/^.* //')
[ "$(api -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -H "x-hub-signature-256: sha256=$SIG" --data-binary "$BODY" "https://$API/webhooks/meta")" = 200 ] ||
  fail 'a correctly signed Meta webhook was refused (the bytes changed on the way)'
[ "$(api -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -H 'x-hub-signature-256: sha256=00' --data-binary "$BODY" "https://$API/webhooks/meta")" = 401 ] ||
  fail 'an unsigned Meta webhook was accepted'
echo 'ok'

step 'a forged X-Forwarded-For cannot reset the per-IP bucket (G-43)'
limited=0
for i in $(seq 1 30); do
  code=$(api -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 198.51.100.$i" "https://$API/v1/auth/me")
  if [ "$code" = 429 ]; then
    limited=$i
    break
  fi
done
[ "$limited" != 0 ] || fail 'thirty requests with thirty forged addresses were never limited'
echo "ok: limited at request $limited despite a fresh forged address on each"

step 'the worker claims and finishes a job, with the worker and app roles over SCRAM'
"${COMPOSE[@]}" logs --no-color worker >"$WORK/worker.log"
"${COMPOSE[@]}" logs --no-color api >"$WORK/api.log"
grep -q 'job runner started' "$WORK/worker.log" || fail 'the worker did not start its runner'
grep -q 'job runner disabled' "$WORK/api.log" || fail 'the api is running jobs too'
JOB=$(psql_owner "WITH u AS (INSERT INTO users (phone) VALUES ('+2348000000001') RETURNING id),
  b AS (INSERT INTO businesses (name, owner_user_id) SELECT 'Deploy smoke probe', id FROM u RETURNING id)
  INSERT INTO jobs (business_id, kind) SELECT id, 'deploy.smoke.probe' FROM b RETURNING id")
JOB=$(head -n 1 <<<"$JOB")
state=''
for _ in $(seq 1 30); do
  state=$(psql_owner "SELECT state FROM jobs WHERE id = '$JOB'")
  [ "$state" = dead ] && break
  sleep 1
done
[ "$state" = dead ] || fail "the probe job is '$state', not claimed and settled by the worker"
reason=$(psql_owner "SELECT last_error FROM jobs WHERE id = '$JOB'")
grep -q 'no handler registered for job kind "deploy.smoke.probe"' <<<"$reason" ||
  fail 'the probe job was not settled by the runner'
echo 'ok'

step 'restarts lose nothing'
"${COMPOSE[@]}" restart api worker web
"${COMPOSE[@]}" up -d --wait --wait-timeout 300
"${COMPOSE[@]}" down
"${COMPOSE[@]}" up -d --wait --wait-timeout 300
for _ in $(seq 1 30); do health >"$WORK/health.json" 2>/dev/null && break || sleep 2; done
jq -e --argjson m "$MIGRATIONS" '.status == "ok" and .migrations == $m' "$WORK/health.json" >/dev/null ||
  fail 'the schema did not survive a down and up'
[ "$(psql_owner "SELECT state FROM jobs WHERE id = '$JOB'")" = dead ] || fail 'the probe job did not survive'
"${COMPOSE[@]}" run --rm -T migrate | tee "$WORK/migrate-again.log"
grep -q '^already up to date$' "$WORK/migrate-again.log" || fail 'a second migrate was not a no-op'
echo 'ok'

step 'deploy ci-b, then roll back to ci-a by changing one line'
set_env REKODA_RELEASE ci-b
"${COMPOSE[@]}" build --build-arg "REKODA_COMMIT=$COMMIT"
"${COMPOSE[@]}" up -d --wait --wait-timeout 300
for _ in $(seq 1 30); do health >"$WORK/health.json" 2>/dev/null && jq -e '.release == "ci-b"' "$WORK/health.json" >/dev/null && break || sleep 2; done
jq -e '.release == "ci-b"' "$WORK/health.json" >/dev/null || fail 'ci-b is not what answers'
set_env REKODA_RELEASE ci-a
"${COMPOSE[@]}" up -d --wait --wait-timeout 300
for _ in $(seq 1 30); do health >"$WORK/health.json" 2>/dev/null && jq -e '.release == "ci-a"' "$WORK/health.json" >/dev/null && break || sleep 2; done
jq -e '.release == "ci-a" and .status == "ok"' "$WORK/health.json" >/dev/null ||
  fail 'the rollback to ci-a did not take'
echo 'ok: rolled back without a rebuild'

step "Caddy reloads the checked-out Caddyfile (the runbook's last deploy step)"
"${COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
health >"$WORK/health.json" || fail '/health stopped answering after the reload'
echo 'ok'

step 'nothing tried to write where the images keep code read-only'
"${COMPOSE[@]}" logs --no-color api worker web >"$WORK/all.log"
if grep -E -q 'EACCES|EROFS|read-only file system' "$WORK/all.log"; then
  grep -E -m 20 'EACCES|EROFS|read-only file system' "$WORK/all.log" || true
  fail 'a service tried to write to a read-only path'
fi
echo 'ok'

FAILED=0
printf '\nDEPLOY SMOKE PASSED\n'
