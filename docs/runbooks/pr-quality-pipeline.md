# PR quality and release safety pipeline

Status: IN PROGRESS. PR 1 of the sequence below (#303) adds this runbook. Later PRs update it as each
slice lands. It describes what is enforced today and what is not; it never claims a control that is
only planned.

## The signals, and what each one means

Six different things. None of them stands in for another.

| Signal                           | Who produces it                             | What it proves                                                                                                                                                                                                                                                                                                 | What it does NOT prove                                           |
| -------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| CodeRabbit review approval       | `coderabbitai[bot]` (`.coderabbit.yaml`)    | Its latest review covers the PR head, its required threads are resolved, and no pre-merge check it evaluates is failing                                                                                                                                                                                        | CI success, a human approval, an owner ruling, staging behaviour |
| Codex findings                   | `chatgpt-codex-connector[bot]`              | An independent model reviewed a named commit; its findings are claims to verify                                                                                                                                                                                                                                | Anything when it reports a usage limit (that is no review)       |
| CI success                       | GitHub Actions `CI` on the exact SHA        | The repository's tests, typecheck, lint, migrations, Docker smoke, Playwright and secret scan passed on that commit                                                                                                                                                                                            | That the change is correct where no test looks                   |
| Merge eligibility                | The playbook gate (OWN-26), later a ruleset | Exact-head CI green, 0 unresolved threads, reviews complete on the head, every `error`-mode CodeRabbit pre-merge check passing on the head, a final independent Claude review with 0 BLOCKING / 0 IMPORTANT and no change after it, required approvals present, no conflict (full gate: playbook steps 6 to 8) | That it runs correctly on staging                                |
| Staging acceptance               | The owner, with physical evidence           | The behaviour works on the staging host with real channels                                                                                                                                                                                                                                                     | Production readiness, live provider behaviour                    |
| Production release authorization | The owner, explicitly, per release          | The owner accepts the release evidence report                                                                                                                                                                                                                                                                  | Nothing is deployed to production automatically, ever            |

## Phase 0 audit (22 Oct 2026, `main` at `5762ba7`)

Evidence, then the gap each item leaves.

1. **Branch protection.** The GitHub branch API reports `main` with `protected: false`. G-09 records
   no rulesets either. Nothing in GitHub stops a direct push, a force push, a merge with red CI or a
   merge with unresolved threads. Every control below is procedural until the owner enables a
   ruleset (see "Branch rules" below).
2. **CI** (`.github/workflows/ci.yml`, triggered on `pull_request` and on `push` to `main`). Six jobs:
   - `Secret scan (gitleaks)` scans the full history;
   - `Typecheck · lint · test · build` also runs the boundary, env-template, deploy-shape,
     staging-runbook, Node-version, UI-copy, retired-claims and OpenAPI guards;
   - `Deployment (Docker)` boots, attacks, restarts and rolls back the production stack;
   - `Migrations (foreign owner)`;
   - `Integration (PostgreSQL)` runs the db and api suites serially;
   - `End-to-end (Playwright)`.

   The GitGuardian app also checks each push.

3. **CI concurrency.** `group: ci-${{ github.ref }}` with
   `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`: a superseded pull-request run is
   cancelled, a run on `main` never is, because `deploy-staging.yml` requires a successful push run
   for the exact commit. At most one newer `main` run waits behind a running one and GitHub drops
   older waiting runs. If the newer run then fails, the replaced commit has no successful CI run for an
   automatic staging deploy, so merges must stay serial (below). `scripts/check-staging-deploy.mjs`
   fails if the group stops being per-ref or `main` can be cancelled. Merges are still taken one at a
   time (one `main` CI run and its staging deploy finish before the next merge), so the staging deploy
   always has a commit with its own successful run.
4. **Dependency scanning.** Dependabot opens weekly update PRs for npm and Actions. There is no
   vulnerability gate (`pnpm audit` or equivalent) in CI (G-42).
5. **Static security analysis.** There is no CodeQL or equivalent SAST job.
6. **Staging deploy** (`.github/workflows/deploy-staging.yml`). It runs only after a successful CI
   push run on `main` in this repository, or by hand from `main` with that provenance proven by
   `gh run list`. It is serialised and never cancelled, and it runs `scripts/deploy-staging.sh` on
   the host. The script refuses an unhealthy baseline, refuses a commit that does not know staging's
   schema, migrates expand-only, and checks `/health` for the exact release and commit, from both
   the host and Cloudflare. It never prunes images or volumes. Gaps: there is no post-deploy smoke of
   authentication, tenancy, the storefront or webhook rejection, and no disk-space check or
   structured deployment report (PR 4).
7. **CodeRabbit** is installed and active. It reviews every PR to `main`, and its run shows the configuration
   source and profile. `.coderabbit.yaml` (this PR) moves it to the repository configuration, the
   assertive profile, the request-changes workflow and pre-merge checks. Its checks are evaluated by
   a model, so they are review signals, not a deterministic gate. Probe #304 (22 Oct 2026, head `aadf770`: a
   non-conventional title, an edit to applied migration 0165, an added `it.skip`) proved they fire
   with this configuration: "Pre-merge checks failed: 5 errors", and a request-changes review naming
   both violations. The probe was closed unmerged.
8. **Codex** is installed (`chatgpt-codex-connector[bot]`). It reviews on PR open, on ready-for-review,
   or on `@codex review`, and posts a summary comment naming the commit. Since 20 Oct 2026 it has
   repeatedly reported "usage limits for code reviews". It is optional and secondary to CodeRabbit
   (OWN-35); a usage limit is recorded as `Codex: UNAVAILABLE — QUOTA` and, under OWN-26 and
   OWN-35, Codex quota is never a merge dependency.
9. **Merge queue.** GitHub documents merge queues for organization-owned repositories. This repository
   is owned by a user account, so a merge queue is not expected to be available (to be confirmed in
   Settings). Merges stay serial by procedure: merge, then main CI, then staging, then the next merge
   (PR 3).
10. **Alerts.** None are wired (G-26). OTP send failures (G-12), WhatsApp delivery failures (G-20),
    outbox backoff (G-18) and sweep health (G-10) are open launch gaps.

## The sequence

| PR       | Slice                                                                                                          | Status  |
| -------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| 1 (#303) | CodeRabbit configuration, pre-merge checks, request-changes workflow, PR template, this runbook, playbook gate | OPEN    |
| 2        | `rekoda-pr-quality-gate`: a deterministic GitHub Actions job that verifies the exact head from the GitHub API  | PLANNED |
| 3        | A `main` run is never cancelled (concurrency policy and guard); serial merge-to-staging stays a practice       | PR OPEN |
| 4        | Staging smoke tests, a deployment report (SHA, migrations, disk, health) and the recovery protections          | PLANNED |
| 5        | Documentation and autopilot integration: CLAUDE.md, CONTRIBUTING.md, readiness, handoff                        | PLANNED |

Production deployment is not part of any slice. It needs the owner's explicit approval and a release
evidence report (playbook "Final go/no-go evidence").

## Branch rules (owner action, after PR 2 proves its check)

Prerequisite: a required check that has never been emitted locks every merge. Do not start these steps
until every check named in step 6 has run green on at least one PR and on one `main` push.

1. Open Settings → Rules → Rulesets → New ruleset → New branch ruleset.
2. Set **Target** to the default branch (`main`) and **Enforcement** to Active. Leave the **Bypass list**
   empty. The autopilot posts as the owner's admin account, so an admin bypass would let it merge past
   required checks and unresolved conversations. Do not add one while the autopilot shares that identity;
   an emergency bypass is the owner's manual decision, never the autopilot's.
3. Turn on **Restrict deletions** and **Block force pushes**.
4. Turn on **Require a pull request before merging**, with required approvals 1, "Dismiss stale
   approvals when new commits are pushed" on, and "Require approval of the most recent reviewable push"
   on.
5. Turn on **Require conversation resolution before merging**.
6. Turn on **Require status checks to pass** with "Require branches to be up to date" on. Add the CI job
   names exactly as GitHub shows them: `Secret scan (gitleaks)`, `Typecheck · lint · test · build`,
   `Deployment (Docker)`, `Migrations (foreign owner)`, `Integration (PostgreSQL)`,
   `End-to-end (Playwright)`, and `rekoda-pr-quality-gate` once PR 2 has proven it. Do not add the
   CodeRabbit or Codex check: an unavailable bot must not lock merges; the playbook escalates instead.
7. Save the ruleset, then confirm on the next PR that the merge box lists every check in step 6.

Decide who approves before step 4. GitHub never lets a PR's author approve it, and the autopilot opens
every PR as the owner's account, so the owner cannot supply the required approval on those PRs. With one
required approval, step 4 needs a second eligible reviewer (a collaborator with write access) to approve
each PR. Without one, the rule blocks every autopilot merge: it does not turn the owner's review into the
gate. Either name that reviewer before enabling step 4, or set required approvals to 0 and keep step 5
and step 6, which do not depend on a second person. Either choice changes the OWN-26 autonomous merge flow,
and the choice is the owner's. Whether a GitHub App's approval (CodeRabbit)
satisfies a required-approvals rule is not established here, and Rekoda never relies on it.
