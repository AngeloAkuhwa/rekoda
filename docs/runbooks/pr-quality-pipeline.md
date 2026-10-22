# PR quality and release safety pipeline

Status: IN PROGRESS. PR 1 of the sequence below (#303) adds this runbook. Later PRs update it as each
slice lands. It describes what is enforced today and what is not; it never claims a control that is
only planned.

## The signals, and what each one means

Six different things. None of them stands in for another.

| Signal                           | Who produces it                             | What it proves                                                                                                          | What it does NOT prove                                           |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| CodeRabbit review approval       | `coderabbitai[bot]` (`.coderabbit.yaml`)    | Its latest review covers the PR head, its required threads are resolved, and no pre-merge check it evaluates is failing | CI success, a human approval, an owner ruling, staging behaviour |
| Codex findings                   | `chatgpt-codex-connector[bot]`              | An independent model reviewed a named commit; its findings are claims to verify                                         | Anything when it reports a usage limit (that is no review)       |
| CI success                       | GitHub Actions `CI` on the exact SHA        | The repository's tests, typecheck, lint, migrations, Docker smoke, Playwright and secret scan passed on that commit     | That the change is correct where no test looks                   |
| Merge eligibility                | The playbook gate (OWN-26), later a ruleset | Exact-head CI green, 0 unresolved threads, reviews complete on the head, required approvals present, no conflict        | That it runs correctly on staging                                |
| Staging acceptance               | The owner, with physical evidence           | The behaviour works on the staging host with real channels                                                              | Production readiness, live provider behaviour                    |
| Production release authorization | The owner, explicitly, per release          | The owner accepts the release evidence report                                                                           | Nothing is deployed to production automatically, ever            |

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

3. **CI concurrency.** `group: ci-${{ github.ref }}` with `cancel-in-progress: true` applies to pushes
   to `main` too. Two merges in quick succession cancel the first commit's `main` run. That commit then
   never gets the successful push run that `deploy-staging.yml` requires. Staging still converges on the
   newer commit, but the cancelled commit has no CI provenance of its own, and a failure on the newer
   run blocks staging entirely. Gap: PR CI and `main` release validation share one cancellation policy
   (PR 3).
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
7. **CodeRabbit** is installed and active. It reviews every PR, and its run shows the configuration
   source and profile. `.coderabbit.yaml` (this PR) moves it to the repository configuration, the
   assertive profile, the request-changes workflow and pre-merge checks. Its checks are evaluated by
   a model, so they are review signals, not a deterministic gate.
8. **Codex** is installed (`chatgpt-codex-connector[bot]`). It reviews on PR open, on ready-for-review,
   or on `@codex review`, and posts a summary comment naming the commit. Since 20 Oct 2026 it has
   repeatedly reported "usage limits for code reviews". OWN-26 makes Codex quota never a merge
   dependency.
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
| 3        | Separate PR CI from `main` release validation, so a `main` run is never cancelled; serial merge-to-staging     | PLANNED |
| 4        | Staging smoke tests, a deployment report (SHA, migrations, disk, health) and the recovery protections          | PLANNED |
| 5        | Documentation and autopilot integration: CLAUDE.md, readiness, handoff                                         | PLANNED |

Production deployment is not part of any slice. It needs the owner's explicit approval and a release
evidence report (playbook "Final go/no-go evidence").

## Branch rules (owner action, after PR 2 proves its check)

A required check that has never been emitted locks every merge, so turn these on only after the named
checks have run green on at least one PR and one `main` push. Settings → Rules → Rulesets → New branch
ruleset:

- **Target:** the default branch (`main`). **Enforcement:** Active. **Bypass list:** empty. If an
  emergency bypass is wanted, add only the repository admin role, "for pull requests only".
- **Restrict deletions:** on. **Block force pushes:** on.
- **Require a pull request before merging:** on.
  - Required approvals: 1.
  - Dismiss stale approvals when new commits are pushed: on.
  - Require approval of the most recent reviewable push: on.
  - Require conversation resolution before merging: on.
- **Require status checks to pass:** on, with "Require branches to be up to date" on. The checks are
  the CI job names exactly as GitHub shows them: `Secret scan (gitleaks)`,
  `Typecheck · lint · test · build`, `Deployment (Docker)`, `Migrations (foreign owner)`,
  `Integration (PostgreSQL)`, `End-to-end (Playwright)`, plus `rekoda-pr-quality-gate` once PR 2 has
  proven it.
- Do not require the CodeRabbit or Codex check. An unavailable bot must not lock merges; the playbook
  escalates instead.

A required approval from someone other than the PR author is a human gate. The autopilot posts as the
owner's account, so with one required approval GitHub will not let the author approve their own PR.
That makes the owner's review of each closeout PR a real gate, and it changes the OWN-26 autonomous
merge flow. That trade-off is the owner's to choose. Whether a GitHub App's approval (CodeRabbit)
satisfies a required-approvals rule is not established here, and Rekoda never relies on it.
