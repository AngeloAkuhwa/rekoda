# Runbook — Privacy & security incident response (remediation R6)

For a suspected security compromise or personal-data breach. The
operational cousin, `incident.md`, answers "is money still moving" — run
its probes as part of step 5, but a privacy incident is a different animal:
its deadlines are legal, its evidence must survive, and two of its steps
are decisions an operator must NOT make alone.

Steps marked **LEGAL DECISION** are made by the DPCO / legal counsel with
the owner, never by the operator on shift. The operator's job at those
steps is to assemble facts and start the clock, not to conclude.

## Phase A — First hour: contain and preserve

1. **Declare it and start the log.** One file, UTC timestamps, append-only:
   when it was noticed, by whom, what was seen. Every later step appends.
   The log is written for a regulator to read, so facts only, no
   speculation.
2. **Classify what you are looking at**: (a) a security incident (an
   attacker touched or could touch the estate), (b) a personal-data breach
   (personal data was destroyed, lost, altered, disclosed or accessed
   without authorisation), or (c) both. The classification decides whether
   Phase C exists; when in doubt, treat it as (c) until Phase B says
   otherwise.
3. **Contain, narrowest first.** Revoke or rotate the credential involved
   (`key-rotation.md` — the stateless keys rotate in minutes); disable the
   affected route or operator secret; as a last resort take the API down
   (`docker compose stop api`). A contained incident with a down service
   beats a live exfiltration with a green health check.
4. **Preserve evidence before changing anything else.** Snapshot the
   database, copy container logs off-box, note the running image digests.
   Do not truncate, tidy, or "clean up" anything — deletion during an
   incident is how an accident becomes a cover-up.
5. **Run the operational probes** (`incident.md`): `/v1/ops/health`,
   `/v1/ops/financial-integrity`. A privacy incident and a books-integrity
   incident can be the same incident.

## Phase B — Assessment: scope before conclusions

6. **Establish scope from records, not memory**: which tables, which
   tenants, what time window. `audit_events`, the job log, Caddy access
   logs and provider dashboards (Meta, Paystack) are the sources. Name
   counts, not guesses, in the log.
7. **Assess what the data actually was.** Rekoda's identity data is
   AES-256-GCM ciphertext in the vault and keyed-HMAC blind indexes;
   whether exposed ciphertext without the key constitutes a breach of the
   underlying data is part of the **LEGAL DECISION** in step 11 — the
   operator records WHAT was exposed (ciphertext, plaintext, keys,
   fingerprints) and never downgrades an incident on their own crypto
   reasoning.
8. **Rotate everything plausibly touched**, not just the credential you
   can prove was taken (`key-rotation.md`; a `VAULT_KEY` rotation is a
   re-wrap migration, so it is a decision with the owner, but
   `META_APP_SECRET`, Paystack keys, operator and API secrets rotate
   immediately and cheaply).
9. **Check the provider side**: Meta app dashboard for unfamiliar
   subscriptions, Paystack for unfamiliar API keys or transfers, Anthropic
   and OpenAI consoles for usage that is not ours. The `badSignatures`
   counters in `/v1/ops/health` are the estate's own record of forged
   webhook attempts.
10. **Keep the timeline current as facts land.** Every notification
    decision in Phase C depends on "when did we become aware" — the log's
    first entry is that moment, so the log, not anyone's recollection, is
    the clock.

## Phase C — Notification: the legal decision points

11. **NDPC notification — LEGAL DECISION.** If Phase B concludes personal
    data was breached, Nigerian data-protection law (the NDPA and its
    subsidiary instruments) imposes notification duties on data
    controllers, on short statutory timelines — the commonly cited window
    for notifying the Nigeria Data Protection Commission is 72 hours from
    awareness, where notification is required at all. Whether THIS
    incident meets the threshold, when the clock started, and what the
    notice must contain are determinations for the DPCO / legal counsel —
    this runbook deliberately does not conclude them. The operator's job:
    hand over the incident log, the scope figures from step 6, and the
    data characterisation from step 7, early enough that the 72-hour
    window is still open when counsel gets the question.
12. **Data-subject notification — LEGAL DECISION.** Whether affected
    merchants (and their customers, whose data merchants hold in Rekoda)
    must be told, in what form and how fast, follows from the same legal
    assessment. Prepare the facts for counsel; do not send anything yet.
13. **Contractual and platform notifications — LEGAL DECISION.** Meta
    (WhatsApp Business terms), Paystack, Mono and the AI providers each
    have their own incident-notification clauses. Counsel decides which
    apply; the operator lists which providers' data or credentials were in
    scope so nothing is missed.
14. **Draft comms under the standing rules** (`incident.md` § Comms): no
    speculation, no naming a specific customer's data without owner
    sign-off, nothing sent before the step 11-13 decisions are made.

## Phase D — Recovery and closure

15. **Eradicate and recover**: redeploy from a clean build
    (`deploy.md`); if books integrity is in doubt, restore per
    `backup-restore.md` § "Real restore (incident)". The boot gates (RLS
    role check, key fingerprints, config validation) are the first
    verification that the recovered estate is the estate you meant.
16. **Verify green end to end**: `/health`, `/v1/ops/health`,
    `/v1/ops/financial-integrity` all clean; `badSignatures` flat; the
    deploy smoke checklist passes.
17. **Post-incident review within 14 days.** Blameless, written, and it
    answers three questions: what let this happen, what detected it (or
    should have), and which controls change. Actions land in the build
    plan with owners, not in a paragraph nobody re-reads.
18. **Close the record.** Append the outcome to
    `docs/compliance/incident-register.md` (date, classification, scope,
    notifications made or the documented decision not to, review link).
    The incident log itself is retained with the privacy correspondence —
    it is the evidence that the process ran.
