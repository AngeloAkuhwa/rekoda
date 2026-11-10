#!/usr/bin/env bash
# Deploy one exact commit to the staging host. The runbook's "Deploy a
# release" sequence (docs/runbooks/deploy.md), for a commit rather than a tag:
#
#   git show origin/main:scripts/deploy-staging.sh | bash -s -- [--newer-only] <40-character commit SHA>
#
# .github/workflows/deploy-staging.yml runs it on the host over SSH, piping a
# copy that has passed CI on main (the driver): after CI, the copy of the
# commit just deployed, with --newer-only; for a manual redeploy, main's tip,
# never the copy an older commit carries, which may be older and less
# careful. The SHA only chooses what is checked out and built. By hand, run
# origin/main's copy the same way (see the runbook).
#
# --newer-only (automatic runs): if staging already runs a newer commit of
# main, change nothing and exit 75, which the workflow reports as skipped.
# Deployments are serialised but not ordered, so a delayed run for an older
# commit would otherwise roll staging back silently.
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
#   - a commit whose code does not know the schema staging already has: one
#     missing a migration the running commit carries, or carrying fewer
#     migrations than the database has applied;
#   - a host with less than MIN_MEM_KB of memory available (MemAvailable)
#     before the api build or the web build, which run one after the other,
#     never together;
#   - a second deployment while one is running.
#
# It never runs `down -v`, never touches a volume (the database lives in one)
# and never touches secrets/: the only change to .env is its REKODA_RELEASE
# line. It frees disk only through prune_releases, which removes nothing but
# older rekoda-app/rekoda-web staging-<sha> tags that are not the release
# .env names, this run's baseline and target, a release an unfinished marker
# names, or an image any container uses; the previous release's images stay
# on the host, which is what makes a rollback a no-build change (see "Roll
# back" in the runbook). A host with less than MIN_FREE_KB free on the
# checkout or on Docker's root is cleaned that way once, then refused.
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
# The OWN-86 pre-start smoke query, printed for an operator fixing forward by hand.
print_smoke_0196() {
  if [[ " $BREAKING " == *' 0196_plan_fields_guard '* ]]; then
    printf 'Pre-start database smoke (OWN-86): dc exec -T postgres psql -U rekoda_owner -d rekoda -v ON_ERROR_STOP=1 -tA -c "%s"\n' "$SMOKE_0196_SQL" >&2
  fi
}
step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'STAGING DEPLOY REFUSED: %s\n' "$*" >&2
  exit 1
}

# Where the run got to, so a failure says what state it left behind.
#   checks    nothing on the host has changed
#   skipped   --newer-only and staging runs a newer commit; nothing changed
#   prepared  the checkout and .env name the new release; nothing live changed
#   live      migrate or `up` has run; the running stack may be the new one
PHASE=checks
# Migrations the previous release cannot run against (OD-48): the api and worker are stopped before
# any of them is applied, and the old release is never restarted against a database that has one.
COMPAT_BREAKING_MIGRATIONS='0196_plan_fields_guard'
BREAKING=
BREAKING_APPLIED=false
# Set once migrate has been entered for a release carrying a breaking migration. migrate applies each
# file in its own transaction, so from here whether 0196 committed is unknown (OWN-86).
MIGRATE_ENTERED=false
# Set just before `up`: a failure after migrate but before it (the 0196 smoke) has started nothing.
UP_ENTERED=false
# The OWN-86 pre-start database smoke for 0196, run as the owner between migrate and `up`. It prints
# `t` only when the ledger row, the guard trigger (enabled in origin or always mode, so it fires), both
# plan functions owned by rekoda_plan_writer, and the runtime roles' separation from it all hold.
SMOKE_0196_SQL="SELECT
  (SELECT count(*) FROM rekoda_migrations WHERE tag = '0196_plan_fields_guard') = 1
  AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'businesses_plan_fields_guard'
        AND tgrelid = 'public.businesses'::regclass AND tgenabled IN ('O', 'A')) = 1
  AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('subscription_write_plan', 'subscription_expire_plan')
        AND proowner = 'rekoda_plan_writer'::regrole) = 2
  AND NOT pg_has_role('rekoda_app', 'rekoda_plan_writer', 'MEMBER')
  AND NOT pg_has_role('rekoda_worker', 'rekoda_plan_writer', 'MEMBER')"
PREV_SHA=
PREV_RELEASE=
# The exit status meaning "skipped, nothing changed"; no failure may use it.
SKIPPED=75
# A marker from a run killed after migrate or `up` began: the stack may be
# part-way to its release, so this run must finish a deploy, never skip.
LIVE_MARKER=false
RELEASE=
PREPARED_SHA=
# The baseline release of an interrupted live deploy this run finishes: when the
# retry re-deploys the release already running, that baseline is the rollback.
MARKER_PREV_RELEASE=

# What a run leaves behind if it is killed where no trap can run (SIGKILL, a
# runner torn down): the phase it reached and the baseline it started from.
# It lives in .git, so it is never part of the checkout or an image.
STATE=.git/rekoda-deploy-staging.state
# The release the running one replaced, kept across runs so a cleanup before the
# next deploy never removes the no-build rollback. Written only after a deploy
# is verified.
ROLLBACK_FILE=.git/rekoda-deploy-staging.rollback
# Written to a temporary file and renamed over the marker, so a kill mid-write
# leaves the previous complete marker (or none), never a truncated one.
write_state() {
  # An earlier run's live marker outranks this run's prepared one: the stack may
  # still be part-way to that release, and only a deploy that runs to the end
  # clears it.
  [ "$LIVE_MARKER" = true ] && [ "$1" = prepared ] && return 0
  # A live marker rewritten for the release already running keeps the baseline
  # the interrupted deploy started from: it is the only record of the rollback.
  local prev_rel=$PREV_RELEASE
  if [ "$1" = live ] && [ -n "$MARKER_PREV_RELEASE" ] && [ "$PREV_RELEASE" = "$RELEASE" ]; then
    prev_rel=$MARKER_PREV_RELEASE
  fi
  printf 'phase=%s\nprev_sha=%s\nprev_release=%s\nsha=%s\nrelease=%s\n' \
    "$1" "$PREV_SHA" "$prev_rel" "$SHA" "$RELEASE" >"$STATE.tmp" ||
    { [ "$1" = prepared ] && PHASE=checks; return 1; }
  # The first marker could not be written (a full disk): nothing has changed yet,
  # so the run ends as a refusal, not as a failed restore.
  mv -f "$STATE.tmp" "$STATE" ||
    { [ "$1" = prepared ] && PHASE=checks; return 1; }
}
state_value() { sed -n "s/^$1=//p" "$STATE"; }

# Free space (KiB) the checkout and Docker's root must each have before a build
# starts: the images, the build cache and the checkout itself all grow on them.
MIN_FREE_KB=8388608
# A host may demand more, never less than the floor above.
if [[ "${REKODA_DEPLOY_MIN_FREE_KB:-}" =~ ^[0-9]+$ ]] && [ "$REKODA_DEPLOY_MIN_FREE_KB" -gt "$MIN_FREE_KB" ]; then
  MIN_FREE_KB=$REKODA_DEPLOY_MIN_FREE_KB
fi
LOW_PATH=
LOW_KB=
# Succeeds, naming the path, when a filesystem the deploy writes to is short of
# space. An unreadable figure counts as short: never build on a guess.
disk_low() {
  local root path kb
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  for path in "$REKODA_DIR" "${root:-/var/lib/docker}"; do
    [ -d "$path" ] || continue
    kb=$(df -Pk "$path" 2>/dev/null | awk 'NR==2 { print $4 }')
    if ! [[ "$kb" =~ ^[0-9]+$ ]] || [ "$kb" -lt "$MIN_FREE_KB" ]; then
      LOW_PATH=$path
      LOW_KB=${kb:-unknown}
      return 0
    fi
  done
  return 1
}

# Memory (KiB) the host must have available before an image build starts. The
# host is small (4 GB) and a build of either image can use most of it: the one
# build that tried to do both at once starved the host of memory, and its
# SSH and Docker daemon with it. A build that would start below the floor is
# refused instead, while nothing live has changed. A host may demand more,
# never less than the floor above.
MIN_MEM_KB=1048576
if [[ "${REKODA_DEPLOY_MIN_MEM_KB:-}" =~ ^[0-9]+$ ]] && [ "$REKODA_DEPLOY_MIN_MEM_KB" -gt "$MIN_MEM_KB" ]; then
  MIN_MEM_KB=$REKODA_DEPLOY_MIN_MEM_KB
fi
# Succeeds, setting MEM_KB, when the kernel's own estimate of memory available
# without swapping (MemAvailable, which counts reclaimable cache) is below the
# floor. An unreadable figure counts as short: never build on a guess.
MEM_KB=
mem_low() {
  MEM_KB=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo 2>/dev/null || true)
  if ! [[ "$MEM_KB" =~ ^[0-9]+$ ]]; then
    MEM_KB=unknown
    return 0
  fi
  [ "$MEM_KB" -lt "$MIN_MEM_KB" ]
}
# Says how much memory is available, so a deploy's output shows what each build
# left (the floor is tuned from these figures).
log_memory() {
  printf 'memory available %s: %s KiB\n' "$1" "$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo 2>/dev/null || echo unknown)"
}
# Refuses, naming the build it was about to start, when memory is short.
require_memory() {
  if mem_low; then
    fail "only $MEM_KB KiB of memory available $1 (a deploy needs at least $MIN_MEM_KB): a build on a host this short can starve it of memory, SSH and Docker included. Stop whatever else is using memory (another build, a stuck container) and deploy again. Nothing live was changed by this run"
  fi
}

# The releases whose images must survive any cleanup, one per line: the one
# .env names, this run's baseline and target, both releases of an unfinished
# marker, and every release a container (running or stopped: none is assumed
# disposable) uses. Fails when the marker cannot be read or Docker cannot say
# what is in use, and then nothing is removed.
keep_releases() {
  local key r
  printf '%s\n' "$PREV_RELEASE" "$RELEASE"
  sed -n 's/^REKODA_RELEASE=//p' .env
  if [ -f "$STATE" ]; then
    for key in prev_release release; do
      r=$(state_value "$key")
      [[ "$r" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
      printf '%s\n' "$r"
    done
  fi
  if [ -f "$ROLLBACK_FILE" ]; then
    r=$(sed -n '1p' "$ROLLBACK_FILE")
    [[ "$r" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
    printf '%s\n' "$r"
  fi
  docker ps -a --format '{{.Image}}' | sed -n 's/^rekoda-\(app\|web\):\(.*\)$/\2/p'
}

# The image IDs every container (running or stopped) was created from. Several
# tags can name one image, so a tag that shares an ID with a kept one is kept.
container_image_ids() {
  local ids
  ids=$(docker ps -aq) || return 1
  [ -z "$ids" ] && return 0
  # shellcheck disable=SC2086
  docker inspect --format '{{.Image}}' $ids
}

# Whether line $1 is in the newline-separated list $2, in pure bash: a full disk
# is when cleanup runs, and a here-string or pipe buffer may need a temp file.
in_list() {
  local needle=$'\n'"$1"$'\n'
  [[ $'\n'"$2"$'\n' == *"$needle"* ]]
}

# Frees image and build-cache space without touching a volume, a container, a
# production tag or a third-party image. Never fails the deploy.
#   $1  routine  (after a deploy) keeps recent build cache
#       urgent   (disk below the floor) drops all build cache
prune_releases() {
  local keep images keep_ids line image id tag
  keep=$(keep_releases) || {
    printf 'image cleanup skipped: the releases to keep could not be established\n' >&2
    return 0
  }
  keep_ids=$(container_image_ids) || {
    printf 'image cleanup skipped: the images the containers use could not be established\n' >&2
    return 0
  }
  images=$(docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}') || {
    printf 'image cleanup skipped: the image list could not be read\n' >&2
    return 0
  }
  # An image any kept tag names is kept under all its tags.
  while read -r image id; do
    [[ "$image" =~ ^rekoda-(app|web):(staging-[0-9a-f]{7})$ ]] || continue
    if in_list "${BASH_REMATCH[2]}" "$keep"; then keep_ids+=$'\n'"$id"; fi
  done < <(printf '%s\n' "$images")
  while read -r image id; do
    [[ "$image" =~ ^rekoda-(app|web):(staging-[0-9a-f]{7})$ ]] || continue
    tag=${BASH_REMATCH[2]}
    if in_list "$tag" "$keep"; then continue; fi
    if [ -n "$id" ] && in_list "$id" "$keep_ids"; then continue; fi
    printf 'removing the old image %s\n' "$image"
    docker image rm "$image" >/dev/null 2>&1 || true
  done < <(printf '%s\n' "$images")
  if [ "$1" = urgent ]; then
    docker builder prune -f >/dev/null 2>&1 || true
  else
    docker builder prune -f --filter until=48h >/dev/null 2>&1 || true
  fi
  return 0
}

# A full disk can leave a checkout that git believes it wrote: files cut short
# or empty. Succeeds only when every tracked file is byte-for-byte the commit's.
verify_checkout() {
  [ "$(git rev-parse HEAD)" = "$1" ] && git diff --quiet "$1" -- && [ -z "$(git ls-files --deleted)" ]
}

# Keep what a half-finished checkout left, for whoever reconciles it by hand.
save_evidence() {
  local file=".git/rekoda-deploy-evidence-$(date -u +%Y%m%dT%H%M%SZ).txt"
  {
    printf 'HEAD %s\n' "$(git rev-parse HEAD 2>&1)"
    git status --short --untracked-files=no 2>&1
    git diff --stat 2>&1
    df -Pk . 2>&1
  } >"$file" 2>/dev/null || true
  printf 'evidence kept in %s/%s\n' "$REKODA_DIR" "$file" >&2
}

restore_prepared() {
  # Nothing live changed, so put the checkout and REKODA_RELEASE back to what
  # the running containers are, leaving the host exactly as it was. The marker
  # goes only once both are back; a failed restore keeps it.
  #
  # Automatic only when it is provably safe: the checkout is exactly the commit
  # this run prepared (or already the baseline) with no tracked file changed, so
  # the only thing to undo is this run's own checkout. Anything else, a file cut
  # short by a full disk or edited by hand, is evidence of damage or of someone's
  # work: it is kept, nothing is forced or discarded, and the run refuses.
  local head
  head=$(git rev-parse HEAD 2>/dev/null || true)
  # PREPARED_SHA is the commit an interrupted run prepared (set by recovery); a
  # run restoring its own checkout prepared SHA.
  if [ "$head" != "$PREV_SHA" ] && [ "$head" != "${PREPARED_SHA:-$SHA}" ]; then
    printf 'the checkout is at %s, neither the baseline nor the prepared commit; not restoring\n' "$head" >&2
    save_evidence
    return 0
  fi
  if ! git diff --quiet "$head" -- || [ -n "$(git ls-files --deleted)" ]; then
    printf 'tracked files differ from commit %s (empty, cut short or edited); not restoring\n' "$head" >&2
    save_evidence
    return 0
  fi
  printf 'restoring the checkout to %s and REKODA_RELEASE to %s\n' "$PREV_SHA" "$PREV_RELEASE" >&2
  if git -c advice.detachedHead=false checkout -q "$PREV_SHA" &&
    verify_checkout "$PREV_SHA" &&
    sed -i "s/^REKODA_RELEASE=.*/REKODA_RELEASE=${PREV_RELEASE}/" .env &&
    [ "$(git rev-parse HEAD)" = "$PREV_SHA" ] &&
    [ "$(sed -n 's/^REKODA_RELEASE=//p' .env)" = "$PREV_RELEASE" ]; then
    if [ "$LIVE_MARKER" != true ]; then rm -f "$STATE"; fi
  else
    save_evidence
    printf 'the restore did not complete; recover by hand as the runbook'"'"'s "An interrupted staging deploy" says\n' >&2
  fi
}

on_exit() {
  local status=$?
  [ "$status" -eq 0 ] && return
  [ "$PHASE" = skipped ] && return
  case "$PHASE" in
    checks) ;;
    prepared)
      printf '\nSTAGING DEPLOY FAILED before anything live changed.\n' >&2
      restore_prepared
      ;;
    live)
      if [ -n "$BREAKING" ] && [ "$MIGRATE_ENTERED" != true ]; then
        printf '\nSTAGING DEPLOY FAILED BEFORE migrate: nothing was migrated, but the api and worker were being stopped for %s and their stopped state is UNVERIFIED.\n' "$BREAKING" >&2
      elif [ "$BREAKING_APPLIED" = true ] && [ "$UP_ENTERED" != true ]; then
        printf '\nSTAGING DEPLOY FAILED after migrate, before the new release was started: the api and worker are still stopped.\n' >&2
      else
        printf '\nSTAGING DEPLOY FAILED after migrate/up started: the stack may be part-way to %s.\n' "$RELEASE" >&2
      fi
      if [ "$BREAKING_APPLIED" = true ]; then
        printf 'Migration(s) %s are APPLIED, so the previous release (%s) is NOT safe to restart against this database.\n' "$BREAKING" "$PREV_RELEASE" >&2
        printf 'Fix forward, by hand from %s (the checkout is already at the new release): correct the cause first (a repeat of the same failure will repeat); `dc run --rm -T migrate`; then run the pre-start database smoke below as the owner and do NOT run `dc up` unless it prints t; then `dc up -d --wait --wait-timeout 300`; reload Caddy; check /health; remove .git/rekoda-deploy-staging.state.\n' "$REKODA_DIR" >&2
        print_smoke_0196
        printf 'The Deploy staging workflow refuses to run while /health is down, so do not wait for it, and do not start the previous containers (`dc start api worker` would). Escalate if the new release cannot start.\n' >&2
      elif [ "$MIGRATE_ENTERED" = true ]; then
        printf 'The api and worker were stopped for %s and migrate did not finish. Migrations commit one file at a time, so %s MAY already be applied: no rollback commands are printed.\n' "$BREAKING" "$BREAKING" >&2
        printf 'Check the DATABASE, not only the ledger (rekoda_migrations): the guard exists if `SELECT 1 FROM pg_trigger WHERE tgname = '"'"'businesses_plan_fields_guard'"'"'` returns a row (a kill between the migration and its ledger row leaves it applied, unrecorded). Treat a present guard as applied.\n' >&2
        printf 'Fix forward, by hand from %s (the checkout is already at the new release): correct the cause first (a repeat of the same failure, such as the plan-writer membership refusal, will repeat), then `dc run --rm -T migrate` (0196 is safe to re-run), then run the pre-start database smoke below as the owner and do NOT run `dc up` unless it prints t, then `dc up -d --wait --wait-timeout 300`, reload Caddy, check /health, remove .git/rekoda-deploy-staging.state. The previous release (%s) must never be restarted against a database holding 0196; the workflow refuses to run while /health is down. Escalate if unsure.\n' "$REKODA_DIR" "$PREV_RELEASE" >&2
        print_smoke_0196
      else
        if [ -n "$BREAKING" ]; then
          printf 'Migrate was never entered, so %s is not applied by this run. Check with `dc ps` whether the api and worker are running before anything else: the previous release is still compatible with this database, so `dc start api worker` is safe if they are down. Confirm the guard trigger `businesses_plan_fields_guard` is absent in the database itself before restarting it.\n' "$BREAKING" >&2
        fi
        printf 'Inspect with `dc ps -a` and `dc logs <service>` on the host. To roll back, from %s:\n' "$REKODA_DIR" >&2
        printf '  git checkout %s\n' "$PREV_SHA" >&2
        printf "  sed -i 's/^REKODA_RELEASE=.*/REKODA_RELEASE=%s/' .env\n" "$PREV_RELEASE" >&2
        printf '  dc up -d --wait --wait-timeout 300\n' >&2
        printf '  dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile\n' >&2
      fi
      dc ps -a >&2 || true
      ;;
  esac
  # The workflow reads $SKIPPED as "nothing changed"; a failure never may.
  [ "$status" -ne "$SKIPPED" ] || exit 1
}
trap on_exit EXIT
# A hang-up, interrupt or terminate (a cancelled run closes the SSH session)
# exits, so on_exit runs and restores a prepared checkout. bash runs the trap
# when the foreground command (a build) returns. SIGKILL cannot be trapped:
# the state marker and recover_interrupted cover that.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'printf "failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

NEWER_ONLY=false
if [ "${1:-}" = --newer-only ]; then
  NEWER_ONLY=true
  shift
fi
SHA=${1:-}
[ "$#" -eq 1 ] || fail 'usage: deploy-staging.sh [--newer-only] <40-character commit SHA>'
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'the commit must be a full 40-character lowercase SHA'

step 'preflight'
for tool in git docker curl jq flock timeout sed awk; do
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


if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  empty=$(git diff --name-only | while IFS= read -r f; do
    if [ -f "$f" ] && [ ! -s "$f" ] && [ "$(git cat-file -s "HEAD:$f" 2>/dev/null || echo 0)" -gt 0 ]; then printf '%s ' "$f"; fi
  done | head -c 400) || true
  [ -z "$empty" ] ||
    printf 'tracked files are empty here but not in the commit (what a full disk leaves): %s\n' "$empty" >&2
  fail 'the checkout has tracked local modifications; resolve them by hand first'
fi
# The build context is the checkout (`COPY . .`), so a file the commit does not
# hold, ignored by git or not, would be built into staging without CI having
# seen it. Only the host-local paths .dockerignore keeps out of every image may
# sit in the checkout; scripts/check-staging-deploy.mjs holds the two in step.
HOST_LOCAL='^((.+/)?\.env(\.[^/]+)?|(secrets|data|uploads|storage|logs|backups)/.*|[^/]+\.log)$'
stray=$(git -c core.quotePath=false ls-files --others --directory --no-empty-directory | grep -Ev "$HOST_LOCAL" || true)
[ -z "$stray" ] ||
  fail "the checkout holds paths no commit has, which the image build would include; move them out of $REKODA_DIR first: $(head -n 20 <<<"$stray" | tr '\n' ' ')"
PREV_SHA=$(git rev-parse HEAD)

# A run killed where no trap could run leaves a marker. Before the baseline is
# judged, tell the three cases apart; the baseline check below still decides
# whether this run may go on.
#   no marker                nothing to do
#   prepared, host unchanged since: nothing live had changed, so put back the
#       checkout and .env of the run's baseline, but only if /health still
#       proves that baseline is what runs
#   prepared, already back at the baseline (restored by hand): drop the marker
#   live (migrate or `up` had begun): restore nothing; the baseline check
#       below refuses unless the checkout, .env and the running release all
#       agree, and the marker stays until a deploy runs to the end (a
#       --newer-only run may not skip past it)
recover_interrupted() {
  [ -f "$STATE" ] || return 0
  local phase s_prev_sha s_prev_rel s_sha s_rel health
  phase=$(state_value phase)
  s_prev_sha=$(state_value prev_sha)
  s_prev_rel=$(state_value prev_release)
  s_sha=$(state_value sha)
  s_rel=$(state_value release)
  [[ "$s_prev_sha" =~ ^[0-9a-f]{40}$ && "$s_sha" =~ ^[0-9a-f]{40}$ &&
    "$s_prev_rel" =~ ^[A-Za-z0-9._-]+$ && "$s_rel" =~ ^[A-Za-z0-9._-]+$ ]] ||
    fail "$REKODA_DIR/$STATE is unreadable; reconcile by hand as the runbook's \"An interrupted staging deploy\" says"
  if [ "$phase" = live ]; then
    LIVE_MARKER=true
    MARKER_PREV_RELEASE=$s_prev_rel
    return 0
  fi
  [ "$phase" = prepared ] || fail "$REKODA_DIR/$STATE names an unknown phase; reconcile by hand"
  if [ "$PREV_SHA" = "$s_prev_sha" ] && [ "$PREV_RELEASE" = "$s_prev_rel" ]; then
    rm -f "$STATE"
    return 0
  fi
  # A kill between the checkout and the .env edit (or between the two inside a
  # restore) leaves one at the baseline and the other at the target. Either
  # value of each is this run's own work; anything else is not, and is refused.
  if { [ "$PREV_SHA" != "$s_prev_sha" ] && [ "$PREV_SHA" != "$s_sha" ]; } ||
    { [ "$PREV_RELEASE" != "$s_prev_rel" ] && [ "$PREV_RELEASE" != "$s_rel" ]; }; then
    fail "an interrupted deploy of $s_sha left $STATE, but the checkout ($PREV_SHA) and REKODA_RELEASE ($PREV_RELEASE) are neither its baseline nor what it prepared; reconcile by hand"
  fi
  health=$(curl -fsS --max-time 10 --retry 2 --retry-delay 5 "$API_URL/health") ||
    fail "$API_URL/health did not answer, so the interrupted deploy's baseline cannot be confirmed"
  jq -e --arg pr "$s_prev_rel" --arg ps "$s_prev_sha" \
    '.commit as $c | .status == "ok" and .database == "up" and .release == $pr
     and ($c | type) == "string" and ($c | length) >= 7 and ($ps | startswith($c))' \
    <<<"$health" >/dev/null ||
    fail "an interrupted deploy of $s_sha left the checkout prepared, but $API_URL/health does not report a healthy $s_prev_rel at $s_prev_sha; not restoring, reconcile by hand"
  printf 'a deploy of %s was interrupted before anything live changed; restoring its baseline %s at %s\n' "$s_sha" "$s_prev_rel" "$s_prev_sha"
  PREV_SHA=$s_prev_sha
  PREV_RELEASE=$s_prev_rel
  PREPARED_SHA=$s_sha
  restore_prepared
  # The interrupted commit is dealt with; a later restore in this run is of the
  # checkout this run prepares.
  PREPARED_SHA=
  [ ! -f "$STATE" ] || fail 'the interrupted deploy could not be restored; reconcile by hand'
}
recover_interrupted

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

# Free space is judged once the running release is proven healthy (cleanup
# keeps that release and its rollback only on that proof) and before anything
# in the checkout changes: the build, the checkout and the images all need it.
step 'disk space'
if disk_low; then
  printf 'only %s KiB free on %s (floor %s KiB); removing superseded staging images\n' "$LOW_KB" "$LOW_PATH" "$MIN_FREE_KB"
  prune_releases urgent
  if disk_low; then
    {
      printf 'free space now:\n'
      df -Pk "$REKODA_DIR" "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)" 2>&1 || true
      docker system df 2>&1 || true
    } >&2
    fail "only $LOW_KB KiB free on $LOW_PATH after removing superseded staging images (a deploy needs at least $MIN_FREE_KB; the floor is a minimum, not a promise a build fits). Free space by hand first. No volume, database file or backup is ever removed by this script"
  fi
fi

step 'memory'
require_memory 'before any build'

step 'fetch and verify the commit'
git fetch --prune origin
git cat-file -e "${SHA}^{commit}" 2>/dev/null || fail "commit $SHA is not in origin"
git merge-base --is-ancestor "$SHA" origin/main || fail "commit $SHA is not on origin/main"

# An interrupted live phase is finished by a deploy, never skipped: /health may
# already name the target while worker, web or Caddy are still on the old one.
if [ "$LIVE_MARKER" = true ] && [ "$NEWER_ONLY" = true ] && [ "$SHA" != "$PREV_SHA" ] && git merge-base --is-ancestor "$SHA" "$PREV_SHA"; then
  fail "an earlier deploy was killed after migrate or up began, so the stack may be part-way to its release; start the manual Deploy staging workflow (without --newer-only) to finish it"
fi

# After CI, only forward. The running commit is proved above, and the lock
# holds it there until this run ends.
if [ "$NEWER_ONLY" = true ] && [ "$SHA" != "$PREV_SHA" ] &&
  git merge-base --is-ancestor "$SHA" "$PREV_SHA"; then
  PHASE=skipped
  printf '\nstaging already runs %s, which is newer than %s; nothing changed\n' "$PREV_SHA" "$SHA"
  exit "$SKIPPED"
fi

# The database keeps every migration ever applied, and a migration may contract
# what older code still uses (expand, deploy, contract: the contraction ships a
# release later). /health cannot see that, since it asks only for the build's
# own migrations. So deploy only a commit whose code knows the schema staging
# has: every migration tag the running commit carries, and at least as many
# migrations as the database has applied. A rollback across a migration is a
# deliberate act, done by hand as the runbook's "Roll back" says.
step "the commit knows staging's schema"
JOURNAL=packages/db/migrations/meta/_journal.json
running_journal=$(git show "$PREV_SHA:$JOURNAL") || fail "the running commit has no $JOURNAL"
target_journal=$(git show "$SHA:$JOURNAL") || fail "commit $SHA has no $JOURNAL"
unknown=$(jq -rn --argjson run "$running_journal" --argjson new "$target_journal" \
  '[$run.entries[].tag] - [$new.entries[].tag] | join(" ")') ||
  fail "the migration journals could not be compared"
[ -z "$unknown" ] ||
  fail "commit $SHA does not carry migrations staging already runs ($unknown); roll back across a migration by hand, as the runbook's \"Roll back\" says"
BREAKING=$(jq -rn --argjson run "$running_journal" --argjson new "$target_journal" \
  --arg breaking "$COMPAT_BREAKING_MIGRATIONS" \
  '($breaking | split(" ")) as $b
   | [$new.entries[].tag] - [$run.entries[].tag] | map(select(. as $t | $b | index($t))) | join(" ")') ||
  fail "the migration journals could not be compared for compatibility-breaking migrations"
MIGRATIONS=$(jq '.entries | length' <<<"$target_journal")
APPLIED=$(jq '.migrations' <<<"$running")
[[ "$MIGRATIONS" =~ ^[0-9]+$ && "$APPLIED" =~ ^[0-9]+$ ]] ||
  fail "could not count migrations (commit carries '$MIGRATIONS', /health reports '$APPLIED')"
[ "$MIGRATIONS" -ge "$APPLIED" ] ||
  fail "commit $SHA carries $MIGRATIONS migrations and staging's database has applied $APPLIED; roll back across a migration by hand, as the runbook's \"Roll back\" says"

SHORT=$(git rev-parse --short=7 "$SHA")
RELEASE="staging-${SHORT}"
# Compose interpolates the image tags from the shell before .env, so pin the
# shell to the same value the file is about to hold.
export REKODA_RELEASE="$RELEASE"
printf 'deploying %s as %s (previously %s at %s)\n' "$SHA" "$RELEASE" "$PREV_RELEASE" "$PREV_SHA"

step 'check out the commit and name the release'
PHASE=prepared
write_state prepared
git -c advice.detachedHead=false checkout -q --detach "$SHA"
[ "$(git rev-parse HEAD)" = "$SHA" ] || fail 'the checkout is not at the requested commit'
verify_checkout "$SHA" || fail 'the checkout holds tracked files that differ from the commit (empty or cut short: a full disk?)'
sed -i "s/^REKODA_RELEASE=.*/REKODA_RELEASE=${RELEASE}/" .env
[ "$(sed -n 's/^REKODA_RELEASE=//p' .env)" = "$RELEASE" ] || fail 'REKODA_RELEASE was not updated in .env'

# One image at a time, never both at once: concurrent builds are what overloaded
# the host. The api image is the one api, worker, migrate and edge-check run.
step "build the api image, tagged $RELEASE (nothing live changes)"
dc config -q
log_memory 'before the api build'
dc build --build-arg REKODA_COMMIT="$SHORT" api
log_memory 'after the api build'

step "build the web image, tagged $RELEASE (nothing live changes)"
require_memory 'before the web build'
dc build --build-arg REKODA_COMMIT="$SHORT" web
log_memory 'after the web build'

PHASE=live
write_state live
if [ -n "$BREAKING" ]; then
  # The previous release's api and worker write columns these migrations guard; left running they
  # would be refused mid-migration, or run against a schema they do not know. Stop them first and
  # prove it, so the old release cannot keep writing while the new schema goes in.
  step "stop the api and worker: this release carries a migration the running release cannot work against ($BREAKING)"
  dc stop api worker
  # A failing `ps` is not "nothing running": it is "could not tell", and migrate must not go ahead.
  running_services=$(dc ps --status running --services) ||
    fail "could not list the running services, so it cannot be proved that the api and worker stopped; not migrating $BREAKING"
  still_up=$(grep -Ex 'api|worker' <<<"$running_services" || true)
  [ -z "$still_up" ] || fail "the api and worker must be stopped before migrating $BREAKING, but still running: $still_up"
fi
step 'migrate (expand-only, as the owner)'
[ -z "$BREAKING" ] || MIGRATE_ENTERED=true
dc run --rm -T migrate
[ -z "$BREAKING" ] || BREAKING_APPLIED=true

# OWN-86: "applies the migrations, verifies, deploys the new release, smokes, then starts them". The
# database half of that is checked here, between migrate and `up`, so it cannot be skipped: the
# ledger row, the guard trigger itself (a ledger row alone can disagree with the database), the
# sanctioned plan functions owned by rekoda_plan_writer, and neither runtime role able to become it.
# Any miss stops the deploy with the api and worker still stopped; the exit handler then prints the
# fix-forward steps (0196 is applied, so the previous release must not be restarted).
if [[ " $BREAKING " == *' 0196_plan_fields_guard '* ]]; then
  step 'pre-start database smoke for 0196 (OWN-86): ledger, guard trigger, plan functions, role boundary'
  smoke_0196=$(dc exec -T postgres psql -U rekoda_owner -d rekoda -v ON_ERROR_STOP=1 -tA -c "$SMOKE_0196_SQL") ||
    fail 'migrations are APPLIED, but the pre-start database smoke for 0196 could not run, so the new release is not started; the api and worker stay stopped'
  [ "$smoke_0196" = t ] ||
    fail "migrations are APPLIED, but the pre-start database smoke for 0196 failed (got '$smoke_0196'): the ledger row, the enabled businesses_plan_fields_guard trigger, both plan functions owned by rekoda_plan_writer, or the runtime roles' separation from it is missing; the new release is not started and the api and worker stay stopped"
fi

step 'start the new release'
UP_ENTERED=true
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
# At least, not exactly: the database may hold migrations applied before an
# earlier by-hand rollback, which this commit also carries under their tags.
jq -e --argjson m "$MIGRATIONS" '.migrations >= $m' <<<"$health" >/dev/null ||
  fail "/health reports fewer migrations than the $MIGRATIONS this commit carries"
[[ "$SHA" == "$(jq -r .commit <<<"$health")"* ]] || fail '/health names a commit that is not the deployed SHA'

step 'running containers'
dc ps
# The release this deploy replaced is the rollback. Record it durably before the
# marker (which may be the only other record of it) goes; if it cannot be written
# (a full disk), keep the marker and report, so nothing is cleaned up on a guess.
rollback=$PREV_RELEASE
[ "$rollback" != "$RELEASE" ] || rollback=$MARKER_PREV_RELEASE
if [ -n "$rollback" ] && [ "$rollback" != "$RELEASE" ]; then
  if ! { printf '%s\n' "$rollback" >"$ROLLBACK_FILE.tmp" && mv -f "$ROLLBACK_FILE.tmp" "$ROLLBACK_FILE"; }; then
    PHASE=done
    fail "staging runs $RELEASE and is healthy, but its rollback $rollback could not be recorded in $REKODA_DIR/$ROLLBACK_FILE (a full disk?); the marker stays and no image is removed. Free space, then run the manual Deploy staging workflow to finish"
  fi
fi
rm -f "$STATE"
PHASE=done
printf '\nstaging is %s (%s)\n' "$RELEASE" "$SHA"
# Only now, with the new release proven healthy and the marker gone: keep it and
# the release it replaced, drop older.
step 'remove superseded staging images (keeping the running release and its rollback)'
prune_releases routine
exit 0
}
