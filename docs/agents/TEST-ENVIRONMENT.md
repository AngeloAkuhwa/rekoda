# The `agents-*` and `test` GitHub Environments

How the autonomous-engineering workflows get credentials, and how Rekoda's
own runtime configuration is provided when a workflow boots the stack. No
secret **values** appear in this document, ever — only names and where each
value lives.

**The rule that shapes everything here:** agent credentials and Rekoda
runtime credentials are two different things, live in different GitHub
Environments, and never share a name. Agent credentials are further split
**per role**. Environment membership alone is NOT the security boundary —
any workflow file could name an environment. The boundary is
**trusted-base execution** (docs/AUTONOMOUS-ENGINEERING.md §6): the
secret-bearing jobs exist only in the privileged `Agent — gates` /
authority workflows, whose definitions GitHub executes from the default
branch, so PR-controlled YAML can never receive these secrets. The
environments then add two supporting layers: each one carries a
**deployment-branch policy restricted to `main`** (GitHub refuses it to
any PR-ref job), and each signing key exists only in the one environment
its privileged workflow references — the builder cannot mint a
reviewer's verdict and the planner cannot mint contract evidence.

- **`agents-builder`** — the Claude builder lanes. Holds only the AI
  credential, never a signing key.
- **`agents-claude-reviewer`** — the Technical Review Gate's Claude lane:
  AI credential + the Claude-reviewer signing key.
- **`agents-gemini-reviewer`** — the Gemini Acceptance Gate: AI
  credential + the Gemini-reviewer signing key.
- **`agents-planner`** — the Gemini planner: AI credential only.
- **`agents-contract-authority`** — the deterministic contract-authority
  workflow: the contract signing key only, no AI credential.
- **Environment `test`** — Rekoda application/runtime sandbox credentials
  only (`TEST_REKODA_…` names). Only jobs that boot or test the Rekoda
  stack reference it. It contains **no** agent credentials.

**The credential rule, single and absolute:** engineering agents NEVER
directly receive Rekoda runtime provider credentials — there is no
task-shaped exception. When a task needs sandbox or live validation, that
validation runs in a **separate deterministic, non-agent job** that
references the `test` environment; the engineering agent receives the
job's output and evidence, never the credential. Production credentials
are never available to any autonomous agent workflow, in either
environment.

Where a runtime name would collide with an agent name, the GitHub secret
carries a `TEST_REKODA_` prefix and the workflow's `env:` block maps it to
the runtime name explicitly:

```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.TEST_REKODA_ANTHROPIC_API_KEY }}
```

`CLAUDE_CODE_OAUTH_TOKEN` is never handed to the Rekoda application, and
`TEST_REKODA_ANTHROPIC_API_KEY` is never handed to the Claude agent.

## A. Agent credentials (the `agents-*` environments, secrets)

| Environment                 | Secret                           | Notes                                                                                                                                        |
| --------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents-builder`            | `CLAUDE_CODE_OAUTH_TOKEN`        | Subscription OAuth token from `claude setup-token`. No `ANTHROPIC_API_KEY` is configured for any agent — subscription auth is the only path. |
| `agents-claude-reviewer`    | `CLAUDE_CODE_OAUTH_TOKEN`        | Same token value; separate environment so the reviewer's signing key never coexists with builder jobs.                                       |
| `agents-claude-reviewer`    | `CLAUDE_REVIEWER_SIGNING_KEY`    | Ed25519 private key signing `REKODA_CLAUDE_APPROVAL` (public half committed in `scripts/agents/keys/`).                                      |
| `agents-gemini-reviewer`    | `GEMINI_API_KEY`                 | Unattended API key for GitHub Actions.                                                                                                       |
| `agents-gemini-reviewer`    | `GEMINI_REVIEWER_SIGNING_KEY`    | Ed25519 private key signing `REKODA_GEMINI_APPROVAL`.                                                                                        |
| `agents-planner`            | `GEMINI_API_KEY`                 | Same key value; the planner deliberately holds no signing key.                                                                               |
| `agents-contract-authority` | `CONTRACT_AUTHORITY_SIGNING_KEY` | Ed25519 private key signing contract baseline/revision markers; no AI credential.                                                            |
| _(none for Codex)_          | —                                | Codex review/building run on OpenAI's native integration under the owner's ChatGPT subscription. No `OPENAI_API_KEY` exists.                 |

The owner generates the three keypairs locally with
`scripts/agents/generate-signing-keys.mjs`, commits the public halves,
and pastes each private key into its environment — the private keys never
enter the repository, and until the public keys are committed every
reviewer gate fails closed.

## B. Rekoda runtime configuration for CI/test (environment `test`)

Classification of every `.env.example` setting. Categories:

- **ephemeral** — generated fresh inside the CI job with
  `openssl rand -hex 32`, never stored anywhere.
- **secret** — GitHub secret in the `test` environment (real value, test
  tier only).
- **variable** — GitHub variable in the `test` environment, or a literal
  in the workflow file (non-secret configuration).
- **omitted** — intentionally unset in test; the code degrades safely by
  design.
- **synthetic** — test-only stand-in configuration that exercises the code
  path with values that mean nothing outside the job (a local issuer, a
  computed HMAC). Not a real provider credential and not a production
  value.
- **sandbox** — needs a real provider sandbox/test account to mean
  anything; lives as a `test` secret but only the deterministic live-smoke
  job reads it (never an engineering agent).
- **production-only** — MUST NOT exist in the `test` environment in any
  form.

### Database (ephemeral) — three roles, two naming namespaces

Three distinct connections, never conflated:

- **owner/migration connection** — the `rekoda` role that owns the schema;
  used ONLY to run migrations.
- **application connection** — the `rekoda_app` role, RLS-constrained; what
  the API uses.
- **worker connection** — the `rekoda_worker` role, RLS-constrained like
  `rekoda_app` plus the queue-claim grant (ADR 0022).

The variable names differ by context, deliberately. The application
runtime (`.env.example`) uses `DATABASE_URL` = **app** role,
`OWNER_DATABASE_URL` = owner/migrations, `WORKER_DATABASE_URL` = worker.
The CI test harness (`ci.yml` and `packages/db/src/testing.ts`, which
refuses to run as superuser) uses `DATABASE_URL` = **owner**,
`APP_DATABASE_URL` = app, `WORKER_DATABASE_URL` = worker. All of them are
ephemeral in CI: a job-scoped PostgreSQL with trust auth — no passwords,
no stored URLs. Never run the db and api integration suites in parallel;
they share the database.

### Security keys (ephemeral)

`VAULT_KEY`, `MATCH_KEY`, `CONNECTION_KEY`, `SESSION_SECRET`,
`REKODA_API_SECRET`, `OTP_PEPPER`, `REKODA_OPERATOR_SECRET` — each
generated per run, each distinct (the doctor refuses reuse). Generating at
runtime also keeps high-entropy literals out of the tree, which gitleaks
would otherwise flag.

### Runtime shape (variable / literal)

`NODE_ENV`, `PORT`, `APP_URL`, `NEXT_PUBLIC_SITE_URL`, `REKODA_API_URL`,
`REKODA_CORS_ORIGINS`, `REKODA_RATE_LIMIT_MAX`, `REKODA_WORKER`,
`REKODA_WORKER_CONCURRENCY`, `REKODA_WEB_URL`, `META_GRAPH_VERSION`,
`META_SERVICE_REPLY_COST_MICROS`, `META_WABA_REGISTERED_IN_NIGERIA`,
`PLANNING_FX_NGN_PER_USD` (a positive number or the line deleted — an
empty value is refused at boot), `AI_DAILY_CALLS_PER_BUSINESS`,
`AI_DAILY_CALLS_GLOBAL`, `AI_DOC_EXTRACTIONS_PER_BUSINESS`,
`AI_DOC_EXTRACTIONS_GLOBAL`, `VOICE_SECONDS_PER_BUSINESS_PER_DAY`,
`VOICE_SECONDS_GLOBAL_PER_DAY`, `VOICE_NOTE_MAX_DURATION_SECONDS` —
non-secret; workflow literals or `test` variables. Localhost URLs
throughout.

### AI configuration (variable / omitted)

- `AI_PROVIDER` — **variable**: set explicitly in any lane that exercises
  AI paths (a typo fails at boot by design); irrelevant in deterministic
  suites that run keyless.
- `AI_MODEL_DEFAULT`, `AI_MODEL_CLASSIFIER`, `AI_MODEL_PRICES`,
  `AI_TRANSCRIPTION_PRICES` — **variable**: exact model ids and price
  tables, non-secret.
- `AI_MODEL_ESCALATION` — **omitted**: OFF at launch by documented
  default; a lane that tests escalation sets it explicitly.
- `AI_MODEL_VISION`, `AI_MODEL_TRANSCRIBER` — **omitted** (documented
  defaults) except in the media lanes that test them.
- `AI_MODEL_VISION_VERIFIER`, `AI_DUAL_EXTRACT_THRESHOLD_K` —
  **omitted**: dual extraction stays off in test unless a lane tests it,
  in which case the verifier must be a different vendor than the primary
  and its family priced in `AI_MODEL_PRICES` (boot refuses otherwise).
- `AI_BASE_URL` — **omitted** in test. Pointing it at a local fake for a
  contract test is **synthetic**; pointing it at any third-party
  OpenAI-compatible host is a compliance decision the owner makes, never a
  test convenience.

### Test hooks (ephemeral, test-only by design)

`REKODA_REVEAL_OTP` / `REKODA_E2E_REVEAL_OTP` — set only by
`playwright.config.ts`; the API refuses to boot with them in production.

### Meta / WhatsApp (omitted)

`META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_OTP_TEMPLATE` (+
locales), `META_BILLING_TEMPLATE`, `META_RETENTION_TEMPLATE` — omitted.
Unset, inbound is still recorded and replies are simply not delivered,
which is the designed degradation. `META_APP_SECRET` and
`META_VERIFY_TOKEN` are **ephemeral** where a signature/handshake test
needs one. There is no meaningful Meta sandbox before the owner's WABA
and approved templates exist (owner-held, `docs/REKODA_OWNER_DECISIONS.md`
§2); a live Meta smoke lane is deliberately not designed yet.

### Paystack (sandbox)

| GitHub secret/variable                                                  | Maps to runtime                                   | Class                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| secret `TEST_REKODA_PAYSTACK_SECRET_KEY`                                | `PAYSTACK_SECRET_KEY`                             | sandbox — a Paystack **test-mode** key (`sk_test_…`), never a live key |
| variables `TEST_REKODA_PAYSTACK_PLAN_CHAT` / `_INTEGRATE` / `_COMPLETE` | `PAYSTACK_PLAN_CHAT` / `_INTEGRATE` / `_COMPLETE` | variable — test-mode plan codes                                        |

`PAYSTACK_BASE_URL` stays unset for the live-smoke lane and points at the
local fake for deterministic contract tests. Deterministic suites do not
need the secret at all — every webhook path is exercised against computed
HMACs with ephemeral keys.

### AI providers (sandbox)

| GitHub secret                   | Maps to runtime     | Class                                                              |
| ------------------------------- | ------------------- | ------------------------------------------------------------------ |
| `TEST_REKODA_ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | sandbox — a dedicated low-limit key for the AI live-eval lane only |
| `TEST_REKODA_OPENAI_API_KEY`    | `OPENAI_API_KEY`    | sandbox — same, for transcription; only when the voice lane runs   |

Deterministic suites run with both omitted: the router degrades to
deterministic answers by design. `VOICE_TRANSCRIPTION_ENABLED` /
`IMAGE_AI_ENABLED` stay unset except in the lane that tests them (each
refuses to boot without its key, so enabling them in a keyless job fails
loudly — correct, and the reason they are off by default).

### Object storage (omitted / sandbox)

Deterministic runs: `R2_*` omitted, `REKODA_LOCAL_STORAGE` set to a job
temp dir (development-only escape hatch, which a CI job is). If a live R2
smoke is ever wanted: secrets `TEST_REKODA_R2_ACCOUNT_ID`,
`TEST_REKODA_R2_ACCESS_KEY_ID`, `TEST_REKODA_R2_SECRET_ACCESS_KEY` and
variable `TEST_REKODA_R2_BUCKET` naming a dedicated test bucket — never
the production bucket.

### Production-only — MUST NOT be in `test`

- `NEXT_PUBLIC_LEGAL_*` real values (test renders the designed "not set
  yet" badges; the real entity facts are owner-held deployment values).
- `OPERATOR_OIDC_ISSUER` / `_AUDIENCE` / `_JWKS_URL` / `_SCOPE_CLAIM` —
  the **production values** are production-only. Test uses the
  development stand-in `REKODA_OPERATOR_SECRET` (ephemeral); if a lane
  ever needs the OIDC code path itself, it uses a **synthetic** local
  issuer/JWKS spun up inside the job — synthetic OIDC configuration is
  not the same thing as production OIDC endpoints and never touches them.
- `REKODA_PAYSTACK_PLATFORM_CONFIRMED` — the owner's recorded §47
  confirmation; test keys do not need it and setting it in test rehearses
  lying.
- `REKODA_TRUSTED_PROXIES` — no proxy in CI.
- `FX_MODE` anything other than `off` (a dedicated FX lane may use
  `sandbox` per ADR 0033; `live` never).
- Any **live** provider key (Paystack `sk_live_…`, production Meta token,
  production R2 credentials, production database URL). If one is ever
  found in the `test` or `agents` environment, treat it as burned and
  rotate.

## Provider test principle

Every external provider gets both layers, and an outage of one must not
make the repository untestable:

1. **Deterministic contract tests** (default, run everywhere): local
   fakes, computed signatures, ephemeral keys. These are the merge-gate's
   backbone and need no environment secrets.
2. **Narrow live sandbox smoke** (path-aware): a small suite hitting the
   real test-mode provider, running only when relevant paths change, but
   reporting through a **stable job name** so branch protection can
   require it. When the paths did not change, the job succeeds by
   explicitly reporting "not applicable" — a skip that branch protection
   still sees as the named job passing. These are **deterministic,
   non-agent jobs**: they read `test` secrets, an engineering agent reads
   only their output.
