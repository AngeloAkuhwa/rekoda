#!/usr/bin/env bash
# Read-only staging check (billing directive, 26 Oct 2026). Changes nothing and prints no secret value:
# environment settings are reported as SET or UNSET only. Run it on the staging host from /opt/rekoda:
#   ssh <deploy-user>@<host> 'bash -s' < scripts/staging-readonly-check.sh
# Optional: EXPECT_SHA=<40-char sha> to compare the running release with a commit.
set -u
API_URL="${API_URL:-https://staging-api.myrekoda.com}"
cd /opt/rekoda 2>/dev/null || { echo "FAIL not in /opt/rekoda"; exit 1; }
# stdin is closed for every compose call: the script is usually piped in over ssh (`bash -s`), and
# a `compose exec` left on that stdin can swallow the unread rest of the script.
dc() { docker compose -f docker-compose.prod.yml "$@" </dev/null; }
say() { printf '%-34s %s\n' "$1" "$2"; }

echo "== release identity"
say "checkout HEAD" "$(git rev-parse HEAD)"
say "tracked modifications" "$(git --no-optional-locks status --porcelain --untracked-files=no | wc -l)"
say ".env REKODA_RELEASE" "$(sed -n 's/^REKODA_RELEASE=//p' .env)"
[ -n "${EXPECT_SHA:-}" ] && say "matches EXPECT_SHA" "$([ "$(git rev-parse HEAD)" = "$EXPECT_SHA" ] && echo yes || echo NO)"
for c in api worker web; do
  id="$(dc ps -q "$c" 2>/dev/null)"
  say "image of $c" "$([ -n "$id" ] && docker inspect -f '{{.Config.Image}}' "$id" || echo MISSING)"
done

echo "== health (API)"
curl -fsS --max-time 15 "$API_URL/health" || echo "FAIL /health"
echo
echo "== web"
say "web status" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://staging.myrekoda.com/ || true)"

echo "== services"
dc ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Health}}' 2>/dev/null

echo "== migration 0181 (the OD-33 discovery function)"
{ dc exec -T postgres sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-rekoda}" -Atc "select proname, prosecdef from pg_proc where proname = '"'"'sweep_trial_candidates'"'"'"' 2>/dev/null || echo "could not query (check the postgres user/db names)"; } | awk 'NF{f=1;print} END{if(!f)print "MISSING"}'

echo "== migration 0183 (billing email send outcome column)"
{ dc exec -T postgres sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-rekoda}" -Atc "select column_name from information_schema.columns where table_name = '"'"'billing_email_verifications'"'"' and column_name = '"'"'send_outcome'"'"'"' 2>/dev/null || echo "could not query (check the postgres user/db names)"; } | awk 'NF{f=1;print} END{if(!f)print "MISSING"}'

echo "== migration 0186 (trial reminder delivery failure column)"
{ dc exec -T postgres sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-rekoda}" -Atc "select column_name from information_schema.columns where table_name = '"'"'businesses'"'"' and column_name = '"'"'trial_notice_failed_at'"'"'"' 2>/dev/null || echo "could not query (check the postgres user/db names)"; } | awk 'NF{f=1;print} END{if(!f)print "MISSING"}'

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
    f:f) say "$1" "MISSING" ;;
    t:f) say "$1" "INCOMPLETE (objects exist, migration not recorded)" ;;
    f:t) say "$1" "INCONSISTENT (recorded, objects missing)" ;;
    *) say "$1" "unknown (query failed; check the postgres user/db names)" ;;
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

echo "== recent errors (last 30 minutes; counts only, no log text is printed)"
for c in api worker; do
  n="$(dc logs --since 30m "$c" 2>&1 | grep -ciE '"level":(50|60)|ERROR|FATAL|migration')"
  say "error-like lines in $c" "${n:-unknown}"
done

echo "== resources"
df -h /opt/rekoda /var/lib/docker 2>/dev/null | awk 'NR==1||1'
grep -E 'MemAvailable|MemTotal' /proc/meminfo

echo "== deploy markers"
ls -l .git/rekoda-deploy-staging.state .git/rekoda-deploy-staging.rollback 2>&1 | cut -c1-200

echo "== billing settings (SET/UNSET only)"
for k in PAYSTACK_SECRET_KEY REKODA_PAYSTACK_PLATFORM_CONFIRMED REKODA_WEB_URL REKODA_ANNUAL_BILLING \
         REKODA_EMAIL_PROVIDER RESEND_API_KEY REKODA_EMAIL_FROM RESEND_WEBHOOK_SECRET \
         REKODA_WORKER WORKER_DATABASE_URL; do
  v="$(sed -n "s/^$k=//p" .env | head -1)"
  if [ -z "$v" ]; then say "$k" UNSET; else
    case "$k" in
      PAYSTACK_SECRET_KEY) say "$k" "SET ($( [ "${v#sk_test_}" != "$v" ] && echo TEST-KEY || echo NOT-A-TEST-KEY ))" ;;
      REKODA_PAYSTACK_PLATFORM_CONFIRMED|REKODA_ANNUAL_BILLING|REKODA_EMAIL_PROVIDER|REKODA_WEB_URL|REKODA_WORKER) say "$k" "SET ($v)" ;;
      *) say "$k" SET ;;
    esac
  fi
done

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
      SET|UNSET) say "$k" "$r" ;;
      *) say "$k" "unknown (api query failed)" ;;
    esac
  done
else
  say "Meta template slots" "unknown (cannot exec into the api container)"
fi
