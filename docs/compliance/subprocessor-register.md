# Subprocessor & provider register

> **DRAFT — REQUIRES DPCO/LEGAL REVIEW.** The "what they receive" column
> is engineering fact, verifiable in the cited code. The legal
> characterisation of each party (processor, sub-processor, independent
> controller, joint controller) is a determination for the DPCO — the
> "role (draft)" column is a starting description, not a conclusion.

Last factual review: 29 August 2026, against the launch media
architecture (ADR 0032: OpenAI transcribes, Anthropic reasons and reads
documents, no self-hosted media sidecars).

| Provider | What they actually receive | Purpose | Where processed | Role (draft) | Source of truth in code |
| --- | --- | --- | --- | --- | --- |
| **Meta Platforms** (WhatsApp Business Platform) | Every WhatsApp message a merchant or their customer sends or receives through Rekoda, phone numbers, media, delivery metadata | The messaging channel itself; message delivery and templates | Meta's global infrastructure | Platform/controller under its own terms; **DPCO to characterise** | `apps/api/src/channels/` (webhook ingress, send path) |
| **Anthropic** (Claude models) | Merchant message text with PII tokenised before it is sent; business document and receipt images (raw image bytes) when image AI is enabled | Interpretation of bookkeeping commands; document/receipt extraction; junk-document classification | Anthropic's hosted API (US-based processing) | Processor for AI features; **DPCO to confirm** | `apps/api/src/ai/` (interpreter, `ocr.vision.ts`), flags in `config.ts` (`IMAGE_AI_ENABLED`) |
| **OpenAI** | Voice-note audio (raw audio bytes, transient) when voice transcription is enabled; document images for independent verification of high-value extractions | Speech-to-text; second-opinion extraction verifier | OpenAI's hosted API (US-based processing) | Processor for AI features; **DPCO to confirm** | `apps/api/src/ai/stt.openai.ts`, verifier transport in `ai.module.ts`, flags in `config.ts` (`VOICE_TRANSCRIPTION_ENABLED`) |
| **Paystack** | Payment transactions, payer details Paystack collects itself, merchant settlement account numbers (stored encrypted on our side) | Payment collection and settlement for merchants | Paystack (Nigeria) | Payment processor with its own regulatory status; **DPCO to characterise** | `apps/api/src/payments/` Paystack adapter |
| **OPay** | Payment transactions for merchants who connect OPay | Alternative payment provider | OPay (Nigeria) | As Paystack; **DPCO to characterise** | OPay adapter (PR-070) |
| **Kuda** | Payment transactions for merchants who connect Kuda | Alternative payment provider | Kuda (Nigeria) | As Paystack; **DPCO to characterise** | Kuda adapter (PR-071) |
| **Mono** | Bank account connection and statement/transaction data for merchants who link a bank account | Bank feed for reconciliation | Mono (Nigeria) | Open-banking provider; **DPCO to characterise** | `MONO_SECRET_KEY`/`MONO_BASE_URL` in `config.ts`; Mono Connect widget allowed in the web CSP |
| **Hetzner** | Everything at rest: the production server and database run on a Hetzner box; weekly whole-box snapshots | Hosting (ADR 0006) | Germany (EU) | Infrastructure processor; **DPCO to confirm** | `docs/runbooks/deploy.md`, ADR 0006 |
| **Cloudflare** | Traffic metadata as DNS/proxy in front of the site; generated documents (invoices, receipts, statements) in R2 object storage | CDN/proxy; primary document storage | Cloudflare's global network | Infrastructure processor; **DPCO to confirm** | `deploy.md` (DNS, proxied); `backup-restore.md` (R2 primary) |
| **Backblaze** | Mirror copies of generated documents (B2) | Off-provider backup of documents | Backblaze (US) | Backup processor; **DPCO to confirm** | `backup-restore.md` (R2 + B2 mirror) |

## What is deliberately NOT sent anywhere

- Raw voice audio is never persisted and never placed in logs or error
  messages; it is fetched, probed for duration, sent once to the
  transcriber and discarded (ADR 0032).
- Customer identities are AES-256-GCM ciphertext in the vault; no
  provider receives vault plaintext except as tokenised placeholders in
  model prompts.
- No analytics or advertising processors exist at launch. Adding any
  provider to production means adding a row here in the same PR.

## Change discipline

A new provider, a removed provider, or a change in WHAT an existing
provider receives is a change to this file in the same pull request, plus
a review of `data-transfer-assessment.md` and the public `/privacy` and
`/ai-privacy` pages. The register drifting from the code is the failure
mode this file exists to prevent.
