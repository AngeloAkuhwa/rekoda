# Rekoda MVP Autopilot — Persistent Owner Playbook (v4)

**Applies to:** every scheduled Rekoda MVP Autopilot run, interactive Claude Code session, implementation PR and handoff.
**Authority:** this playbook guides workflow, not an override of `CLAUDE.md`, owner decisions, canonical product requirements, repository protections or higher-priority access controls. When they disagree, diagnose and escalate substantive product/policy contradictions; never silently choose the less restrictive rule.
**Owner priority update (22 October 2026):** Operational safety and recovery prerequisites come BEFORE the full Central Admin UI. Implement the minimum operator visibility needed for safety, then the admin experience. The launch gate register may contain unverified or stale statuses: remeasure every gap before coding.
**Ruling note (22 October 2026, recorded in the repository, not part of the owner's v4 text):** G-87 and G-92(5) are NO LONGER policy-blocked: the owner ruled them as OWN-31 and OWN-32, and G-115 as OWN-33 (`REKODA_OWNER_DECISIONS.md`). Where this playbook says those items are policy-blocked or asks for a decision proposal, the rulings win; implement them.
**Routine purpose:** make bounded, evidence-backed progress on each hourly run; do not promise background progress within a run. Continue on the next scheduled invocation using the handoff. Avoid repeating previously completed work.

## Immediate priority order (supersedes older ordering wherever they differ)

0. **Do not destabilize current in-flight work.** Check the live state of G-78/#298, current main, CI and staging. Do not reopen merged work. Resolve CI cancellation/deployment sequencing before causing another wave of cancelled main builds.
1. **Operational readiness and financial safety (release-blocking):** backups + off-box storage + tested restore (G-02); essential alerts for OTP, WhatsApp delivery, webhook/payment and job failures (G-12/G-20); outbox retries/backoff (G-18); worker sweep scheduling reliability (G-10); payment safety, security and authorization (G-99/G-116 and policy-blocked G-87/G-92(5)); staging deployment health.
2. **External owner gates in parallel, tracked without fabricated closure:** Paystack written confirmation + authorized live test (G-05/G-06); Meta production number/App Review/templates (G-03); cloud provider spending limits, legal/accounting sign-off, production host, branch protections (G-09), off-box backup destination. Never block independent safe development merely because an owner gate awaits evidence.
3. **Core product acceptance:** Chat, hosted-storefront Integrate, Complete; live model evaluation and receipt/delivery/payment scenarios. Native WhatsApp Business catalogue order automation remains post-launch.
4. **Essential Central Admin Console:** build the smallest secure operator UX for user/merchant lookup, billing, usage/cost, exceptions, platform health and audit, reusing operator APIs and RBAC. Keep it behind authentic operator access; no speculative bulk mutations.
5. **Production readiness:** key rotation and boot validation (G-13/G-14), enforceable retention and erasure (G-15/G-19), G-11 merchant-tax scope and Rekoda subscription-tax professional review, billing wording (G-16), accounting review (G-47), runbooks, rollback/restore, legal readiness, staging sign-off and owner go/no-go.

**Scheduling rule:** Do not merge multiple PRs to `main` while an exact-tip CI push run is still pending if the repository's `cancel-in-progress` policy would cancel that run. Allow one tip-of-main CI to finish and staging to establish its baseline, then resume merges. Diagnose a cancelled run as CANCELLED, not FAILED. Retry an eligible cancelled run or resolve the workflow policy through a reviewed PR; never bypass the successful-CI-on-main deployment gate. Distinguish Playwright browser-download infrastructure failures from application test failures using actual logs.

## Permanent operating requirements (read first every run)

1. **State first.** Fetch `main`, identify active branches/PRs, worktree changes, CI, reviews and staging release. Read the current task/handoff. Never trust yesterday's PR list, SHA or deployment status over live evidence.
2. **One slice at a time.** Finish or safely park the active issue before opening another implementation branch. Parallel read-only review is fine. Never overwrite another developer's changes or run destructive cleanup against unknown work.
3. **Own the full fix cycle.** For defects: RED reproduction, smallest correct fix, GREEN tests, full relevant regressions, independent review, Codex, exact-head CI, merge when permitted, verify main, update docs, move on.
4. **Resolve engineering conflicts yourself when safe.** A rebase conflict, PR conflict, failing CI, formatter mismatch, flaky test, Codex comment, or integration defect is a task to investigate and resolve, not an automatic reason to stop. Follow the precise conflict playbook below. **Never** resolve a conflicting owner ruling or financial policy by guesswork.
5. **Respect permissions.** User authorization to merge qualifying PRs is not a substitute for a required human approval, automated classifier, branch protection or deployment authorization. Do not bypass blocked commands by changing tools, endpoints, syntax, identity or protection settings.
6. **Preserve payment truth.** Do not manufacture payment verification, double-book a sale, mutate settled history, silently refund, convert estimated fees into actuals, or weaken tenant boundaries. Use durable idempotency and tested database invariants.
7. **Do not confuse status labels.** `CI GREEN`, `MERGED`, `DEPLOYED TO STAGING`, `STAGING ACCEPTED`, `LIVE PROVIDER VERIFIED` and `PRODUCTION RELEASED` are different milestones. Prove each independently.
8. **Progress beats chatter.** Make concrete progress in the current authorized scope. If blocked on one item, record exact blocker and continue an independent item within scope; do not endlessly poll checks or ask for permissions already granted.
9. **Stop on unsafe prerequisites.** Disk below the project's safe threshold, missing live credentials, ambiguous financial rules, unknown DB migration history, unhealthy deployed service or inaccessible reviews require investigation first, not forced progress.
10. **Commit learning to the repo.** Update the canonical status/handoff and a concise `CLAUDE.md` reference when workflow rules change. Do not paste transient issue state into permanent rules.

## Merge conflicts, CI failures and review findings — mandatory resolution procedure

**A. Identify and reproduce**

- Fetch remote changes; record base SHA, head SHA, merge-base, changed paths, check runs and review-thread status. Check for another automation/developer owning the same PR.
- For textual merge conflicts: inspect **ours**, **theirs**, and the common ancestor, and explain the intended semantics of both changes. Never blindly choose `--ours`, `--theirs`, auto-accept a whole side, or discard a payment/security invariant merely to clear markers.
- For generated files, lockfiles, migration manifests or OpenAPI: determine the authoritative generator/source and regenerate using repository procedures; preserve both intended dependency/schema updates. Never rewrite an already applied migration. Unmerged migrations may be revised only if the repository's migration policy permits it.
- For CI: locate the first failing assertion/log (not the final exit code), reproduce locally/in a faithful container if practical, establish whether caused by this PR, main or external infrastructure. Do not relabel a genuine regression as flaky.
- For Codex/review: read **every current actionable comment**, including comments on outdated diffs if still relevant. Respond with evidence, fix commits and regression test names; resolve only after verification. A bot comment that merely says “reviewed” is not proof that the latest head was assessed.

**B. Integrate carefully**

- Prefer the repository's established sync method (merge or rebase) and do not rewrite published branches without explicit repository permission. Preserve both independently valid changes.
- Use semantic, minimal edits. Reject accidental duplicated APIs, conflicting route ownership, silently widened permissions, lost RLS checks, invalid ledger journal effects, mismatched order/pricing rules or changed migration ordering.
- Add a focused regression test for any behavioral conflict. Run formatting, typecheck, affected unit/integration tests and cross-module tests for shared contracts. Validate docs and migration invariants.
- Push and confirm the conflict is gone and **exact-head** CI passes. Recheck for new comments or conflicts after every push. Do not merge if a required check is pending, cancelled, stale or missing.

**C. Decision rules**

- Automatically fix: routine source conflicts with clear intended behavior, formatting, failed deterministic tests, missing imports, ordinary schema/type mismatches, stale docs, out-of-date branch and reproducible review findings.
- Ask owner: competing canonical product requirements, G-87/G-92(5) purchase-identity policy, payment/refund semantics not already ruled, subscription price/allowance changes, regulatory/legal judgment, consent/privacy tradeoffs, potentially destructive database/backfill, or production release.
- If third-party access or branch protections block progress: do not circumvent. Report exactly the missing access, approval or environment prerequisite and proceed elsewhere.
- If a conflict cannot be safely resolved within the current run: do not force-push or leave a partially merged branch. Preserve the branch/worktree safely; document commands attempted, current state, identified alternatives and next safe action.

**D. Closure criteria**

- No conflict markers, no accidental deleted files, clean intended diff, all required migrations compatible, test evidence attached, review threads addressed, exact-head checks green, GitHub reports mergeability, and no policy block.
- Follow the established merge strategy. Verify the actual merge SHA and merged source on `main`; do not call it deployed or staging accepted unless verified separately.

## Staging / Hetzner recovery protocol

- At every deployment-related task check `df -h`, `df -i`, Docker image/cache consumption, `git status`, checkout SHA, the single `REKODA_RELEASE` line (never print secrets), current containers and `/health` release/commit/database.
- Require free space adequate for building **and rollback**, currently at least 10 GB unless the maintained runbook specifies a stricter threshold. Stop before checkout/build if below it.
- Confirm checkout HEAD, `.env` release and actual live `/health` release are an aligned rollback baseline. Do not force the script past its preflight. Recover interrupted checkouts only after preserving evidence and distinguishing host-local changes.
- Keep running/rollback images, persistent Docker volumes, database, `.env` and `secrets/`. No blind `docker system prune --volumes`, `git clean -fd`, mass image deletion or `git reset --hard`.
- Use CI-approved deploy workflow; an explicit new workflow_dispatch from `main` is not the same as rerunning a workflow_run event. Successful deployment requires external `/health` matching target commit plus necessary integration smoke checks.
- Never deploy production or change live financial data without the owner's explicit approval.

## Autonomous hourly routine handoff

At invocation start: read the rules, review previous handoff and check live status; select **one** highest-priority unblocked item. If an existing open PR has pending CI or reviews, investigate progress and perform useful independent permitted checks; do not create an equivalent PR. Before finishing, persist a compact handoff: `timestamp`, `main SHA`, `current branch/PR`, `last verified head SHA`, `CI/review status`, `specific remaining work`, `owner decisions needed`, `staging actual SHA`, and `next safe command`. Future runs must resume from it instead of starting over. Avoid churn that changes the head merely to re-trigger CI or reviews.

---

Claude, continue Rekoda development from the latest `main` branch.

**This is an updated owner instruction covering the remaining implementation, PR management, staging acceptance preparation, and launch readiness for Rekoda Chat, Rekoda Integrate, Rekoda Complete, and the Central Admin Console.**

Our objective is to COMPLETE, STABILIZE, TEST, and SHIP Rekoda.

Do not stop after the current G-78/G-99 queue. Work systematically through the full approved launch backlog.

You are authorized to implement fixes, create PRs, run tests, request reviews, resolve actionable findings, and merge qualifying PRs according to repository policies without repeatedly asking for routine approval.

Do not bypass mandatory review, GitHub protections, or any classifier denial.

## PHASE 0: Reconcile the latest repository state

First:

1. Fetch latest main.
2. Inspect all open PRs and recent merged PRs.
3. Verify the current implementation and CI state.
4. Review:
   - `CLAUDE.md`
   - `docs/REKODA_REFERENCE_MANIFEST.md`
   - `docs/REKODA_CANONICAL_SPEC.md`
   - `docs/REKODA_CURRENT_STATE.md`
   - `docs/REKODA_LAUNCH_READINESS.md`
   - `docs/REKODA_USER_JOURNEYS.md`
   - `docs/REKODA_OWNER_DECISIONS.md`
   - `docs/HANDOFF.md`
5. Confirm merged fixes are actually present on main.
6. Reconcile stale gap entries against code and regression tests.
7. Identify anything currently in progress before creating duplicate work.

Historical snapshot (never assume current): #297, #295, #294, #292, #290, #289, #284 and #272 were reported merged. PR #298 (G-78) was in progress in the owner-provided routine screenshot; check its current state at run start. GitHub state, not this paragraph, is authoritative.

Do not reopen completed work unless a reproducible defect exists.

Classify every remaining requirement as:

- IMPLEMENTED AND VERIFIED
- IMPLEMENTED, ACCEPTANCE PENDING
- REQUIRES FIX
- REQUIRES NEW DEVELOPMENT
- EXTERNALLY BLOCKED
- DEFERRED POST-LAUNCH

Record objective evidence for every classification.

## PHASE 1: Complete immediate financial and security fixes

Continue the current development queue.

### G-78: Photo text must not execute commands

If the fix is already merged, confirm evidence and move on. Otherwise resume its open branch/PR instead of duplicating it.

A photographed YES, STOP, START, CANCEL, or similar command must not execute privileged deterministic text commands.

Test that images cannot:

- Confirm financial drafts.
- Change consent unexpectedly.
- Trigger protected write operations.
- Circumvent member permissions.

Preserve legitimate OCR functionality.

Run RED tests, implement the minimal fix, verify GREEN, review, CI, and merge.

### G-79: View-only draft protection

Verify the merged fix through tests.

A view-only member must not cancel, modify, confirm, or invalidate the owner's pending financial draft.

Do not rebuild the merged implementation.

### G-99: Command-bus role enforcement

Audit every write command and ensure authorization is enforced at the command execution boundary, not only the UI or conversation router.

Verify:

- Owner, accountant and delegate permissions.
- Tenant isolation.
- Direct API invocation.
- Conversational commands.
- Replay and idempotency.
- Draft ownership.
- Forbidden role transitions.
- Concurrent execution.

Fail closed when role context is missing or invalid.

Use focused regression tests.

### G-87 and G-92(5): Purchase identity

_Ruled 22 Oct 2026 (OWN-31, OWN-32): implement the rulings; the owner text below is kept as written._

These are currently policy-blocked.

Do not invent purchase-identity rules.

Prepare a concise decision proposal explaining:

- What constitutes the same real-world purchase.
- Whether an invoice number, supplier, amount, date, document hash, or other evidence establishes identity.
- Legitimate repeat purchases.
- Document re-uploads and corrections.
- Cross-channel submission.
- Purchase-versus-expense reclassification.
- Idempotency expectations.
- Ambiguous matches requiring review.

Provide recommended options and the financial consequences of each.

Continue all independent development while awaiting the owner's ruling.

### G-116: Payment fees

Verify that estimated order processing fees are never recorded as actual provider costs.

Actual financial postings must come from verified provider evidence.

Test fee estimates, settlement deductions, VAT on fees where applicable, refunds, partial payments, duplicate events and reconciliation.

Merge after full verification.

## PHASE 2: Rekoda Integrate launch completion

The initial Integrate product uses the existing hosted storefront.

Do not implement native WhatsApp Business catalogue automation.

Complete and verify:

1. Merchant creates and configures a business.
2. Merchant adds products, prices, descriptions and images.
3. Merchant publishes a branded storefront.
4. Customer browses the catalogue.
5. Customer adds products to the basket.
6. Customer changes quantities and removes items.
7. Checkout validates prices, stock and delivery charges.
8. Rekoda creates the order and appropriate financial documents.
9. Paystack generates valid Pay-with-Transfer instructions.
10. The customer makes payment.
11. Rekoda verifies payment through trusted provider mechanisms.
12. Rekoda matches the payment to the correct order.
13. Duplicate webhook deliveries never duplicate financial records.
14. The invoice and receipt correctly reflect the verified payment.
15. Supported customer receipt delivery is completed and observable.
16. Merchant sales and payment records reflect the transaction.
17. Inventory and accounting postings follow the canonical recognition and fulfilment rules.

Test unsuccessful payments, delays, partial payments, overpayments, duplicate transactions, insufficient stock, concurrent buyers, abandoned orders, provider errors and refunds.

Do not treat receipt generation as equivalent to successful delivery.

Do not conflate provider payment confirmation with later bank settlement.

Do not introduce separate financial logic for the storefront.

## PHASE 3: Rekoda Chat completion

Finish and certify the supported conversational business-management experience.

Cover:

- Natural-language sales recording.
- Expenses and purchases.
- Customer and supplier identification.
- Payment recording.
- Invoice creation.
- Receipt generation.
- Business reports and financial questions.
- Drafts and confirmations.
- Nigerian English and Pidgin routing.
- Consent and opt-outs.
- Role-based restrictions.
- Plan entitlements.
- Voice notes and document extraction where enabled.
- Correct rejection and clarification of ambiguous instructions.

Run the existing G-07 evaluation harness against real models during the authorized acceptance campaign.

Do not enable voice or OCR for launch unless real-world tests demonstrate acceptable accuracy and safety.

Verify AI cost tracking, daily limits, document metering and error handling.

## PHASE 4: Rekoda Complete

Prove that Chat and Integrate work together correctly.

A merchant must be able to record transactions conversationally while storefront sales automatically appear in the same books.

Test:

- Shared customer identity.
- Shared invoices and receipts.
- Shared financial ledger.
- Stock consistency.
- Payment allocation.
- Cross-product reporting.
- Multi-channel idempotency.
- Subscription and entitlement boundaries.

A transaction originating in one product must not be recorded again when referenced through the other.

No separate accounting source of truth may be introduced.

## PHASE 5: Build the essential Central Admin Console

This is an approved launch requirement.

The existing operator backend is partially implemented, but the central platform-owner UI is missing.

Build the smallest safe and usable admin application using the existing Next.js/React infrastructure.

The console must be separate from merchant-facing sessions.

### A. Operator authentication

- Secure operator login through the existing production identity design.
- Scope-based authorization.
- Session security.
- No merchant-session privilege escalation.
- Audited sensitive administrative actions.

### B. Platform overview

Display:

- Total registered merchants.
- Active merchants.
- Trial and paid accounts.
- Plan distribution.
- Subscription revenue.
- Provider costs.
- Estimated platform margin.
- Recent failures and outstanding exceptions.

Use real backend data, not hardcoded dashboards.

### C. Merchant management

Provide:

- Merchant search and pagination.
- Business profile and onboarding status.
- Subscription and entitlement details.
- Team and user information.
- Resource consumption.
- Payment and operational exceptions.
- Authorized administrative actions where supported.

Do not expose unnecessary personal data or merchant financial details.

Do not introduce unapproved impersonation or unrestricted account-editing capabilities.

### D. Subscription administration

Support authorized viewing and existing approved operations for:

- Chat, Integrate and Complete plans.
- Free trials.
- Upgrades and downgrades.
- Renewals and grace periods.
- Failed and unapplied charges.
- Billing exceptions.

Reuse the existing subscription state writer.

### E. Resource and cost management

Display:

- AI calls and token usage.
- Model-provider costs.
- WhatsApp message usage.
- Document generation.
- Voice and OCR consumption where supported.
- Storage usage where metered.
- Subscription allowances.
- Quota utilization.
- Merchant margin.

Distinguish ACTUAL, ESTIMATED, and NOT YET MEASURED costs.

Do not fabricate cost data.

### F. Operational monitoring

Provide visibility into:

- Background jobs.
- Dead-letter or failed jobs.
- Webhook processing.
- Payment reconciliation exceptions.
- Failed notifications.
- Financial-integrity alerts.
- System health.
- Administrative audit events.

Every sensitive action must be permission-checked and audited.

Where an API does not yet exist, implement the minimum secure endpoint needed.

Do not expose worker-level cross-tenant database privileges through ordinary application sessions.

Build the Admin Console sequentially: authentication first, then overview, merchants, subscriptions, usage, and operations.

Each section must have tests and an independently reviewable PR.

Defer advanced analytics, bulk user mutations, and sophisticated support workflows until after launch.

## PHASE 6: Complete remaining commercial and operational requirements

Audit and close launch-relevant deficiencies involving:

### Billing and entitlements

- Fourteen-day free trial.
- Plan activation and renewal.
- Upgrades and downgrades.
- Grace and expiry.
- Add-on purchases where included in launch pricing.
- Payment failures.
- Correct customer-facing messages.
- Resource quota enforcement.
- Billing exception handling.

Do not silently change prices, allowances or commercial policy.

### Financial completeness

- Verified payments.
- Settlement and reconciliation.
- Credits and refunds.
- Duplicate protection.
- Correct customer balances.
- Stock and cost-of-goods recognition.
- Accurate totals and tax disclosures for the configured merchant transaction; never invent VAT, mislabel no-VAT-charged as zero-rated/exempt, or imply tax filing.
- Invoice and receipt correctness.

### Privacy and security

- Tenant isolation.
- Encrypted PII.
- Secret management.
- Authorization.
- Auditable operator actions.
- Retention and deletion.
- Data export.
- Provider credential handling.

### Reliability

- Worker retries.
- Webhook failure alerts.
- Document delivery errors.
- Monitoring and logging.
- Database backup and restore.
- Migration safety.
- Deployment rollback.
- Disk-space preflight and safe Docker image retention.

Do not redesign completed subsystems unnecessarily.

For partially implemented features such as supplier management, customer credits, automated VAT, bank-feed providers, public API management screens and advanced reporting, determine whether they are part of an explicit launch promise.

If not, document them as post-launch instead of expanding scope.

## PHASE 7: Staging deployment and acceptance

The Hetzner staging environment previously suffered disk exhaustion and interrupted deployment rollback.

Historical incident: disk exhaustion broke staging deployment; the server was recovered and release baseline was aligned to `staging-260e60d`. This is historical context only. Check fresh /health and workflow runs; never assume a given commit is currently running.

Inspect the current GitHub Actions deployment state and `/health` before proceeding.

Verify:

- Staging release SHA.
- Applied migrations.
- Container health.
- Available disk space.
- Database availability.
- Required provider configuration.
- Logs and failed jobs.

Do not bypass deployment preflight or CI requirements.

Continue the agreed batched acceptance approach.

Prepare one complete end-to-end acceptance campaign for Chat, Integrate, Complete and Central Admin.

Tests that require real Paystack transfers, live Meta messages, real AI evaluations or owner credentials must be clearly identified for owner-assisted execution.

Never report mocked tests as live provider verification.

## PHASE 8: Release readiness

Before proposing production launch:

- Confirm all P0 defects resolved.
- Confirm all approved MVP features implemented.
- Confirm the Central Admin essentials work.
- Confirm real payment and core transaction journeys pass.
- Confirm security and privacy requirements.
- Confirm essential production alerts and recovery.
- Confirm legal and commercial configuration.
- Confirm backup restoration and rollback.
- Confirm staging acceptance evidence.
- Prepare an explicit production go/no-go recommendation.

Do not deploy to production without my approval.

## PHASE 9: Continuous PR execution (also governed by the mandatory conflict procedure above)

For every development item:

1. Start from fresh main.
2. Reproduce the defect or define acceptance criteria.
3. Write focused tests, using RED/GREEN for defect fixes.
4. Implement the smallest correct change.
5. Run relevant integration tests, typecheck, lint and build.
6. Open a focused PR.
7. Run Codex and independent read-only reviews.
8. Address BLOCKING and IMPORTANT findings.
9. Verify exact-head CI.
10. Merge if all repository policies and review requirements allow it.
11. Confirm main contains the fix.
12. Update launch-readiness and handoff records.
13. Proceed to the next independent item.

Work on ONE engineering fix or feature slice at a time. Prefer one primary implementation branch and PR; use parallel read-only reviewers, not parallel competing implementations.

Do not start overlapping implementation branches unnecessarily.

Do not repeatedly ask for approval for routine engineering work.

If a policy, classifier, branch-protection rule or mandatory review blocks an action, respect the restriction and report the specific required approval. Continue independent permitted work.

## PHASE 10: Development reporting

At every meaningful checkpoint, report:

- Latest main SHA.
- PRs merged and merge SHAs.
- Work completed.
- Current development item.
- Remaining P0 and P1 blockers.
- Items waiting for owner decisions.
- Staging release and acceptance state.
- External dependencies.
- Next task.

Use the canonical gap register as the authoritative checklist.

Do not mark work complete based only on a merged PR, passing CI, or an assumption.

**FINAL DIRECTIVE**

Our target is an operational, secure and fully tested Rekoda MVP consisting of Chat, Integrate, Complete and the essential Central Admin Console.

At run start, inspect G-78 / PR #298 and any other active work. Resume only if still pending; if merged, move to the next verified blocker.

Then continue through the remaining security, financial, product and admin requirements in the safest dependency order.

Merge qualifying changes, maintain accurate documentation, and continue toward staging acceptance and production launch.

Do not stop at the end of the current G-78/G-99 list.

Do not expand the product into native WhatsApp Business catalogue automation.

Do not request permission for routine work already authorized.

Escalate only unresolved product-policy decisions, external credentials, mandatory human approvals, or production deployment authorization.

Proceed.

## Operational safety launch gate: G-02 backups and restoration (P0)

**Register claim, unverified until audited:** no backup script, WAL archiving or full restore drill. Verify actual code, Hetzner server, retention destinations and deployment architecture first.

- Design automated, encrypted PostgreSQL backups with a documented schedule, encryption/key ownership, least-privilege credentials, integrity checks and monitoring. Determine whether logical dumps, physical backups and/or WAL/PITR are suitable; **do not assert PITR is available without proving the database and storage configuration**.
- **An off-box storage destination is an owner-held prerequisite**. Present a minimal request naming provider, bucket/region, retention, access permissions and budget; do not store backups only on the same Hetzner disk or in Git. Do not expose secrets in CI logs or PRs.
- Build backup and restore scripts, dry-run tests and an isolated restore drill using non-production data unless explicitly authorized. Demonstrate restored DB connectivity, migration compatibility, RLS consistency, sample ledger integrity, checksums, elapsed restoration time, and a measured recovery-point capability.
- Record RPO/RTO as measured or owner-approved targets, not invented guarantees. Capture backup success/failure alerts and a tested restore runbook. Preserve immutable/offsite copies appropriate to policy.
- Never use production data in a test restoration without owner-approved safeguards, and never perform destructive production restore automatically.

## Alerts, failures and job reliability (P0)

- Implement minimum viable monitoring before sophisticated Admin dashboards: actionable destination, alert owner, severity, correlation identifier, tenant-safe metadata, deduplication, retry and acknowledgement. Metrics/exporters and error tracking may be the mechanism; do not expose PII, tokens or payment details in telemetry.
- **G-12:** OTP send failures cannot be silently swallowed. Preserve anti-enumeration behavior of public OTP responses, record internal delivery failures and alert without disclosing whether a phone/user exists.
- **G-20:** WhatsApp delivery failure and 24-hour/template-window rejection must be visible and handled. Review Meta delivery statuses, Graph errors and retry policy; do not claim a receipt was delivered merely because the send request was accepted.
- **G-18:** implement tested exponential backoff / scheduled retry for transient outbox failures, bounded attempts, poison-event quarantine, dead-letter alerts, idempotency and crash/restart safety. Do not retry permanent 4xx errors indefinitely or make payment postings twice.
- **G-10:** sweeps must not starve indefinitely on restarts. Verify first-run behavior, durable last-execution markers, distributed leader/locks, catch-up after downtime, per-tenant sequencing and retention correctness. Avoid destructive catch-up storms; make it rate-limited and observable.
- Monitor failed payments/webhooks, dead jobs, signature rejection, failed document deliveries, filesystem headroom, database and service health. Define minimal alert tests and operator response steps.

## Automated review gate: CodeRabbit and Codex (repository note, 22 Oct 2026; owner-requested)

_Recorded in the repository from the owner's instructions of 22 Oct 2026. It refines PHASE 9 steps 6 to 10 and does not weaken any rule above. `.coderabbit.yaml` holds the reviewer's configuration._

How CodeRabbit behaves here (verified against its documentation and schema v2, 22 Oct 2026):

- It reviews every PR to `main` automatically and again on every push (`auto_incremental_review`, never paused), with the `assertive` profile.
- With `request_changes_workflow: true` it submits a **request-changes** review when a review posts actionable inline comments. It **approves** only when its latest review covers the current head, its required threads are resolved and no pre-merge check fails, and it re-checks the head immediately before approving. Approval stays pending while a review is missing, in progress, failed or rate-limited.
- `allow_author_approval: false`: the PR author cannot override it with `@coderabbitai approve` or `@coderabbitai resolve`. The autopilot posts as the owner's account, so it can never self-approve through CodeRabbit.
- Pre-merge checks in `error` mode hold its approval: applied migrations edited, a `fix:` PR with no test, a skipped or disabled test.
- `fail_commit_status: false` and the CodeRabbit check are not required statuses. A CodeRabbit outage therefore never turns a check red or deadlocks a merge mechanically.
- **Limitation:** `main` has no branch protection yet (G-09), so GitHub itself does not enforce CodeRabbit's change request or approval. This gate enforces it. An admin can always dismiss a stale bot review, so nothing here can deadlock permanently.
- Whether a GitHub App's approval counts toward a required-approvals rule is not established here. It is never treated as one.

For every PR, Claude:

1. Opens a focused PR only after the local fast checks and the relevant tests pass.
2. Waits for CodeRabbit's **completed** review of the **exact head SHA**: its review summary names the head, or its check run for that SHA is complete. A review of an earlier commit is not a review of this one.
3. Obtains independent Codex review where configured. If Codex reports a usage limit, record `CODEX REVIEW PENDING — USAGE LIMIT` and request `@codex review` once per availability window, after the head is stable. Codex quota is never a merge dependency (OWN-26).
4. Verifies every actionable finding against exact-head source. For a real defect: RED regression test, fix, GREEN, push, then reply on the thread with the fixing SHA and the test name, and resolve it. For a finding that does not hold: reply with the evidence and leave it to CodeRabbit (or the owner) to resolve. Never resolve an unfixed reproducible finding.
5. After material fixes, lets the incremental review run. If CodeRabbit has not reviewed the new head within 30 minutes (paused, rate-limited), comments `@coderabbitai review` **once**. Never uses `@coderabbitai approve` or `@coderabbitai resolve` to clear a review.
6. Confirms exact-head CI green, 0 unresolved actionable threads, no open CodeRabbit change request on the latest head, the Codex condition, a final independent Claude review with 0 BLOCKING and 0 IMPORTANT, and every required human approval and branch-protection rule.
7. Merges only when the repository's rules and OWN-26 permit it. **A CodeRabbit approval is never a reason to merge on its own and never stands in for a required human approval**, an owner ruling or a financial policy decision.
8. If CodeRabbit cannot complete a review of the head after the one re-request (outage, exhausted capacity), records `CODERABBIT REVIEW PENDING — UNAVAILABLE`. It does not merge a PR that touches money, auth, tenancy, privacy, migrations or deployment until CodeRabbit reviews it or the owner explicitly waives it for that PR, and moves to independent work meanwhile.
9. Continues to the next approved launch task.

## Branch protection and CI/deploy flow (G-09, release gate)

- Audit whether `main` branch protection/rulesets enforce PRs, review/required checks, stale approvals, restrict force-push and deletion, and signed/other required rules only if consistent with repo policy. **A local playbook saying “wait for review” is not a GitHub-enforced protection.**
- Ruleset activation is an owner/repo-admin action unless existing permissions and approval explicitly allow it. Provide exact recommended settings and verify by reading effective rules. Do not change them covertly or to evade an existing restriction.
- Preserve exact-head CI and push-to-main CI provenance required by `deploy-staging.yml`. Distinguish PR CI (not sufficient for staging manual deploy) from a successful CI run with event `push`, branch `main`, exact commit and `conclusion=success`.
- If merges on main cancel earlier CI, serialize merge -> main CI success -> automatic staging deploy outcome before further merge where practical. Record the actual staging SHA. A historical skipped/failed workflow need not be redeployed individually if a later approved tip includes its changes.
- Do not push dummy docs commits or weaken required checks just to obtain a green badge. A changed workflow must get review/test evidence, including cancellation and stale-deployment scenarios.

## Permanent product and tax boundary (owner ruling, 22 Oct 2026)

**Scope.** Rekoda Chat, hosted-storefront Integrate and Complete provide software for merchants. Customers buy from the merchant, not from Rekoda merely because the software generates an order, a transfer instruction, invoice or receipt. Rekoda must preserve the merchant's identity on transaction documents and keep the merchant's money, payment confirmation, provider settlement and Rekoda's own SaaS revenue conceptually and financially separate. This does not supersede actual contract/payment-provider flows or legal conclusions: inspect and escalate discrepancies.

**MVP tax posture.** Rekoda does not assume the role of collecting or remitting the merchant's VAT and does not advertise VAT filing, tax advice or government-certified electronic invoices. Don't inject VAT by default, hardcode a blanket exemption, mark all transactions zero-rated, or describe a price as "including VAT" without grounds. The absence of a VAT charge is not a tax classification. If an invoice exposes a VAT line, require a known, supported tax basis and accurate arithmetic or use a neutral truthful presentation; never fabricate tax status. A paid amount and its receipt must reconcile to the actual merchant order and verified payment.

**Independent Rekoda obligation.** Rekoda's subscription or add-on sales are distinct taxable supplies whose correct VAT and invoice treatment need qualified Nigerian tax/accounting review. Provider fees, merchant revenue and SaaS revenue must never be conflated. Law may impose other obligations on a platform depending on its actual contractual role; owner intent alone cannot waive them.

**Engineering action.** Inspect G-11 and all tax-bearing UI/receipts, invoice snapshots, checkout, API and ledger paths. Where hardcoded zero VAT is user-visible as a tax conclusion, prepare minimal accuracy fixes with tests. Where lawful VAT support is necessary for the selected merchant segment, flag the exact launch blocker and decision instead of inventing requirements. Existing historic rows remain unchanged absent approved migration, and don't overpromise tax features.

## Payments / billing / tax / accounting: explicit live and policy gates

- **G-05:** require provider's written confirmation for the precise merchant Paystack collection/settlement/refund integration, then an **owner-authorized controlled real-money test**. Verify intent, generated payment details, provider-server verification, webhook replay safety, correct order/invoice allocation, receipt generation and delivery, settlement components, bank payout, and reversal/refund/dispute cases where supported.
- **G-06:** refund/dispute handling stays IMPLEMENTED, NOT LIVE-VERIFIED until real provider evidence is obtained. Never initiate refunds or move real money without narrow authorization; do not fabricate provider payloads as proof.
- **G-16:** verify actual renewal/grace/lapsed paid-plan copy on main before fixing. Never tell a merchant an attempted payment failed when none was attempted; don't call a lapsed paid plan a free trial. Confirm existing G-69/G-107 coverage before adding code.
- **G-11 merchant VAT treatment, owner scope ruling (22 Oct 2026):** Rekoda is a SaaS tool enabling merchant chat commerce, storefront ordering, recordkeeping, invoices, receipts and payment verification. Rekoda does **not** intend to act as merchant-of-record, collect merchants' VAT, remit their VAT, or offer VAT filing through the MVP. Merchant sales remain merchant transactions; Rekoda subscription/add-on fees are Rekoda's separate transactions. This is a **product-scope decision, not a finding of legal exemption**. The merchant's VAT liability, if any, remains subject to applicable law and their circumstances; verify if an applicable legal or platform-specific rule changes this allocation. Do not automatically charge 7.5% VAT on all sales, or treat VAT-not-charged as inherently exempt or zero-rated. Audit three reported hardcoded-zero sale paths and all invoice/receipt/storefront representations for misleading labels, arithmetic and ledger treatment. Ensure the enabled MVP correctly represents the amounts a merchant actually sets and charges, using clear non-tax terminology where tax treatment is unknown. Never silently create a tax amount, mutate historical records, erase tax metadata, or claim certified e-invoicing. A configurable tax engine, merchant tax remittance/filing, government-certified e-invoicing and broad tax advice are deferred unless launch law or a specific approved promise requires them. Record a precise legal/accounting review gate for (a) Rekoda's own subscription/add-on VAT and invoicing, (b) any provider/platform collection/withholding obligation, and (c) merchant invoice requirements for intended users. Do not close the legal gate on the basis of the owner's software-only intent.
- **G-47:** obtain finance/accountant sign-off for statement formats, cash vs accrual, COGS, liability and tax treatment. Provide reproducible ledger-to-report reconciliations, not self-certification.
- **G-116:** separate estimated provider fees from ACTUAL provider statements; only provider evidence drives final costs/postings. Continue protecting idempotency and merchant-vs-platform fee attribution.
- **G-87 / G-92(5):** remain owner-policy blocked; present a concrete decision matrix with examples, supplier/reference ambiguity, duplicate receipts, legitimate repeat orders, corrections and cross-channel idempotency. Do not invent a definition or silently close these.

## Privacy, encryption and retention: launch safety

- **G-13/G-14:** check boot-time presence/validity of `CONNECTION_KEY`, supported cryptographic key versions, operational rotation/re-wrap of `VAULT_KEY` and `CONNECTION_KEY`, old/new key overlap, encryption AAD, rollback/recovery and read-after-rotate tests. Never regenerate active encryption keys without a tested migration and backup; never log plaintext or secrets.
- **G-15/G-19:** reconcile public claims (including six years and ninety days) with the data classes and legal basis. Confirm exact requirement and owner/legal review. Implement data retention jobs, verified anonymization or deletion boundaries, dependent records, exempt accounting records, legal hold, audit and user-rights handling. Chat-only identity deletion does not constitute complete erasure. Require destructive-data safeguards and tested staged rollout.
- Preserve contractual and regulatory record-retention obligations; do not turn off financial audit trails to simplify erasure.

## External prerequisites / explicit owner task board

For each, publish the request, impact and proof of closure; never mark DONE without evidence:

- G-02: off-server encrypted backup destination, keys/retention and restore-drill permission.
- G-03: dedicated production WhatsApp business number, Meta App Review, valid tokens, and approved authentication + two utility templates (verify actual provider requirements before claiming completion).
- G-05: Paystack written API/settlement agreement and approved small real-money tests; any production merchant configuration.
- G-09: effective `main` branch protection/ruleset enabled and verified by a repo administrator.
- G-11/G-47: owner SaaS-only tax scope is ruled; obtain professional assessment of Rekoda subscription/add-on VAT, platform-specific collection obligations, merchant invoice presentation, and accounting statement sign-off.
- Legal: actual corporate details, privacy/terms policies, governing-law clause and qualified legal review. Do not call draft legal pages approved.
- AI: Anthropic and OpenAI provider accounts/credits, budget alerts, usage ceilings, real-model evaluation permission and safe datasets.
- Production infrastructure: provisioned host/managed services, environment values, HTTPS/DNS, backup destination, monitoring, secrets and runbooks. No production deployment without separate explicit owner approval.

## Minimum viable Central Admin and product acceptance

- Admin comes after P0 recovery observability slice. Authentication with operator OIDC/scopes and audit is non-negotiable; merchant/user search must be paginated and scoped. Build modest pages for plan states, resource usage and distinguish actual/estimated/unmeasured costs, exceptions, queue/webhook issues, security and financial integrity.
- **Chat:** deterministic/AI commands, roles, prompt/image injection boundaries, Nigerian English/Pidgin, drafts, report consistency, voice/OCR only if independently validated.
- **Integrate:** hosted store + cart + server-side prices/stock + order identity + Paystack instructions + server verification + allocations + receipts/delivery + seller ledger; genuine concurrent last-unit and webhook replay tests. WhatsApp catalogue-native shopping is explicitly deferred.
- **Complete:** shared identity and one ledger across both entrances; no duplicate documents/postings; cross-product permissions and entitlement cases.
- Every phase distinguishes implementation, green tests, deployed staging, real-provider acceptance and owner launch sign-off. Design the staged acceptance test matrix and owner-operated steps before saying READY.

## Updated task prioritization and per-run decision algorithm

1. Read current canonical docs, live main, PRs, CI and staging `/health`. Reconcile the gap register, not blindly reproduce old status. If PR #298 or another current work branch exists, resume it without duplication.
2. Detect deployment blockers before merges: main push CI pending/cancelled, Git checkout/release mismatch, disk below minimum, missing successful exact push CI. Fix/park according to permissions; leave healthy staging running.
3. Choose next unblocked **P0** from: financial/authorization correctness, verified backup/restore, minimum alerts, outbox backoff and sweeps. Operational safety work precedes cosmetic features.
4. Prefer one branch/PR per independently reviewable slice. Run tests; request independent technical and security/financial review; address all actionable comments; wait for exact-head CI; merge if permitted.
5. Let main push CI and deployment reach a stable result before another merge that would cancel main CI. Confirm actual target release SHA via external health endpoint, then proceed.
6. Prepare owner-held decisions in short standalone proposals; work around them only by taking unrelated approved tasks, not by guessing product policy.
7. After P0 and external gate progress, build essential Admin Console incrementally, then complete all Chat/Integrate/Complete staged acceptance scenarios and production checks.
8. End each run with a durable handoff including measured status, blocked item/owner, next exact safe action and whether the routine must pause destructive actions. Never report future work as already executed.

## Final go/no-go evidence and exclusions

Release must demonstrate: successful off-box backup + isolated restore; effective main protections; alert delivery and replay-safe job handling; approved financial invariants; legal and tax scope; live Paystack evidence; Chat/Integrate/Complete staging acceptance; minimal operator support access; production secrets/host and recovery; written owner production deployment authorization.

If a feature is unavailable (native WhatsApp Business catalogue, automated VAT, refunds, voice/OCR, supplier CRM, bank provider, etc.), do not silently advertise or enable it. Mark it excluded from MVP with documented customer-facing limitation, or obtain explicit owner decision to bring it into launch scope. Never overstate readiness.
