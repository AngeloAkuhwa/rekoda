# Security Policy

Rekoda handles small businesses' financial records and their customers'
personal data. Security is a product feature here, not a checklist.

## Reporting a vulnerability

Email **angeloakuhwa@gmail.com** with subject `SECURITY: <short summary>`.
Include reproduction steps and impact. You will get an acknowledgement within
2 working days. Please do not open public issues for security reports, and do
not test against production merchant data.

## Principles the codebase holds to

1. **Tenant isolation is enforced twice.** Every business-owned row carries
   `businessId`, every query is tenant-scoped in code, and PostgreSQL
   row-level security enforces it again at the database — a missed `WHERE`
   clause returns zero rows, not another tenant's ledger.
2. **Customer PII lives in an encrypted vault** and travels as opaque tokens
   (`CUSTOMER_X81`) through the text path: supported personal identifiers
   (recognised customer names, phone numbers, email addresses and supported
   financial identifiers) are detected and tokenised before any reasoning
   model reads a message, and rehydration happens only in the authorised
   output layer. Anthropic Claude is the hosted reasoning provider.
3. **Media takes a dedicated, disclosed processing path.** Voice notes are
   processed transiently: when voice transcription is enabled, the audio is
   securely sent to Rekoda's configured transcription provider, currently
   OpenAI, solely for transcription. Supported document photographs are
   securely sent to Anthropic Claude solely to be read into text. Rekoda
   does not intentionally retain the raw media after processing; the
   transcript or extracted text then enters the same tokenisation flow as
   typed text before any reasoning model sees it. Both providers operate
   under API terms that exclude training on inputs, over encrypted
   transport, and are documented as service providers/subprocessors. There
   is no self-hosted transcription or OCR service in the launch
   architecture, and no silent fallback between engines (ADR 0032).
4. **Secrets are never committed.** CI runs a secret scanner on every push.
   Provider credentials supplied by merchants (e.g. Paystack keys) are
   encrypted at rest with AES-256-GCM under a key that lives only in the
   environment.
5. **All webhooks are signature-verified** (Meta `X-Hub-Signature-256`,
   Twilio `X-Twilio-Signature`, Paystack HMAC-SHA512) and processed
   idempotently — a replayed or forged delivery cannot create a second
   financial record.
6. **Money is integer kobo and double-entry.** Financial mutations are
   transactional, auditable (append-only audit events), and never performed
   by AI output without deterministic validation.
7. **Authentication is passwordless**: phone-verified OTP, single-use
   hashed magic links with short TTLs, HTTP-only session cookies,
   constant-time comparisons. Magic-link tokens are never logged and are
   invalidated on first use.
8. **Least privilege everywhere**: fine-grained access tokens with expiry,
   role-scoped dashboard permissions (owner vs accountant), and admin
   actions written to their own audit trail.

## Token hygiene for contributors

Access tokens (GitHub PATs, provider keys) must be fine-grained, expiring,
and scoped to this repository or the specific provider resource. Any token
that is ever pasted into a chat, ticket, log, or screenshot is considered
burned — rotate it immediately.
