#!/usr/bin/env bash
# Deploy one exact commit to the staging host. The runbook's "Deploy a
# release" sequence (docs/runbooks/deploy.md), for a commit rather than a tag:
#
#   bash scripts/deploy-staging.sh <40-character commit SHA>
#
# .github/workflows/deploy-staging.yml runs it on the host over SSH after CI
# has passed on main, piping the copy from the commit being deployed, so the
# script that runs is always the one that commit carries. An operator on the
# host can run it by hand the same way.
#
# What it refuses, before anything live is touched:
#   - a SHA that is not 40 hex characters, is not on origin/main, or is not
#     in the repository at all;
#   - a checkout with tracked local modifications, or holding any file that is
#     not in the commit other than the host-local paths .dockerignore keeps
#     out of every image (the build context is the checkout);
#   - a host whose .env is not staging's (REKODA_API_PUBLIC_URL must be the
#     staging API), so a mis-set STAGING_HOST can never deploy production;
#   - a running staging that is not healthy, or is not the release and commit
#     the checkout and .env name (the rollback this run would print);
#   - a second deployment while one is running.
#
# It never runs `down -v`, never prunes an image and never touches secrets/:
# the only change to .env is its REKODA_RELEASE line. The previous release's
# images stay on the host, which is what makes a rollback a no-build change
# (see "Roll back" in the runbook).
#
# CI keeps this file and the runbook in step: scripts/check-staging-deploy.mjs.
set -Eeuo pipefail

# One brace group, closed by the last line: bash reads all of it before it
# runs any of it. Run from a file, the checkout below replaces this file, and
# bash reading the rest of a script as it goes would read the new commit's
# bytes at the old commit's offsets.
{
REKODA_DIR=/opt/rekoda
API_URL=https://staging-api.myrekoda.com
EDGE_NETWORK=rekoda-prod_edge
EDGE_EXPECTED='172.30.10.1 false'

dc() { docker compose -f docker-compose.prod.yml "$@"; }
step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'STAGING DEPLOY REFUSED: %s\n' "$*" >&2
  exit 1
}

# Where the run got to, so a failure says what state it left behind.
#   checks    nothing on the host has changed
#   prepared  the checkout and .env name the new release; nothing live changed
#   live      migrate or `up` has run; the running stack may be the new one
PHASE=checks
PREV_SHA=
PREV_RELEASE=
RELEASE=

restore_prepared() {
  # Nothing live changed, so put the checkout and REKODA_RELEASE back to what
  # the running containers are, leaving the host exactly as it was.
  printf 'restoring the checkout to %s and REKODA_RELEASE to %s\n' "$PREV_SHA" "$PREV_RELEASE" >&2
  git -c advice.detachedHead=false checkout -q "$PREV_SHA" || true
  sed -i "s/^REKODA_RELEASE=.*/REKODA_RELEASE=${PREV_RELEASE}/" .env || true
}

on_exit() {
  local status=$?
  [ "$status" -eq 0 ] && return
  case "$PHASE" in
    checks) ;;
    prepared)
      printf '\nSTAGING DEPLOY FAILED before anything live changed.\n' >&2
      restore_prepared
      ;;
    live)
      printf '\nSTAGING DEPLOY FAILED after migrate/up started: the stack may be part-way to %s.\n' "$RELEASE" >&2
      printf 'Inspect with `dc ps -a` and `dc logs <service>` on the host. To roll back, from %s:\n' "$REKODA_DIR" >&2
      printf '  git checkout %s\n' "$PREV_SHA" >&2
      printf "  sed -i 's/^REKODA_RELEASE=.*/REKODA_RELEASE=%s/' .env\n" "$PREV_RELEASE" >&2
      printf '  dc up -d --wait --wait-timeout 300\n' >&2
      printf '  dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile\n' >&2
      dc ps -a >&2 || true
      ;;
  esac
}
trap on_exit EXIT
trap 'printf "failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

SHA=${1:-}
[ "$#" -eq 1 ] || fail 'usage: deploy-staging.sh <40-character commit SHA>'
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'the commit must be a full 40-character lowercase SHA'

step 'preflight'
for tool in git docker curl jq flock timeout sed; do
  command -v "$tool" >/dev/null || fail "$tool is not installed on this host"
done
docker compose version >/dev/null || fail 'the docker compose plugin is not installed'
cd "$REKODA_DIR"
[ -f docker-compose.prod.yml ] || fail "$REKODA_DIR is not a Rekoda checkout"
[ -f .env ] || fail "$REKODA_DIR/.env is missing"
[ -d secrets ] || fail "$REKODA_DIR/secrets is missing"

# One deployment at a time on this host, whoever started it. The lock lives in
# .git, which is never part of the checkout and never in an image.
exec 9>.git/rekoda-deploy-staging.lock
flock -n 9 || fail 'another staging deployment is running on this host'

# This must be staging. Read only the one non-secret line; nothing else in
# .env is read or printed.
api_public=$(sed -n 's/^REKODA_API_PUBLIC_URL=//p' .env)
[ "$api_public" = "$API_URL" ] ||
  fail "this host's REKODA_API_PUBLIC_URL is not $API_URL; this script deploys staging only"
[ "$(grep -c '^REKODA_RELEASE=' .env)" = 1 ] || fail '.env must hold exactly one REKODA_RELEASE= line'
PREV_RELEASE=$(sed -n 's/^REKODA_RELEASE=//p' .env)

[ -z "$(git status --porcelain --untracked-files=no)" ] ||
  fail 'the checkout has tracked local modifications; resolve them by hand first'
# The build context is the checkout (`COPY . .`), so a file the commit does not
# hold, ignored by git or not, would be built into staging without CI having
# seen it. Only the host-local paths .dockerignore keeps out of every image may
# sit in the checkout; scripts/check-staging-deploy.mjs holds the two in step.
HOST_LOCAL='^((.+/)?\.env(\.[^/]+)?|(secrets|data|uploads|storage|logs|backups)/.*|[^/]+\.log)$'
stray=$(git -c core.quotePath=false ls-files --others --directory --no-empty-directory | grep -Ev "$HOST_LOCAL" || true)
[ -z "$stray" ] ||
  fail "the checkout holds paths no commit has, which the image build would include; move them out of $REKODA_DIR first: $(head -n 20 <<<"$stray" | tr '\n' ' ')"
PREV_SHA=$(git rev-parse HEAD)

# PREV_SHA and PREV_RELEASE are the rollback this run prints if it fails, so
# prove staging is running them now, rather than assume the checkout and .env
# agree with the containers. /health holds only public deployment metadata.
step 'the running release is the rollback baseline'
running=$(curl -fsS --max-time 10 --retry 2 --retry-delay 5 "$API_URL/health") ||
  fail "$API_URL/health did not answer, so the running release cannot be confirmed"
jq -e --arg pr "$PREV_RELEASE" --arg ps "$PREV_SHA" \
  '.commit as $c | .status == "ok" and .database == "up" and .release == $pr
   and ($c | type) == "string" and ($c | length) >= 7 and ($ps | startswith($c))' \
  <<<"$running" >/dev/null ||
  fail "$API_URL/health reports $(jq -c '{status, database, release, commit}' <<<"$running" 2>/dev/null || echo 'an unreadable body'), not a healthy $PREV_RELEASE at $PREV_SHA as this checkout and .env say"

step 'fetch and verify the commit'
git fetch --prune origin
git cat-file -e "${SHA}^{commit}" 2>/dev/null || fail "commit $SHA is not in origin"
git merge-base --is-ancestor "$SHA" origin/main || fail "commit $SHA is not on origin/main"

SHORT=$(git rev-parse --short=7 "$SHA")
RELEASE="staging-${SHORT}"
# Compose interpolates the image tags from the shell before .env, so pin the
# shell to the same value the file is about to hold.
export REKODA_RELEASE="$RELEASE"
printf 'deploying %s as %s (previously %s at %s)\n' "$SHA" "$RELEASE" "$PREV_RELEASE" "$PREV_SHA"

step 'check out the commit and name the release'
PHASE=prepared
git -c advice.detachedHead=false checkout -q --detach "$SHA"
[ "$(git rev-parse HEAD)" = "$SHA" ] || fail 'the checkout is not at the requested commit'
sed -i "s/^REKODA_RELEASE=.*/REKODA_RELEASE=${RELEASE}/" .env
[ "$(sed -n 's/^REKODA_RELEASE=//p' .env)" = "$RELEASE" ] || fail 'REKODA_RELEASE was not updated in .env'
MIGRATIONS=$(jq '.entries | length' packages/db/migrations/meta/_journal.json)

step "build both images, tagged $RELEASE (nothing live changes)"
dc config -q
dc build --build-arg REKODA_COMMIT="$SHORT"

step 'migrate (expand-only, as the owner)'
PHASE=live
dc run --rm -T migrate

step 'start the new release'
dc up -d --wait --wait-timeout 300

step 'reload the Caddyfile this commit carries'
dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile

step 'the edge network is the one the edge check knows (G-75)'
edge=$(docker network inspect "$EDGE_NETWORK" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}} {{.EnableIPv6}}')
[ "$edge" = "$EDGE_EXPECTED" ] || fail "$EDGE_NETWORK reports '$edge', expected '$EDGE_EXPECTED'"

step "$API_URL/health names this release"
health=
for _ in $(seq 1 30); do
  if health=$(curl -fsS --max-time 10 "$API_URL/health") &&
    jq -e --arg r "$RELEASE" --arg c "$SHORT" \
      '.status == "ok" and .database == "up" and .release == $r and .commit == $c' <<<"$health" >/dev/null; then
    break
  fi
  health=
  sleep 5
done
[ -n "$health" ] || fail "$API_URL/health never reported status ok, database up, release $RELEASE and commit $SHORT"
printf '%s\n' "$health"
# At least, not exactly: a deliberate redeploy of an older commit runs against
# the newer schema, which expand-only migrations allow.
jq -e --argjson m "$MIGRATIONS" '.migrations >= $m' <<<"$health" >/dev/null ||
  fail "/health reports fewer migrations than the $MIGRATIONS this commit carries"
[[ "$SHA" == "$(jq -r .commit <<<"$health")"* ]] || fail '/health names a commit that is not the deployed SHA'

step 'running containers'
dc ps
PHASE=done
printf '\nstaging is %s (%s)\n' "$RELEASE" "$SHA"
exit 0
}
