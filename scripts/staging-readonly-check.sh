#!/usr/bin/env bash
# Read-only staging check (billing directive, 26 Oct 2026). Changes nothing and prints no secret value:
# environment settings are reported as SET or UNSET only. Run it on the staging host from /opt/rekoda:
#   ssh <deploy-user>@<host> 'bash -s' < scripts/staging-readonly-check.sh
# Needed for RESULT: OK: EXPECT_SHA=<sha> (7 to 40 hex characters, for example the deploy run's
# commit) compares the checkout, the served commit and the images with that commit. Without it the
# script still runs as a diagnostic, but flags the missing value and ends in RESULT: ATTENTION:
#   ssh <deploy-user>@<host> 'EXPECT_SHA=b8baf24 bash -s' < scripts/staging-readonly-check.sh
# Every check that is not as expected is repeated under "== attention" at the end; a check that
# could not be made reads "unknown", never as a pass. The last line is RESULT: OK (exit 0) or
# RESULT: ATTENTION (exit 1). Migration lines read APPLIED, MISSING (not applied: neither objects
# nor ledger tag), INCOMPLETE (objects without the tag), INCONSISTENT (the tag without its
# objects) or unknown; only APPLIED is a pass. Nothing is written, restarted or sent.
set -u
# One collation for every sort and comm below, whatever the host's locale.
export LC_ALL=C
API_URL="${API_URL:-https://staging-api.myrekoda.com}"
cd /opt/rekoda 2>/dev/null || { echo "FAIL not in /opt/rekoda"; exit 1; }
# stdin is closed for every compose call: the script is usually piped in over ssh (`bash -s`), and
# a `compose exec` left on that stdin can swallow the unread rest of the script.
dc() { docker compose -f docker-compose.prod.yml "$@" </dev/null; }
say() { printf '%-34s %s\n' "$1" "$2"; }
ATTN=""
# say, and also list the line under "== attention" (anything not as expected, or not checkable).
flag() { say "$1" "$2"; ATTN="${ATTN}$(printf '%-34s %s' "$1" "$2")"$'\n'; }

echo "== release identity"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"
say "checkout HEAD" "${HEAD_SHA:-unknown}"
if st="$(git --no-optional-locks status --porcelain --untracked-files=no 2>/dev/null)"; then
  mods="$(printf '%s' "$st" | grep -c .)"
  if [ "$mods" -eq 0 ]; then say "tracked modifications" "0"; else flag "tracked modifications" "$mods"; fi
else flag "tracked modifications" "unknown (git status failed)"; fi
RELEASE="$(sed -n 's/^REKODA_RELEASE=//p' .env 2>/dev/null | head -1)"
if [ -n "$RELEASE" ]; then say ".env REKODA_RELEASE" "$RELEASE"; else flag ".env REKODA_RELEASE" "UNSET"; fi
EXPECT="${EXPECT_SHA:-}"
case "$EXPECT" in
  "") flag "EXPECT_SHA" "not given (pass EXPECT_SHA=<sha> to compare with a commit)" ;;
  *[!0-9a-f]*) flag "EXPECT_SHA" "not a lowercase hex commit; comparisons skipped"; EXPECT="" ;;
  *) if [ "${#EXPECT}" -lt 7 ] || [ "${#EXPECT}" -gt 40 ]; then
       flag "EXPECT_SHA" "must be 7 to 40 characters; comparisons skipped"; EXPECT=""
     else say "EXPECT_SHA" "$EXPECT"; fi ;;
esac
# A short EXPECT_SHA matches the full commit it abbreviates.
if [ -n "$EXPECT" ]; then
  case "$HEAD_SHA" in
    "$EXPECT"*) say "checkout matches EXPECT_SHA" "yes" ;;
    *) flag "checkout matches EXPECT_SHA" "NO" ;;
  esac
fi
declare -A IMG
for c in api worker web; do
  id="$(dc ps -q "$c" 2>/dev/null)"
  IMG[$c]="$([ -n "$id" ] && docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null)"
  if [ -n "${IMG[$c]}" ]; then say "image of $c" "${IMG[$c]}"; else flag "image of $c" "MISSING"; fi
done
# The api and the worker run one image (docker-compose.prod.yml); the deploy tags it with the
# release, so both should be rekoda-app:<REKODA_RELEASE>.
if [ -n "${IMG[api]}" ] && [ -n "${IMG[worker]}" ]; then
  if [ "${IMG[api]}" = "${IMG[worker]}" ]; then say "api and worker image" "SAME"
  else flag "api and worker image" "DIFFERENT"; fi
else flag "api and worker image" "unknown (a container is missing)"; fi
if [ -n "$RELEASE" ] && [ -n "${IMG[api]}" ]; then
  if [ "${IMG[api]}" = "rekoda-app:$RELEASE" ]; then say "api image is the .env release" "yes"
  else flag "api image is the .env release" "NO (expected rekoda-app:$RELEASE)"; fi
fi
if [ -n "$RELEASE" ] && [ -n "${IMG[web]}" ]; then
  if [ "${IMG[web]}" = "rekoda-web:$RELEASE" ]; then say "web image is the .env release" "yes"
  else flag "web image is the .env release" "NO (expected rekoda-web:$RELEASE)"; fi
fi
# A container reads .env when it is created (env_file is resolved then), and a restart,
# a crash restart or a reboot does not re-read it. So an .env written after the container's
# creation (a rotated key, a new provider) is not what it runs until it is recreated. Compared by
# time, so no value is read. A deploy rewrites the REKODA_RELEASE line even when it is unchanged,
# so a same-commit redeploy or an aborted deploy also reads NO here (see the handoff runbook).
ENV_MTIME="$(stat -c %Y .env 2>/dev/null)"
for c in api worker; do
  id="$(dc ps -q "$c" 2>/dev/null)"
  created="$([ -n "$id" ] && docker inspect -f '{{.Created}}' "$id" 2>/dev/null)"
  c_epoch="$([ -n "$created" ] && date -d "$created" +%s 2>/dev/null)"
  if [ -z "$ENV_MTIME" ] || [ -z "$c_epoch" ]; then
    flag ".env older than the $c container" "unknown (cannot read .env or the container creation time)"
  elif [ "$ENV_MTIME" -gt "$c_epoch" ]; then
    flag ".env older than the $c container" "NO (.env written after $c was created; it runs the settings of its creation until recreated)"
  elif [ "$ENV_MTIME" -eq "$c_epoch" ]; then
    # Whole seconds only: an edit in the same second as the creation cannot be ordered.
    flag ".env older than the $c container" "unknown (.env written in the same second $c was created)"
  else say ".env older than the $c container" "yes"; fi
done

echo "== health (API)"
HEALTH="$(curl -fsS --max-time 15 "$API_URL/health" 2>/dev/null)"
rc=$?
# A transfer that failed after part of a body arrived (a timeout mid-answer) is not an answer:
# what was captured is discarded, so no field below can pass on it.
if [ "$rc" -ne 0 ] && [ -n "$HEALTH" ]; then
  HEALTH=""
  flag "/health" "unknown (transfer failed after a partial answer, curl exit $rc)"
elif [ -n "$HEALTH" ]; then echo "$HEALTH"; else flag "/health" "FAIL (no answer)"; fi
echo
# One field of the /health JSON (a string or a number); empty when absent. /health serves only
# status, database, migrations, release and commit, none of them secret.
hfield() { printf '%s' "$HEALTH" | sed -n 's/.*"'"$1"'":"\{0,1\}\([^",}]*\).*/\1/p' | head -1; }
H_STATUS="$(hfield status)"; H_DB="$(hfield database)"; H_MIG="$(hfield migrations)"
H_COMMIT="$(hfield commit)"; H_RELEASE="$(hfield release)"
if [ -n "$HEALTH" ]; then
  if [ "$H_STATUS" = ok ]; then say "served status" "ok"; else flag "served status" "${H_STATUS:-unknown}"; fi
  if [ "$H_DB" = up ]; then say "served database" "up"; else flag "served database" "${H_DB:-unknown}"; fi
  say "served commit" "${H_COMMIT:-unknown}"
  say "served release" "${H_RELEASE:-unknown}"
  # The deploy workflow's own rule: the served commit is an abbreviation (7+ characters) of the
  # deployed commit, and the release is staging-<that abbreviation>.
  if [ -n "$EXPECT" ]; then
    if [ "${#H_COMMIT}" -ge 7 ] && { case "$EXPECT" in "$H_COMMIT"*) true ;; *) case "$H_COMMIT" in "$EXPECT"*) true ;; *) false ;; esac ;; esac; }; then
      say "served commit matches EXPECT_SHA" "yes"
    else flag "served commit matches EXPECT_SHA" "NO"; fi
  fi
  if [ -n "$H_COMMIT" ] && [ "$H_RELEASE" = "staging-$H_COMMIT" ]; then say "served release is staging-<commit>" "yes"
  else flag "served release is staging-<commit>" "NO"; fi
fi
echo "== web"
# curl prints the status code even when the transfer then fails (a timeout after the headers), so a
# failed transfer is unknown whatever code it printed.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://staging.myrekoda.com/ 2>/dev/null)"
rc=$?
case "$code" in
  2??|3??) if [ "$rc" -eq 0 ]; then say "web status" "$code"
           else flag "web status" "unknown (transfer failed, curl exit $rc, after code $code)"; fi ;;
  ""|000) flag "web status" "unknown (no answer)" ;;
  *) flag "web status" "$code" ;;
esac

# Every long-running service must be running. postgres, api, worker and web have a healthcheck in
# docker-compose.prod.yml, so they must read healthy (an empty health result is not a pass); caddy
# has none. The one-off jobs (migrate, edge-check) must have exited 0 or be absent; any other state
# needs attention.
echo "== services"
SERVICES="$(dc ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' 2>/dev/null)"
if [ -z "$SERVICES" ]; then
  flag "services" "unknown (compose ps failed)"
else
  for svc in postgres api worker web caddy; do
    line="$(printf '%s\n' "$SERVICES" | grep "^$svc|" | head -1)"
    IFS='|' read -r _ state health _ <<<"$line"
    if [ -z "$line" ]; then flag "service $svc" "MISSING"
    elif [ "$state" != running ]; then flag "service $svc" "${state:-unknown}"
    elif [ "$svc" != caddy ] && [ "$health" != healthy ]; then flag "service $svc" "running, ${health:-no health result}"
    elif [ -n "$health" ] && [ "$health" != healthy ]; then flag "service $svc" "running, $health"
    else say "service $svc" "running${health:+, $health}"; fi
  done
  for svc in migrate edge-check; do
    line="$(printf '%s\n' "$SERVICES" | grep "^$svc|" | head -1)"
    IFS='|' read -r _ state _ code <<<"$line"
    if [ -z "$line" ]; then say "job $svc" "not present"
    elif [ "$state" = exited ] && [ "$code" = 0 ]; then say "job $svc" "exited (0)"
    elif [ "$state" = exited ]; then flag "job $svc" "exited ${code:-unknown}"
    else flag "job $svc" "${state:-unknown} (not exited 0)"; fi
  done
fi

# Annual-billing migrations (SUB-02/SUB-02a certification needs all of them). One read-only
# query per status line (0174 has two lines, columns and table, so a partial 0174 shows), asked of the postgres container in a read-only session
# (default_transaction_read_only=on, so even a mistaken statement could not write). The query
# answers t or f; anything else (a failed exec, a refused connection, a wrong user or database
# name) is reported as "unknown", never as MISSING and never with the client's error text, which
# can name the database user: psql's stderr is discarded.
mig_q() { # boolean SQL: prints t, f or nothing (query failed)
  dc exec -T -e PGOPTIONS='-c default_transaction_read_only=on' -e "Q=$1" postgres sh -c \
    'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-rekoda}" -v ON_ERROR_STOP=1 -Atc "$Q"' 2>/dev/null
}
# The runner (packages/db/src/migrate.ts) runs a migration's SQL and then records its tag in
# rekoda_migrations as a separate statement, so a stop between the two leaves the objects without
# the tag and the next run would fail on them. Both are read: objects and tag agree = APPLIED or
# MISSING; objects without the tag = INCOMPLETE; the tag without objects = INCONSISTENT.
mig_sql() { # label, ledger tag, boolean SQL
  o="$(mig_q "$3")"
  l="$(mig_q "select exists (select 1 from rekoda_migrations where tag = '$2')")"
  case "$o:$l" in
    t:t) say "$1" "APPLIED" ;;
    f:f) flag "$1" "MISSING" ;;
    t:f) flag "$1" "INCOMPLETE (objects exist, migration not recorded)" ;;
    f:t) flag "$1" "INCONSISTENT (recorded, objects missing)" ;;
    *) flag "$1" "unknown (query failed; check the postgres user/db names)" ;;
  esac
}
mig_cols() { # label, ledger tag, table.column ... (objects present only when every column exists)
  label="$1"; tag="$2"; shift 2
  list=""; n=0
  for tc in "$@"; do
    list="${list:+$list, }('${tc%%.*}', '${tc#*.}')"; n=$((n + 1))
  done
  mig_sql "$label" "$tag" "select count(*) = $n from information_schema.columns where table_schema = 'public' and (table_name, column_name) in ($list)"
}

echo "== annual-billing migrations (APPLIED / MISSING / INCOMPLETE / INCONSISTENT / unknown; read-only)"
mig_cols "0171 billing_interval" 0171_billing_interval businesses.billing_interval \
  businesses.pending_billing_interval subscription_charges.billing_interval
mig_cols "0172 billing checkout columns" 0172_billing_checkout businesses.billing_email_sealed \
  businesses.billing_email_set_at subscription_charges.checkout_url subscription_charges.checkout_started_at
mig_sql  "0173 checkout attempts table" 0173_checkout_attempts "select to_regclass('public.subscription_charge_attempts') is not null"
mig_cols "0174 billing email verification" 0174_billing_email_verification \
  businesses.billing_email_verified_at businesses.billing_email_revision \
  subscription_charge_attempts.email_revision subscription_charge_attempts.provider_live
mig_sql  "0174 verification table" 0174_billing_email_verification "select to_regclass('public.billing_email_verifications') is not null"
mig_cols "0175 reserved meters" 0175_reserved_meters external_events.reserved_meters
mig_cols "0182 charge applied period" 0182_charge_applied_period subscription_charges.applied_period_start \
  subscription_charges.applied_period_end
mig_sql  "0185 address limit objects" 0185_billing_email_address_limit "select to_regclass('public.billing_email_address_requests') is not null and (select count(*) = 3 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and ((p.proname = 'billing_email_address_claim' and oidvectortypes(p.proargtypes) = 'text, integer, integer') or (p.proname = 'billing_email_address_wait' and oidvectortypes(p.proargtypes) = 'text, integer, integer') or (p.proname = 'billing_email_address_release' and oidvectortypes(p.proargtypes) = 'uuid, text')))"

echo "== trial-reminder migrations 0181, 0183, 0186 (APPLIED / MISSING / INCOMPLETE / INCONSISTENT / unknown; read-only)"
mig_sql  "0181 trial sweep function" 0181_sweep_trial_candidates "select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'sweep_trial_candidates' and p.prosecdef)"
mig_cols "0183 email send outcome column" 0183_email_verification_send_outcome billing_email_verifications.send_outcome
mig_cols "0186 trial notice failure column" 0186_trial_notice_undelivered businesses.trial_notice_failed_at

echo "== reminder migrations 0187-0189 (APPLIED / MISSING / INCOMPLETE / INCONSISTENT / unknown; read-only)"
mig_sql  "0187 payment instruction columns" 0187_payment_instructions "select (select count(*) = 5 from information_schema.columns where table_schema = 'public' and table_name = 'businesses' and column_name in ('payment_bank_name', 'payment_account_name', 'payment_account_number', 'payment_instruction_approved_at', 'payment_instruction_approved_by')) and exists (select 1 from pg_constraint where conname = 'businesses_payment_instruction_all_or_nothing' and conrelid = 'public.businesses'::regclass)"
mig_sql  "0188 payment check validated" 0188_validate_payment_instruction_check "select coalesce((select convalidated from pg_constraint where conname = 'businesses_payment_instruction_all_or_nothing' and conrelid = 'public.businesses'::regclass), false)"
mig_sql  "0189 reminder batch tables" 0189_reminder_batches "select to_regclass('public.reminder_batches') is not null and to_regclass('public.reminder_batch_items') is not null"

# Every migration this checkout carries (its journal) against every tag the database has
# recorded. Tags are file names, not data, so the missing and unexpected ones are listed by name.
echo "== migration ledger (expected by this checkout vs applied; read-only)"
JOURNAL=packages/db/migrations/meta/_journal.json
EXPECTED_TAGS="$(grep -o '"tag": *"[^"]*"' "$JOURNAL" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | sort)"
APPLIED_TAGS="$(dc exec -T -e PGOPTIONS='-c default_transaction_read_only=on' -e "Q=select tag from rekoda_migrations order by tag" postgres sh -c \
  'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-rekoda}" -v ON_ERROR_STOP=1 -Atc "$Q"' 2>/dev/null)"
APPLIED_OK=$?
n_expected="$(printf '%s' "$EXPECTED_TAGS" | grep -c .)"
if [ "$n_expected" -gt 0 ]; then say "expected migrations" "$n_expected (last $(printf '%s\n' "$EXPECTED_TAGS" | tail -1))"
else flag "expected migrations" "unknown (cannot read $JOURNAL)"; fi
if [ "$APPLIED_OK" -ne 0 ] || [ -z "$APPLIED_TAGS" ]; then
  flag "applied migrations" "unknown (query failed; check the postgres user/db names)"
else
  n_applied="$(printf '%s\n' "$APPLIED_TAGS" | grep -c .)"
  say "applied migrations" "$n_applied (last $(printf '%s\n' "$APPLIED_TAGS" | sort | tail -1))"
  if [ "$n_expected" -gt 0 ]; then
    missing="$(comm -23 <(printf '%s\n' "$EXPECTED_TAGS") <(printf '%s\n' "$APPLIED_TAGS" | sort) | paste -sd' ' -)"
    extra="$(comm -13 <(printf '%s\n' "$EXPECTED_TAGS") <(printf '%s\n' "$APPLIED_TAGS" | sort) | paste -sd' ' -)"
    if [ -z "$missing" ]; then say "not applied" "none"; else flag "not applied" "$missing"; fi
    if [ -z "$extra" ]; then say "applied but not in this checkout" "none"; else flag "applied but not in this checkout" "$extra"; fi
  fi
fi
# /health serves a migrations count; a /health that answers without one is a check not made.
# (No answer at all is already flagged above; zero expected migrations is flagged with the journal.)
if [ -n "$HEALTH" ] && [ -z "$H_MIG" ]; then
  flag "/health migrations = expected" "unknown (/health served no migrations field)"
elif [ -n "$H_MIG" ] && [ "$n_expected" -gt 0 ]; then
  if [ "$H_MIG" = "$n_expected" ]; then say "/health migrations = expected" "yes ($H_MIG)"
  else flag "/health migrations = expected" "NO ($H_MIG served, $n_expected expected)"; fi
fi

# Counts only, never log text. The api and worker log through Nest's console logger
# (`[Nest] <pid>  - <time>   ERROR [Context] …`), which writes errors to stderr and may colour
# the level, so both streams are read and colour codes stripped. Lines at ERROR or FATAL level
# (or a JSON logger's error/fatal) are judged; the wider count (any line mentioning ERROR, FATAL
# or migration) is informational, read by hand.
echo "== recent errors (last 30 minutes; counts only, no log text is printed)"
for c in api worker; do
  if logs="$(dc logs --no-color --since 30m "$c" 2>&1)"; then
    logs="$(printf '%s\n' "$logs" | sed 's/\x1b\[[0-9;]*m//g')"
    n="$(printf '%s\n' "$logs" | grep -cE '\[Nest\].*[[:space:]](ERROR|FATAL)[[:space:]]|"level":("error"|"fatal"|50|60)')"
    if [ "$n" -eq 0 ]; then say "error-level lines in $c" "0"; else flag "error-level lines in $c" "$n"; fi
    say "error-like lines in $c (info)" "$(printf '%s\n' "$logs" | grep -ciE '"level":(50|60)|ERROR|FATAL|migration')"
  else flag "error-level lines in $c" "unknown (cannot read logs)"; fi
done

echo "== resources"
df -h /opt/rekoda /var/lib/docker 2>/dev/null | awk 'NR==1||1'
grep -E 'MemAvailable|MemTotal' /proc/meminfo

echo "== deploy markers"
ls -l .git/rekoda-deploy-staging.state .git/rekoda-deploy-staging.rollback 2>&1 | cut -c1-200

echo "== billing settings (SET/UNSET only)"
for k in REKODA_WEB_URL REKODA_ANNUAL_BILLING \
         REKODA_EMAIL_PROVIDER RESEND_API_KEY REKODA_EMAIL_FROM RESEND_WEBHOOK_SECRET \
         WORKER_DATABASE_URL; do
  # Read as compose resolves it: whitespace before an opening quote, trailing whitespace and a CRLF
  # line end are dropped, a comment is
  # dropped (" # c" after an unquoted value; "#c" or " # c" after the closing quote of a quoted
  # one) and one pair of surrounding quotes is removed, so KEY="", KEY= # later, KEY="" # later,
  # KEY=""#later, KEY= "" and KEY= (spaces only) all read empty (independent review and CodeRabbit on #428).
  v="$(sed -n "s/^$k=//p" .env 2>/dev/null | head -1 |
       sed -e 's/^[[:space:]]*\(["'"'"']\)/\1/' -e 's/[[:space:]]*$//' \
           -e '/^["'"'"']/!s/[[:space:]][[:space:]]*#.*$//' \
           -e 's/^\("[^"]*"\)[[:space:]]*#.*$/\1/' \
           -e "s/^\('[^']*'\)[[:space:]]*#.*\$/\1/" \
           -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
  if [ -z "$v" ]; then
    # Staging runs the production compose file with a separate worker, Resend email and the web
    # app, so everything here is required except annual billing, which is optional.
    case "$k" in
      # An empty assignment (REKODA_ANNUAL_BILLING=) reaches the process as "", which it refuses
      # to boot with; only a line that is absent is unset.
      REKODA_ANNUAL_BILLING) if grep -q "^$k=" .env 2>/dev/null; then flag "$k" "SET but empty (the process refuses to boot with it)"
                             else say "$k" UNSET; fi ;;
      *) flag "$k" "UNSET (required on staging)" ;;
    esac
  else
    case "$k" in
      # Classified, never printed: a URL can carry credentials and the output is shared. Staging's
      # billing-email journeys send through Resend, so any other provider needs attention (the
      # running api and worker are asked below as well, in case the containers predate an edit).
      REKODA_EMAIL_PROVIDER) if [ "$v" = resend ]; then say "$k" "SET (resend)"
                             else flag "$k" "SET (not resend; staging needs resend)"; fi ;;
      # Only 0 or 1 boots (zeroOrOneFlag); anything else would refuse at the next restart.
      REKODA_ANNUAL_BILLING) case "$v" in 0|1) say "$k" "SET ($v)" ;; *) flag "$k" "SET (not 0 or 1; the process refuses to boot with it)" ;; esac ;;
      *) say "$k" SET ;;
    esac
  fi
done

# The Paystack key kind and the OWN-70 platform flag, asked of the running api (as it resolved
# them, whatever the .env spelling), classified inside the container: the key is never printed.
# Staging runs a TEST key and leaves the flag UNSET (OWN-70; #418: a test key needs no flag).
echo "== Paystack settings in the running api (classification only)"
r="$(dc exec -T api sh -c 'v="${PAYSTACK_SECRET_KEY:-}"; case "$v" in "") echo UNSET ;; sk_test_?*) echo TEST ;; sk_live_?*) echo LIVE ;; *) echo OTHER ;; esac' 2>/dev/null)"
case "$r" in
  TEST) say "PAYSTACK_SECRET_KEY" "SET (TEST-KEY)" ;;
  UNSET) flag "PAYSTACK_SECRET_KEY" "UNSET (staging test payments need an sk_test_ key)" ;;
  LIVE) flag "PAYSTACK_SECRET_KEY" "SET (NOT-A-TEST-KEY: a live key; staging must run an sk_test_ key)" ;;
  OTHER) flag "PAYSTACK_SECRET_KEY" "SET (NOT-A-TEST-KEY: unrecognised, so payments fail closed)" ;;
  *) flag "PAYSTACK_SECRET_KEY" "unknown (cannot exec into the api container)" ;;
esac
r="$(dc exec -T api sh -c 'v="${REKODA_PAYSTACK_PLATFORM_CONFIRMED:-}"; case "$v" in "") echo UNSET ;; 1) echo SET ;; *) echo OTHER ;; esac' 2>/dev/null)"
case "$r" in
  UNSET) say "REKODA_PAYSTACK_PLATFORM_CONFIRMED" "UNSET" ;;
  SET) flag "REKODA_PAYSTACK_PLATFORM_CONFIRMED" "SET (OWN-70: it stays UNSET on staging)" ;;
  OTHER) flag "REKODA_PAYSTACK_PLATFORM_CONFIRMED" "SET to a value other than 1 (the api honours only 1; OWN-70: leave it UNSET)" ;;
  *) flag "REKODA_PAYSTACK_PLATFORM_CONFIRMED" "unknown (cannot exec into the api container)" ;;
esac

# All five WhatsApp template slots the API reads (G-03; OD-41 for which approved template is the
# trial one). Presence only: the configured names are matched against Meta's dashboard by hand.
# Asked of the running api container, not parsed from .env, so quoting, inline comments and
# defaults resolve exactly as the API sees them. Each value is only tested for emptiness, never
# printed.
echo "== Meta template slots in the running api (SET/UNSET only)"
if dc exec -T api true >/dev/null 2>&1; then
  for k in META_OTP_TEMPLATE META_BILLING_TEMPLATE META_RETENTION_TEMPLATE META_DOCUMENT_TEMPLATE \
           META_TRIAL_TEMPLATE; do
    # The container answers SET or UNSET itself; anything else (a failed exec, a container that
    # stopped mid-loop) is reported as unknown, never as UNSET.
    r="$(dc exec -T -e "K=$k" api sh -c 'eval "v=\${$K:-}"; if [ -n "$v" ]; then echo SET; else echo UNSET; fi' 2>/dev/null)"
    case "$r" in
      SET) say "$k" "$r" ;;
      UNSET) flag "$k" "$r" ;;
      *) flag "$k" "unknown (api query failed)" ;;
    esac
  done
else
  flag "Meta template slots" "unknown (cannot exec into the api container)"
fi

# Customer payment reminders (N1, REM-01..06) run only with REKODA_CUSTOMER_REMINDERS=1, and the
# api and the worker each read it. Absent or 0 is off (the default); 1 is on; anything else makes
# the process refuse to boot (apps/api/src/config.ts, zeroOrOneFlag). Asked of each running
# container; the classification is printed, not the raw value. This script never changes it.
echo "== customer reminders in the running api and worker (effective value)"
declare -A REM
for c in api worker; do
  r="$(dc exec -T -e K=REKODA_CUSTOMER_REMINDERS "$c" sh -c 'eval "v=\${$K-__unset__}"; case "$v" in __unset__) echo UNSET ;; 0) echo 0 ;; 1) echo 1 ;; *) echo OTHER ;; esac' 2>/dev/null)"
  case "$r" in
    UNSET) say "REKODA_CUSTOMER_REMINDERS ($c)" "OFF (unset; the default is off)" ;;
    0) say "REKODA_CUSTOMER_REMINDERS ($c)" "OFF (0)" ;;
    1) say "REKODA_CUSTOMER_REMINDERS ($c)" "ON (1)" ;;
    OTHER) flag "REKODA_CUSTOMER_REMINDERS ($c)" "INVALID (not 0 or 1; the process refuses to boot with it)" ;;
    *) flag "REKODA_CUSTOMER_REMINDERS ($c)" "unknown (cannot exec into the $c container)" ;;
  esac
  # OFF whether unset or 0: what matters is whether reminders run.
  case "$r" in UNSET|0) REM[$c]=OFF ;; 1) REM[$c]=ON ;; *) REM[$c]="" ;; esac
done
# The api queues reminders and the worker sends them; both off or both on is consistent.
if [ -n "${REM[api]}" ] && [ -n "${REM[worker]}" ]; then
  if [ "${REM[api]}" = "${REM[worker]}" ]; then say "reminders api and worker" "SAME (${REM[api]})"
  else flag "reminders api and worker" "DIFFERENT (api ${REM[api]}, worker ${REM[worker]})"; fi
fi

# The email provider each running container resolved: an .env edited without recreating the
# containers is not what they send with. Classified inside the container; only resend passes.
echo "== email provider in the running api and worker (classification only)"
for c in api worker; do
  r="$(dc exec -T -e K=REKODA_EMAIL_PROVIDER "$c" sh -c 'eval "v=\${$K-__unset__}"; case "$v" in __unset__) echo UNSET ;; resend) echo RESEND ;; *) echo OTHER ;; esac' 2>/dev/null)"
  case "$r" in
    RESEND) say "REKODA_EMAIL_PROVIDER ($c)" "resend" ;;
    UNSET) flag "REKODA_EMAIL_PROVIDER ($c)" "UNSET (staging needs resend)" ;;
    OTHER) flag "REKODA_EMAIL_PROVIDER ($c)" "not resend (staging needs resend)" ;;
    *) flag "REKODA_EMAIL_PROVIDER ($c)" "unknown (cannot exec into the $c container)" ;;
  esac
done

echo "== attention (anything above that is not as expected or could not be checked)"
# The last line is the verdict, and so is the exit status: 0 only when nothing needs attention.
# A missing, incomplete or inconsistent migration, a mismatched commit or image, or a check that
# could not be made all land here, so none of them can end in "OK".
if [ -z "$ATTN" ]; then
  echo "none"
  echo "RESULT: OK (every check above is as expected)"
else
  printf '%s' "$ATTN"
  echo "RESULT: ATTENTION ($(printf '%s' "$ATTN" | grep -c .) item(s) above need a look)"
  exit 1
fi
