# Compliance pack (remediation R7)

> **DRAFT — REQUIRES DPCO/LEGAL REVIEW.** Every document in this directory
> is a factual draft prepared by engineering. It records what the system
> actually does — which providers receive what data, where it flows, what
> is retained — and deliberately stops short of legal conclusions. Nothing
> here claims a certification, an NDPC approval, or a validated transfer
> mechanism, because none has been obtained or validated. The DPCO / legal
> counsel turns these drafts into filed positions.

## Contents

| Document | What it is | Status |
| --- | --- | --- |
| `subprocessor-register.md` | Every third party that processes data on Rekoda's behalf, and exactly what each receives | DRAFT |
| `record-of-processing.md` | What personal data Rekoda processes, why, and for how long (RoPA draft) | DRAFT |
| `data-transfer-assessment.md` | Where data leaves Nigeria, to whom, and the open legal questions | DRAFT |
| `incident-register.md` | The closed-incident record `privacy-security-incident.md` step 18 appends to | Live register (empty until an incident) |

## Ground rules for editing this pack

- **Facts from the code, conclusions from counsel.** A row in the
  subprocessor register cites the adapter or config that makes it true.
  If the code changes, the register changes in the same PR.
- **Never invent**: no claimed certifications, no "NDPC approved", no
  "transfer mechanism validated" until the validation actually happened
  and is referenced.
- **Honest hosting disclosure**: voice notes and business documents are
  processed by hosted providers (OpenAI, Anthropic) — the pack says so
  plainly, matching `/ai-privacy` and ADR 0032. Absolute claims that
  media never leaves the platform are banned here for the same reason
  they were removed from the public pages
  (`scripts/check-retired-claims.mjs` enforces this).
