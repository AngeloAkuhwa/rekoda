# Staging configuration, deployment and acceptance plan for PR #432 (PR B)

Prepared 13 Nov 2026 from the PR #432 head `06035e6` (code, compose file, deploy script, runbooks). **Nothing
here has been applied to any host.** No secret value appears in this document. Production is out of scope.

## 0. Evidence and limits

| Fact | Evidence |
| --- | --- |
| PR #432 head is `06035e6`, open, not merged, not draft, mergeable `clean` | GitHub API, 13 Nov 2026 |
| All required checks green on `06035e6` (CI run 43426914017: typecheck/lint/test/build, db 1/2 + 2/2, api 1/2 + 2/2, Integration, Playwright, Docker, foreign-owner migrations, gitleaks, GitGuardian). CodeRabbit **skipped** (330 files > 100 limit), not a review | `get_check_runs` on the PR |
| 42 review threads, 0 unresolved | `get_review_comments` |
| Codex: usage limit on every request; **not an approval** | PR comments 06:38, 13:55, 18:38 UTC |
| PR description: "Merge: the owner's. Not to be merged or deployed without explicit owner approval" | PR body |
| Staging currently runs `main` `58e6834` (PR A), migrations to 0192 | Deploy staging run #184 (8 Nov 2026), success |
| **Staging's `.env` was NOT inspected.** This session cannot reach the host or even `https://staging-api.myrekoda.com/health` (network policy) | — |

So **no row below is "Already configured and verified"**. Where the currently running release could not boot
without a value (it runs `NODE_ENV=production`, which refuses to start without it), the row says
**"Exists but needs verification"**. That is a strong inference, not a check. Everything new in PR #432 is
**"Missing and must be added"** until someone looks.

## 1. How the four processes get their configuration

| Process | Entry point | Gets `.env` how | Holds | Must NOT be given (refuses to start in production) |
| --- | --- | --- | --- | --- |
| `api` | `dist/main.js`, `REKODA_WORKER=0`, port 3001 | `env_file: .env` (the whole file) | `DATABASE_URL`, `WORKER_DATABASE_URL`, all app secrets | `SETTLEMENT_DATABASE_URL`, `OPERATOR_DATABASE_URL` (compose blanks both) |
| `worker` | same image, `REKODA_WORKER=1`, loopback 3001 | `env_file: .env` | same as api | same as api |
| `settlement` | `dist/settlement-main.js`, loopback health 3003 | **does not read `.env`**. Compose passes only `SETTLEMENT_DATABASE_URL`, `VAULT_KEY`, `PAYSTACK_SECRET_KEY`, `REKODA_PLAN_CATALOGUE_READS`, `REKODA_SETTLEMENT_CONCURRENCY` (interpolated from `.env`) | settlement role, vault key, platform Paystack key | `DATABASE_URL`, `WORKER_DATABASE_URL`, `OPERATOR_DATABASE_URL`, `MATCH_KEY`, `CONNECTION_KEY`, `OTP_PEPPER`, `REKODA_API_SECRET`, `REKODA_OPERATOR_SECRET`, `MONO_SECRET_KEY`, `META_*` secrets, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RESEND_*` |
| `operator` | `dist/operator-main.js`, port 3002 (Caddy routes `/v1/businesses/plan*` to it) | **does not read `.env`**. Compose passes only `OPERATOR_DATABASE_URL`, `OPERATOR_OIDC_ISSUER`, `OPERATOR_OIDC_JWKS_URL`, `OPERATOR_BILLING_OIDC_AUDIENCE`, `OPERATOR_OIDC_AUDIENCE`, `OPERATOR_OIDC_SCOPE_CLAIM` | billing-operator role | all of the above plus `VAULT_KEY`, `PAYSTACK_SECRET_KEY`, `SETTLEMENT_DATABASE_URL` |
| `web` | `next start`, port 3000 | build args (`NEXT_PUBLIC_*`, baked in) + runtime `REKODA_API_URL` (compose: `http://api:3001`), `REKODA_WEB_URL` | nothing secret | — |
| `migrate` (one-off) | `deploy/migrate.sh` | `env_file: .env` + owner password secret file | owner credential; sets the 4 runtime role passwords from the 4 URLs | — |

Consequences:

- **All values go into the one host `.env`** (`/opt/rekoda/.env`, mode 600). The per-service split is done by
  `docker-compose.prod.yml`; never edit the compose file to add a value.
- Because `settlement` and `operator` take values by interpolation, **a variable exported in the shell you run
  `docker compose` from overrides `.env`** for those two. Run compose from a clean login shell.
- **No value may contain `$`** (compose interpolates). Generate every secret with `openssl rand -hex 32`.
- `NEXT_PUBLIC_*` are baked into the web image: changing one needs a web rebuild, not a restart.

## 2. Database users, permissions and connection strings

You do **not** create database users by hand. Migration 0202 creates `rekoda_settlement` and
`rekoda_billing_operator`; `rekoda_app` and `rekoda_worker` already exist. `migrate.sh` then runs
`provision.js`, which sets each role's password from its URL in `.env` and refuses:

- a URL whose user is not exactly the expected role;
- a URL pointing at a different host/port/database from the owner's;
- a password shorter than 24 printable ASCII characters;
- **any two of the four passwords being the same**;
- any of the four URLs missing (migrate.sh exits before touching anything).

Required shape (host `postgres`, port 5432, database `rekoda`):

```
DATABASE_URL=postgres://rekoda_app:<pw1>@postgres:5432/rekoda
WORKER_DATABASE_URL=postgres://rekoda_worker:<pw2>@postgres:5432/rekoda
SETTLEMENT_DATABASE_URL=postgres://rekoda_settlement:<pw3>@postgres:5432/rekoda   # NEW
OPERATOR_DATABASE_URL=postgres://rekoda_billing_operator:<pw4>@postgres:5432/rekoda # NEW
```

`<pw3>` and `<pw4>`: run `openssl rand -hex 32` once each. They must differ from each other and from `<pw1>`/`<pw2>`.
The owner password stays in `secrets/postgres_owner_password` (directory 700, file 644, hex only, 24+ chars), never in `.env`.

At boot each process also proves its own identity: settlement must log in as exactly `rekoda_settlement`,
operator as exactly `rekoda_billing_operator`, neither may bypass RLS, and in production none may see the
test-only fixture writer. A wrong URL fails loudly rather than running with the wrong rights.

## 3. Consolidated staging checklist

Statuses: **V** = already configured and verified · **E** = exists but needs verification · **M** = missing and
must be added · **O** = optional · **N/A** = not applicable to staging. (No row is V: see §0.)

Service key: A = api, W = worker, S = settlement, Op = operator, Wb = web, C = caddy, Mg = migrate, Cmp = compose itself.

### 3.1 Deployment and edge

| Variable / setting | Service | Purpose | Required? | Secret? | Status | Action required |
| --- | --- | --- | --- | --- | --- | --- |
| `REKODA_RELEASE` | Cmp, all | Image tag; `/health` release | Yes (blank refuses every compose command) | No | E | Leave; the deploy script rewrites this one line |
| `REKODA_API_PUBLIC_URL` | C, deploy script | API hostname; webhook host | Yes; must equal `https://staging-api.myrekoda.com` or the staging deploy refuses | No (URL) | E | Verify exact value |
| `NEXT_PUBLIC_SITE_URL` | Wb (build), C | Site hostname, canonicals | Yes (web build and compose refuse without it) | No (URL) | E | Verify `https://staging.myrekoda.com` |
| `REKODA_ACME_EMAIL` | C | Let's Encrypt notices | Yes (compose `:?`) | No | E | Verify a mailbox you read |
| `REKODA_EDGE_PROXIES` | C, edge-check | Cloudflare ranges when proxied | Only if Cloudflare proxies (orange cloud) | No | E/O | If proxied: Cloudflare's published IPv4 ranges, space-separated. If DNS-only: empty |
| `REKODA_TRUSTED_PROXIES`, `REKODA_TRUSTED_WEB` | A, W | Client-address trust | Set by compose (`172.30.10.10`, `.11`) | No | N/A in `.env` | Do not set in `.env` |
| `NODE_ENV`, `PORT`, `REKODA_WORKER` | all | Mode, ports | Set by compose | No | N/A in `.env` | Do not set |
| `REKODA_COMMIT` | all | Build commit | Set by the image build | No | N/A | Do not set |
| `REKODA_DEPLOY_MIN_MEM_KB`, `REKODA_DEPLOY_MIN_FREE_KB` | deploy script | Memory/disk floors | O (1 GiB / disk floor defaults) | No | O | Leave unset |

### 3.2 Database

| Variable / setting | Service | Purpose | Required? | Secret? | Status | Action required |
| --- | --- | --- | --- | --- | --- | --- |
| `secrets/postgres_owner_password` (file) | postgres, Mg | Owner/superuser | Yes | **Secret** | E | Verify present, 644 in a 700 dir |
| `DATABASE_URL` | A, W, Mg | `rekoda_app` | Yes at boot | **Secret** (contains password) | E | Verify role name `rekoda_app` |
| `WORKER_DATABASE_URL` | A, W, Mg | `rekoda_worker` | Yes (worker refuses without it) | **Secret** | E | Verify |
| `SETTLEMENT_DATABASE_URL` | S, Mg (blanked for A, W) | `rekoda_settlement` | **Yes**: settlement, migrate.sh and the deploy script all refuse without it | **Secret** | **M** | Add with a new, distinct password (§2) |
| `OPERATOR_DATABASE_URL` | Op, Mg (blanked for A, W) | `rekoda_billing_operator` | **Yes**: same | **Secret** | **M** | Add with a new, distinct password (§2) |
| `REKODA_PLAN_CATALOGUE_READS` | A, W, S | Pricing source | O (default catalogue; 0215 enforces agreement) | No | O | **Leave unset everywhere** |
| `REKODA_WORKER_CONCURRENCY` / `REKODA_SETTLEMENT_CONCURRENCY` | W / S | Job lanes (4 / 2) | O | No | O | Leave unset on the 4 GB host |

### 3.3 Application secrets and identity

| Variable / setting | Service | Purpose | Required? | Secret? | Status | Action required |
| --- | --- | --- | --- | --- | --- | --- |
| `VAULT_KEY` | A, W, **S** | Customer-identity vault; sealed webhook payloads | Yes (64 hex; fingerprint-enrolled, a different key refuses boot) | **Secret** | E | Verify present. **Never change it.** Compose now also passes it to settlement (`:?`) |
| `MATCH_KEY` | A, W | Identity matching HMAC | Yes (64 hex, enrolled) | **Secret** | E | Verify |
| `CONNECTION_KEY` | A, W | Encrypts merchant settlement account numbers | O at boot; needed for merchant payment connection | **Secret** | E/O | Verify; set it if staging tests merchant Paystack connections |
| `REKODA_API_SECRET` | A, W | Signs setup grants | Yes (≥32) | **Secret** | E | Verify |
| `OTP_PEPPER` | A, W | OTP hashing | Yes (≥32) | **Secret** | E | Verify |
| `OPERATOR_OIDC_ISSUER` | A, W, Op | Operator token issuer | Yes in production (all three or none; public https) | No (URL) | E | Verify. **Now also needed by the operator process** |
| `OPERATOR_OIDC_JWKS_URL` | A, W, Op | Token signing keys | Yes | No (URL) | E | Verify |
| `OPERATOR_OIDC_AUDIENCE` | A, W (Op reads it only to compare) | API operator audience | Yes | No (identifier) | E | Verify |
| `OPERATOR_BILLING_OIDC_AUDIENCE` | **Op** | Audience for plan changes only | **Yes**: operator, compose and the deploy script refuse without it, or if it equals `OPERATOR_OIDC_AUDIENCE` | No (identifier) | **M** | Add. Your identity provider must issue tokens for this second audience, from the **same issuer**, carrying **only** this audience (the operator enforces an exclusive audience) and scope `ops:billing` |
| `OPERATOR_OIDC_SCOPE_CLAIM` | A, W, Op | Claim holding scopes | O (default `scope`) | No | O | Set only if your IdP puts scopes elsewhere |
| `REKODA_OPERATOR_SECRET`, `REKODA_OPERATOR_HOST` | — | Dev stand-in / bind host | Refused in production | Secret | N/A | **Must be unset** |
| `REKODA_WEB_URL` | A, W, Wb | Dashboard origin; billing link in grace and trial templates; email links | Yes for staging billing and templates (must be https) | No (URL) | E | Verify `https://staging.myrekoda.com` (no path) |
| `REKODA_CORS_ORIGINS` | A | Allowed browser origins | **Defaults to `http://localhost:3000`** | No | E | Verify it names `https://staging.myrekoda.com` |
| `REKODA_ALERT_WEBHOOK_URL` | W | Operational alerts | O (https, public host) | Treat as **secret** | O, recommended | Set to a chat incoming-webhook URL (see §5.6) |
| `REKODA_RATE_LIMIT_MAX`, `REKODA_SHOP_ORDERS_PER_HOUR`, `REKODA_TRANSFER_VERIFY_MIN_SECONDS` | A | Limits | O | No | O | Leave default |
| `REKODA_COMMAND_*` (14 flags) | A, W | Emergency rollback per command | O | No | O | **Leave all unset** (OD-4, OWN-22) |
| `REKODA_ANNUAL_BILLING` | A, W | Allows choosing yearly | O (0/1) | No | E/O | Set `1` for the yearly acceptance steps |
| `REKODA_STAGING_TOOLS` | A, W | OWN-77 test-business date and fault tools | O, but **required for walkthrough 17-19, 22 and journeys 2, 3, 9, 10** | No | **M** | Add `REKODA_STAGING_TOOLS=1` **after** the first deploy is healthy (staging `.env` only, never compose); needs a test Paystack key |
| `REKODA_CUSTOMER_REMINDERS` | A, W | Customer payment reminders | O (0/1). When 1, `REKODA_WEB_URL` must be a bare https origin | No | E (should be `0`/unset now) | Keep OFF until the billing walkthrough is done, then set `1` |
| `REKODA_SUPPORT_EMAIL` | A, W | Support contact (not the reminder Reply-To) | O (one bare address) | No | O | Optional |
| `REKODA_REVEAL_OTP`, `REKODA_LOCAL_STORAGE`, `PAYSTACK_BASE_URL`, `MONO_BASE_URL`, `REKODA_E2E_*` | — | Test hooks | Refused or forbidden in deployments | — | N/A | **Must be unset** |

### 3.4 Paystack (Rekoda's own subscription billing, TEST mode)

| Variable / setting | Service | Purpose | Required? | Secret? | Status | Action required |
| --- | --- | --- | --- | --- | --- | --- |
| `PAYSTACK_SECRET_KEY` | A, W, **S** | Checkout, server-side verify, **and** the Paystack webhook signature (HMAC-SHA512) | Not enforced at boot. **Without it, every webhook is rejected and every settlement job fails verify until it goes to the dead-job queue, while `/health` stays ok** | **Secret** | E (no recorded check result found in the repository; the read-only check expects `SET (TEST-KEY)`) | Must start `sk_test_`. Verify in **both** api and settlement containers (§6, step P3) |
| Paystack **public** key (`pk_test_…`) | — | — | **Not used.** No code reads a Paystack public key: checkout is server-initialised and redirects to Paystack's hosted page | — | N/A | Nothing to add |
| `REKODA_PAYSTACK_PLATFORM_CONFIRMED` | A, W | §47 live-key confirmation | Must stay unset (`REKODA_STAGING_TOOLS=1` refuses to boot with it) | No | must be unset | Verify unset |
| Paystack dashboard (TEST mode) → Settings → API Keys & Webhooks → Test Webhook URL | Paystack | Delivers `charge.success` etc. | Yes | — | E (needs verification) | `https://staging-api.myrekoda.com/webhooks/paystack` (the only Paystack ingress) |
| Paystack dashboard → Test Callback URL | Paystack | Not needed | — | — | N/A | Rekoda sends its own return URL `<REKODA_WEB_URL>/app/billing/return` |

**Merchant Paystack connections:** staging runs production mode, so `POST /v1/payments/merchant-key` **refuses a
merchant's TEST key** (`rejected_test_key`, `connections.service.ts:215`). Merchant-side card payments cannot be
accepted on staging; those journeys record a payment by hand. `docs/REKODA_LAUNCH_READINESS.md` §11.2 step 9
("connect a TEST key from `/app/payments`") contradicts this and should be corrected.

### 3.5 WhatsApp / Meta

The code reads **no** Meta App ID and **no** WABA ID. It needs only the following.

| Variable / setting | Service | Purpose | Required? | Secret? | Status | Action required |
| --- | --- | --- | --- | --- | --- | --- |
| `META_APP_SECRET` | A, W | Verifies `X-Hub-Signature-256` on webhooks | **Yes in production** (≥16) | **Secret** | E | Verify (App Dashboard → Settings → Basic → App secret) |
| `META_VERIFY_TOKEN` | A, W | GET handshake | **Yes in production** (≥16) | **Secret** | E | Verify; must equal what is typed in the Meta webhook config |
| `META_ACCESS_TOKEN` | A, W | Sending | O at boot (empty = replies recorded, not delivered); in production, set without `META_OTP_TEMPLATE` refuses boot | **Secret** | E | Verify a **system-user permanent token** with `whatsapp_business_messaging` + `whatsapp_business_management`. A 24-hour temporary token will silently stop sends next day |
| `META_PHONE_NUMBER_ID` | A, W | Sending number | Yes for sending | No (identifier) | E | Verify (WhatsApp → API Setup → Phone number ID) |
| `META_GRAPH_VERSION` | A, W | Graph version | O (default `v21.0`) | No | O | Leave |
| `META_OTP_TEMPLATE` / `_LOCALE` | A, W | Sign-in code, AUTHENTICATION, 1 body param + copy-code URL button | Yes | No | E | `rekoda_login_otp`; locale exactly as WhatsApp Manager shows (`en` if unset) |
| `META_BILLING_TEMPLATE` / `_LOCALE` | A, W | Grace reminder, UTILITY, 3 params (days left, end date, billing link) | Yes for grace steps | No | **E/M**: new slot from PR A | `rekoda_billing_grace_notice`; set only once **Approved** |
| `META_DOCUMENT_TEMPLATE` / `_LOCALE` | A, W | Document ready outside 24 h, UTILITY, 2 params (label, reference) | Yes | No | E/M | `rekoda_document_ready` |
| `META_TRIAL_TEMPLATE` / `META_TRIAL_TEMPLATE_LOCALE` | A, W | Trial ending 7/2/1 days, UTILITY, 3 params (days left, end date, billing link) | Yes for trial journeys | No | E/M | `rekoda_trial_ending`, locale **`en`** (confirmed against `template-slots.ts` and OWN-80) |
| `META_RETENTION_TEMPLATE` / `_LOCALE` | A, W | Deletion notice, UTILITY, 2 params | O (unset = retention sweep warns nobody and deletes nothing) | No | O | `rekoda_retention_notice` if approved |
| `META_SERVICE_REPLY_COST_MICROS`, `META_WABA_REGISTERED_IN_NIGERIA` | A, W | Cost telemetry | O | No | O | Leave defaults |
| Meta webhook callback | Meta | Inbound messages and delivery statuses | Yes | — | E | Callback `https://staging-api.myrekoda.com/webhooks/meta`, verify token = `META_VERIFY_TOKEN`, subscribe field **`messages`** (carries statuses too) |
| Test recipients | Meta | Who a test number may message | Yes | — | Needs verification | Add every tester phone (up to Meta's test-recipient limit) to the allowed list. A reminder customer must have messaged the connected number within 24 h |

Boot rejects a malformed template name (`^[a-z0-9_]{1,512}$`) or locale (`^[a-z]{2,3}(_[A-Z]{2})?$`). It does
**not** know whether Meta approved it. A name that is set but not approved fails every send with Meta error 132000. Approval is a manual check in WhatsApp Manager (`docs/runbooks/meta-whatsapp-templates.md`).

### 3.6 Resend (email)

| Variable / setting | Service | Purpose | Required? | Secret? | Status | Action required |
| --- | --- | --- | --- | --- | --- | --- |
| `REKODA_EMAIL_PROVIDER` | A, W | `none` / `resend` (`mock` refused in production) | Yes for billing-email steps (must be `resend`) | No | E (the 7 Nov check expected `resend`) | Verify `resend` |
| `RESEND_API_KEY` | A, W | Sending | Yes with `resend` (boot refuses) | **Secret** | E | Verify; a sending-only key |
| `REKODA_EMAIL_FROM` | A, W | From address | Yes with `resend` | No | E | e.g. `Rekoda <billing@<verified domain>>`, on the verified domain |
| `RESEND_WEBHOOK_SECRET` | A, W | Svix signature on bounce/complaint webhooks | Yes with `resend` (boot refuses) | **Secret** | E | `whsec_…` from the Resend webhook |
| Resend domain | Resend + Cloudflare DNS | SPF, DKIM (records Resend gives), `_dmarc` TXT `p=none` | Yes | — | Needs verification | Domain shows **Verified** in Resend |
| Resend webhook | Resend | Bounces and complaints | Yes | — | Needs verification | `https://staging-api.myrekoda.com/webhooks/resend`, events `email.bounced`, `email.complained` |

### 3.7 AI, media, storage, bank (needed only for those features)

| Variable / setting | Service | Purpose | Required? | Secret? | Status | Action required |
| --- | --- | --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | A, W | Message interpretation; vision | O at boot (empty = AI behaves as down); required if `AI_PROVIDER=anthropic` or `IMAGE_AI_ENABLED=1` | **Secret** | E | Verify. Spend is capped by `AI_DAILY_*` |
| `AI_PROVIDER`, `AI_MODEL_*`, `AI_MODEL_PRICES`, `AI_BASE_URL` | A, W | Model choice and prices | O (defaults: Sonnet 5 default, Haiku 4.5 classifier, Opus 5 escalation) | No | O | Leave defaults unless deliberately changing |
| `OPENAI_API_KEY`, `VOICE_TRANSCRIPTION_ENABLED`, `AI_TRANSCRIPTION_PRICES` | A, W | Voice notes | Only if voice is enabled (boot refuses `1` without key and prices) | **Secret** (key) | O | Enable only if voice acceptance is in scope |
| `IMAGE_AI_ENABLED` | A, W | Photo reading | O | No | O | `1` only with `ANTHROPIC_API_KEY` |
| `AI_DAILY_CALLS_*`, `AI_DOC_EXTRACTIONS_*`, `VOICE_SECONDS_*`, `VOICE_NOTE_MAX_DURATION_SECONDS`, `AI_DUAL_EXTRACT_THRESHOLD_K`, `PLANNING_FX_NGN_PER_USD`, `FX_MODE` | A, W | Ceilings and cost | O | No | O | Defaults; `FX_MODE` stays `off` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | A, W | PDF/document storage | All four or none (partial refuses boot). None = documents rendered but not stored | Secret (keys) | E/O | Needed for "document ready" re-download; verify all four or none |
| `MONO_SECRET_KEY`, `NEXT_PUBLIC_MONO_PUBLIC_KEY` | A, W, Wb | Bank feeds | O (commercially closed) | Secret (secret key) | N/A | Leave unset |

### 3.8 Web build-time values (baked in)

| Variable | Required? | Status | Action |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_LEGAL_ENTITY`, `NEXT_PUBLIC_LEGAL_RC_NUMBER`, `NEXT_PUBLIC_LEGAL_ADDRESS`, `NEXT_PUBLIC_PRIVACY_EMAIL`, `NEXT_PUBLIC_SUPPORT_EMAIL` | **Yes**: the Docker web build and `next start` refuse without all five | E | Verify (staging builds today, so they are set) |
| `NEXT_PUBLIC_REKODA_WHATSAPP` | O (setup-complete page shows no Chat number without it) | E/O | Set to the staging sign-in number |
| `NEXT_PUBLIC_NDPR_AUDITOR` | O | O | — |

### 3.9 Outside `.env`

| Setting | Where | Required? | Status | Action |
| --- | --- | --- | --- | --- |
| `STAGING_HOST`, `STAGING_USER`, `STAGING_SSH_PRIVATE_KEY`, `STAGING_KNOWN_HOSTS` | GitHub → Settings → Environments → `staging` → secrets | Yes for automatic deploys | E (run #184 succeeded) | None |
| **Required reviewer on the `staging` environment** | GitHub → Environments → `staging` → Deployment protection rules | Recommended for this one release | M | Add yourself (see §6) |
| `staging_environment` marker row | database, written as owner | Yes for staging tools | M | After deploy (§6 step D7) |
| Operator tokens with `ops:read`, `ops:payment`, `ops:staging` (API audience) and `ops:billing` (billing audience) | your OIDC identity provider | Yes for operator steps | Needs verification | Confirm the IdP can mint both audiences |
| `/etc/rekoda/backup.env`: `BACKUP_DEST`, `BACKUP_PASSPHRASE_FILE`, `BACKUP_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REQUEST_CHECKSUM_CALCULATION`, `BACKUP_RETAIN_DAYS` | host, root-only 0600 | **Yes for a verified off-box backup** | **M** (G-02: "NOT enabled, no off-box destination") | §5.5 |

## 4. Configuration gaps that adding `.env` values does not fix

1. **No off-box backup exists (G-02).** The scripts and systemd units are merged but have never been enabled, and
   no destination is chosen. The runbook's "fresh off-box backup" step cannot be done until a destination exists.
   **Owner decision: the off-box provider** (§5.5).
2. **The automatic staging deploy does not do the manual pre-checks.** Merging #432 triggers CI, then Deploy
   staging. That stops all four processes, migrates, smokes and starts. It does **not** check the Paystack key,
   list pending charges, take a backup or run `preflight-subscriptions`. Fix: a required reviewer on the GitHub
   `staging` environment before merging (§6).
3. **`preflight-subscriptions` needs migration 0208,** which only exists after `migrate`. The automatic script
   goes from migrate straight to `up`, so on staging the preflight can only run after the deploy. Staging holds
   only test businesses, so I recommend accepting that order: run it immediately after the deploy and fix any
   FAIL with `correct_subscription_period`. The alternative, a hand-driven deploy, is in `deploy.md`.
4. **Nothing enforces the settlement Paystack key.** The settlement process starts and reports healthy without
   one. `deploy-staging.sh` does not check it, and `staging-readonly-check.sh` classifies the key only inside the
   **api** container. It checks neither OIDC values nor the settlement/operator URLs. Until code covers it, the
   manual check is step P3 below. A small follow-up PR should add it to both scripts.
5. **Memory on the 4 GB host.** This release adds two more Node processes (operator, settlement) beside api,
   worker, web, Postgres and Caddy. Builds already need at least 1 GiB free. Add a 2 GiB swap file now. Better,
   resize to 8 GB (ADR 0006 planned CPX31) before acceptance (§5.1).
6. **Identity provider.** The operator process needs a second audience from the same issuer, issued exclusively.
   Whether the current staging IdP tenant can do that is not visible from the repository.
7. **Meta template approval** is external. Setting a name does not prove approval.
8. **Monitoring.** There is no error-reporting service (no Sentry), no alert on OTP failures (G-12) or on dead
   outbox events (G-18), no backup-failure alert and no external uptime check. `REKODA_ALERT_WEBHOOK_URL` covers
   dead jobs, overdue/backlogged jobs, unprocessed or flagged webhooks, blocked renewals and WhatsApp delivery
   failures only.
9. **Merchant Paystack test keys are refused on staging** (production mode), so customer card payments to a
   merchant cannot be accepted end to end on staging (§3.4).

## 5. Hetzner and host configuration guide

### 5.1 Hetzner Cloud console

1. **Server size.** Servers → the staging server → *Rescale*. Recommended: 8 GB RAM (CPX31 class). Rescaling
   CPU/RAM only, without the disk, keeps the option to scale back down. It needs a short power-off: do it
   before the deploy window. If you keep 4 GB, add swap (step 5.2.3).
2. **Snapshot before the deploy.** Servers → staging → *Snapshots* → *Take snapshot*, named
   `pre-pr432-<date>`. This is a whole-disk fallback held by Hetzner. **It does not replace** the off-box,
   restore-drilled dump the runbook requires (same provider, not verified by restore).
3. **Cloud Firewall** (Firewalls → Create → apply to the staging server), as well as `ufw`:
   - inbound TCP 22: **your own IP(s) only**, plus GitHub Actions if the deploy workflow connects directly.
     GitHub runner IPs vary, so in practice keep 22 open and keep SSH key-only.
   - inbound TCP 80, TCP 443, UDP 443: any. If Cloudflare proxies, Cloudflare's ranges only.
   - nothing else. Postgres (5432) and the app ports (3000 to 3003) are **never** published. The compose file
     keeps the database on an internal network with no route out.
4. **Backups (Hetzner's 7-day server backups)** are optional extra protection. Same caveat as snapshots.
5. **Volumes.** Not required. The database lives in the Docker volume `pgdata` on the server disk. Keep at least
   8 GiB free on `/opt/rekoda` and `/var/lib/docker`.

### 5.2 On the server (SSH as the deploy user)

1. Ubuntu LTS, non-root deploy user, `PasswordAuthentication no`, `ufw allow 22,80,443/tcp` and `443/udp`,
   Docker Engine and the Compose v2 plugin (already in place if staging deploys today; verify `docker compose version`).
2. Checkout at `/opt/rekoda`; `.env` mode 600; `secrets/` mode 700.
3. Swap if staying at 4 GB: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`, plus an `/etc/fstab` line.
4. Edit `.env` with a text editor over SSH. **Do not paste secrets into the Hetzner web console's VNC
   keyboard** (it mangles characters and is not a secure channel). Never `cat` the file onto a shared screen.

### 5.3 Containers, ports, networks, health, startup order

| Container | Port (internal) | Networks | Health check | Starts after |
| --- | --- | --- | --- | --- |
| `postgres` | 5432, not published | `db` (internal) | `pg_isready` | — |
| `api` | 3001 | `edge`, `db` | `GET /health` status ok | postgres healthy |
| `worker` | loopback | `db`, `worker-egress` | `/health` ok | postgres healthy |
| `settlement` | loopback 3003 | `db`, `settlement-egress` | `/health` ok and `process=settlement` | postgres healthy |
| `operator` | 3002 | `edge`, `db` | `/health` ok and `process=operator` | postgres healthy |
| `web` | 3000 (172.30.10.11) | `edge` | `GET /terms` 200 | api healthy |
| `edge-check` | none (`network_mode: none`) | — | one-shot, exit 0 | — |
| `caddy` | **80, 443, 443/udp published** (172.30.10.10) | `edge` | — | web and api healthy, edge-check succeeded |

Caddy terminates HTTPS for both hostnames (automatic Let's Encrypt). It routes `/v1/businesses/plan` and
`/v1/businesses/plan/*` to `operator:3002` and everything else on the API host to `api:3001`. DNS: A records
only (no AAAA). Under Cloudflare: SSL "Full (strict)", "Always Use HTTPS" off, `REKODA_EDGE_PROXIES` set.

### 5.4 Logging

All services use the Docker `json-file` driver, 10 MB × 5 files each. Read with `dc logs <service>`
(`dc` = `docker compose -f docker-compose.prod.yml`). Nothing ships logs off the host.

### 5.5 Off-box backup (G-02), the one real infrastructure task

**Owner decision needed: the destination.** Options the scripts support:

- **A. S3-compatible bucket at another provider** (Backblaze B2, as ADR 0006 planned, or Cloudflare R2).
  Benefit: a different failure domain from Hetzner. Risk: one more account and credential.
- **B. Hetzner Object Storage or a Storage Box.** Benefit: same console. Risk: the same provider holds both
  copies, so it is weaker as "off-box".

**Recommendation: A (B2 or R2)**, with versioning or object lock on, and a key limited to Put/Get/List plus
Delete only on `.pending` objects.

Setup:

1. Create the bucket and key.
2. As root, create `/etc/rekoda/backup.env` (mode 0600) with `BACKUP_DEST=s3://<bucket>/staging`,
   `BACKUP_S3_ENDPOINT=<provider endpoint>`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
   `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` and `BACKUP_PASSPHRASE_FILE=/etc/rekoda/backup.pass`.
3. Generate the passphrase with `openssl rand -hex 32 > /etc/rekoda/backup.pass; chmod 600`. Store a copy in
   your password manager: without it a backup cannot be restored.
4. Install the aws CLI and openssl.
5. Install the units: `cp deploy/systemd/rekoda-backup.* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now rekoda-backup.timer`.

**Verified** means both of these:

- a run of `systemctl start rekoda-backup` prints `backup: ok <name> <bytes>` (it reads the upload back and
  compares checksums);
- `scripts/restore-drill.sh` restores that object into a throwaway Postgres and exits 0 (every business's ledger balances).

Record the date, object name and drill result in `docs/runbooks/backup-restore.md`.

### 5.6 Monitoring to add (small, recommended before acceptance)

- `REKODA_ALERT_WEBHOOK_URL`: a Slack, Discord or Google Chat incoming webhook (https).
- An external uptime check (any free monitor) on `https://staging-api.myrekoda.com/health`, expecting
  `"status":"ok"`, and on `https://staging.myrekoda.com/terms`.
- Weekly: `systemctl status rekoda-backup` and the newest backup object's date (no backup alert exists yet).

## 6. Deployment sequence (staging only)

**Before the merge (nothing live changes):**

| Step | Action | Evidence to keep |
| --- | --- | --- |
| P1 | GitHub → Settings → Environments → `staging` → add yourself as **required reviewer**. Merging then queues the deploy until you approve it | Screenshot of the rule |
| P2 | Hetzner: rescale or add swap (§5.1/§5.2); take snapshot `pre-pr432-<date>` | Snapshot name and time |
| P3 | Check the Paystack key type in the running api without printing it: `dc exec -T api node -e 'const k=process.env.PAYSTACK_SECRET_KEY||"";console.log(k.startsWith("sk_test_")?"TEST":k.startsWith("sk_live_")?"LIVE":k?"OTHER":"UNSET")'`. Must print `TEST`. Also `grep -c '^PAYSTACK_SECRET_KEY=sk_test_' .env` must print `1`, because settlement takes the same `.env` value. `grep -c '^REKODA_PAYSTACK_PLATFORM_CONFIRMED=' .env` must print `0` | The printed words |
| P4 | List pending Rekoda charges, read-only, as owner: `dc exec -T postgres psql -U rekoda_owner -d rekoda -c "SELECT reference, kind, created_at FROM subscription_charges WHERE status='pending'"` | The list (references only) |
| P5 | Fresh off-box backup **and** restore drill (§5.5) | `backup: ok …` line; drill exit 0 |
| P6 | Add to `.env`: `SETTLEMENT_DATABASE_URL`, `OPERATOR_DATABASE_URL` (new distinct passwords) and `OPERATOR_BILLING_OIDC_AUDIENCE` (different from `OPERATOR_OIDC_AUDIENCE`). Check the names, not values: `grep -cE '^(SETTLEMENT_DATABASE_URL=postgres://rekoda_settlement:\|OPERATOR_DATABASE_URL=postgres://rekoda_billing_operator:\|OPERATOR_BILLING_OIDC_AUDIENCE=.)' .env` must print `3` | Count printed |
| P7 | Confirm `VAULT_KEY`, `OPERATOR_OIDC_ISSUER` and `OPERATOR_OIDC_JWKS_URL` are present (the compose file now requires them for new services): `grep -cE '^(VAULT_KEY\|OPERATOR_OIDC_ISSUER\|OPERATOR_OIDC_JWKS_URL\|OPERATOR_OIDC_AUDIENCE)=.' .env` must print `4` | Count |
| P8 | Confirm the identity provider can mint a billing-audience token with `ops:billing` (needed after the deploy) | Token minted (do not paste it anywhere) |
| P9 | **Explicit owner approval to merge #432** (the PR says the merge is yours) | Your approval |

**The deploy:**

| Step | Action | Evidence |
| --- | --- | --- |
| D1 | Squash-merge #432 (explicit squash message, no trailers). CI runs on `main` | Merge SHA, CI run green on it |
| D2 | Approve the queued Deploy staging run. `deploy-staging.sh`: refuses if any P6/P7 value is missing; builds api, then web; **stops `api worker operator settlement`**; checks they are stopped; `migrate` (0193 to 0223, then the four role passwords); pre-start smoke must print `t`; `up -d --wait`; `/health` names the release | The whole run log; the line `runtime role passwords set: rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator` |
| D3 | Immediately, release preflight: `dc run --rm -T migrate sh /repo/deploy/migrate.sh preflight-subscriptions`. Exit 0 = PASS. On 1, correct each listed test business (`deploy.md`, "Correcting an active row"). On 2, stop and investigate | JSON report and exit code |
| D4 | `dc logs settlement` shows `job runner started … Paystack key set`. `dc logs operator` shows `identity: verified tokens`. Settlement key type: `dc exec -T settlement node -e '…same one-liner as P3…'` prints `TEST` | Log lines |
| D5 | `curl -sS -o /dev/null -w '%{http_code}' -X POST https://staging-api.myrekoda.com/v1/businesses/plan` → `401` (the operator answered) | Code |
| D6 | Read-only check: `ssh … 'EXPECT_SHA=<merge sha> EXPECT_WEB_URL=https://staging.myrekoda.com bash -s' < scripts/staging-readonly-check.sh` → `RESULT: OK`, 224 migrations applied, all six services healthy | Full output |
| D7 | Staging tools: add `REKODA_STAGING_TOOLS=1` to `.env`; `dc up -d --wait --force-recreate api worker`; as owner `INSERT INTO staging_environment (marked_by, note) VALUES ('owner:<name>', 'staging acceptance, OWN-77');` | Health ok after recreate |

**Rollback:** never a down migration. Past 0196 the only database rollback is restoring the P5 backup (or, as a
last resort, the Hetzner snapshot). Stop `operator` and `settlement` first. Prefer fixing forward.

## 7. Acceptance walkthrough

Run with test phones, test inboxes and Paystack TEST cards only. Desktop **and** phone width for every screen.
Per step, record: date, tester, commit, expected, actual, safe reference, desktop/mobile, PASS/FAIL/BLOCKED.
Full step text: `docs/runbooks/billing-staging-walkthrough.md` (SUB-ACC), `docs/runbooks/staging-acceptance-handoff.md`
(ACCEPT-01), `docs/runbooks/staging-test-business-tools.md` (OWN-77). All rows are STAGING/TEST-MODE unless marked.

| # | Area | Test | Expected | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Registration | `/start`, phone, WhatsApp OTP, business name | Code arrives by `rekoda_login_otp`; setup-complete page | Screenshot; Meta message log entry |
| 2 | Trial | `/app/billing` on a fresh business | "Free trial", 14 days in words, empty history | Screenshots |
| 3 | Prices | Monthly, then yearly | ₦9,900 / ₦19,900 / ₦29,900; yearly 10× | Screenshots |
| 4 | Checkout | Chat → Confirm and pay → billing email → Pay with Paystack | Quote matches; hosted TEST page; nothing charged by looking | Reference |
| 5 | Payment verification | TEST card, return | "Confirming…" then "Payment received / active until <date>" only after server verify; Paystack test dashboard shows the same reference | Both screenshots |
| 6 | Webhook replay | Resend the event from the Paystack dashboard | Still one payment, one period | History screenshot |
| 7 | Upgrade, downgrade, interval | Integrate (prorated), back to Chat at renewal, yearly at renewal | As quoted; undo works | Screenshots |
| 8 | Pack | Buy a pack | Units appear once this month; pack Paid | Usage before and after |
| 9 | Usage limits | Dashboard meter vs "This month" | Same ceiling. **No exhaustion test is defined in the docs**: add one (spend to 0, then expect a refusal in plain words and an upgrade/pack CTA) | Screenshots |
| 10 | Cancel | Cancel | Plan runs to the named date; undo | Screenshot |
| 11 | Renewal paid | Staging tool: `paid_to` +1h, pay renewal | Extended from the old renewal date; no grace | Action log; reference |
| 12 | Grace and expiry | `paid_to` −1h, grace day 1/5/7 | Renewal charge; reminders on day 1 and 5 by `rekoda_billing_grace_notice` with a working billing link; day 7 read-only, exportable, nothing deleted | Messages with times; action log |
| 13 | Reactivation | Pay after expiry | Fresh cycle from payment day; no second trial | Screenshot |
| 14 | Reminder failure | Staging fault `send_timeout` / `sender_refused` | Timeout: day-1 reminder not resent; refused: exactly one on next pass | Action log |
| 15 | Trial reminders | `trial_end` +7d, +2d, +1d, sweep each | One `rekoda_trial_ending` per stage, none twice; none after paying (separate business) | Messages with times |
| 16 | Trial expiry | `trial_end` −1h | "Your free trial ended on …"; records readable; no deletion wording; upgrade reachable | Screenshots |
| 17 | Email | Billing-email confirm; two businesses, same address within 60 s; six businesses | One link per rule; second use of a link refused; sixth refused for an hour; bounce test address suppressed | Inbox screenshots |
| 18 | Duplicate payment (pack paid on two links) | Open two pack links, pay both | Units once; second payment paid with `duplicate_purchase`, on `GET /v1/ops/exceptions`; merchant sees "paid twice". Refund in the Paystack TEST dashboard, `POST /v1/ops/refund`, resolve. **Same-charge duplicate: do not call `/v1/ops/refund`** (runbook). Refund authority and wording are still open (OD-53 (1), (2)) | Exception row; references |
| 19 | Operator billing | Billing-audience token: `POST /v1/businesses/plan` with `expiresAt: null`; `/plan/support-review` on a support-reviewed upgrade; an API-audience token on the same route | Standard period set; support review keeps paid-through; API token refused | Responses (no tokens) |
| 20 | Failed-job recovery (OWN-73/76) | `GET /v1/ops/exceptions`; `POST /v1/ops/dead-jobs/:id/recover` and `/resolve` (`ops:payment`) | Dead `billing.process` job recovered once; merchant exception and ops item both present | **BLOCKED**: no documented way to create a dead job on staging (ACCEPT-01 17(b)). Needs an owner-approved procedure |
| 21 | WhatsApp chat | Text a sale, an expense; `who owes me`; a photo/voice note if enabled | Draft → confirm → numbered record; figures computed, not AI-produced | Screenshots |
| 22 | Documents | Ask for an invoice outside 24 h | `rekoda_document_ready` delivered; PDF opens (needs R2) | Message log |
| 23 | Customer reminders | After SUB-ACC: `REKODA_CUSTOMER_REMINDERS=1`, recreate api/worker; journeys 11 to 16 of ACCEPT-01 (single, before-dispatch payment, STOP per channel per merchant, queued vs opt-out, payment instructions, scheduled/bulk) | As `staging-acceptance-handoff.md` §5 | Per journey |
| 24 | Retention | Retention sweep | **Not runnable on staging** as documented (the tools cannot move a trial past 90 days). Check that `rekoda_retention_notice` delivers once if approved | — |

LIVE-PROVIDER REQUIRED (not for this phase): real Paystack live charge and refund (G-05/G-06), merchant
card payments, production Meta number and templates (G-03), live AI evaluation (G-07).

## 8. What must be decided or supplied by the owner

1. Approval to merge #432 (step P9).
2. The off-box backup provider (§5.5; recommendation: B2 or R2).
3. The identity provider's second audience for billing (P8).
4. Meta template approvals for the four required slots (and retention if wanted).
5. Server resize to 8 GB, or accept 4 GB with swap.
6. A procedure for creating a dead job on staging (row 20), or accept it as blocked.
7. OD-53 (1), (2), (4), (5) before paid launch, not before staging.

## 9. Recommended small follow-ups (code, after #432)

- `deploy-staging.sh`: refuse a release carrying 0217 when `.env`'s `PAYSTACK_SECRET_KEY` is not `sk_test_…`.
- `staging-readonly-check.sh`: classify the key inside the **settlement** container; report the OIDC names and
  the settlement/operator URL roles as SET/UNSET.
- `docs/REKODA_LAUNCH_READINESS.md`: §11.2 step 9 (merchant TEST key), §11.1 "Email/SMS: none used", and "four
  templates" are stale.
