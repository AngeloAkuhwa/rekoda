#!/usr/bin/env bash
# Read-only staging check (billing directive, 26 Oct 2026). Changes nothing and prints no secret value:
# environment settings are reported as SET or UNSET only. Run it on the staging host from /opt/rekoda:
#   ssh <deploy-user>@<host> 'bash -s' < scripts/staging-readonly-check.sh
# Optional: EXPECT_SHA=<40-char sha> to compare the running release with a commit.
set -u
API_URL="${API_URL:-https://staging-api.myrekoda.com}"
cd /opt/rekoda 2>/dev/null || { echo "FAIL not in /opt/rekoda"; exit 1; }
dc() { docker compose -f docker-compose.prod.yml "$@"; }
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
echo "== Meta template slots (SET/UNSET only)"
for k in META_OTP_TEMPLATE META_BILLING_TEMPLATE META_RETENTION_TEMPLATE META_DOCUMENT_TEMPLATE \
         META_TRIAL_TEMPLATE; do
  # The effective value, as Compose reads it: surrounding spaces and one pair of quotes removed,
  # so META_TRIAL_TEMPLATE="" reads as UNSET.
  v="$(sed -n "s/^$k=//p" .env | head -1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
        -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
  if [ -z "$v" ]; then say "$k" UNSET; else say "$k" SET; fi
done
