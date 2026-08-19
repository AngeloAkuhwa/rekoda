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
   (`CUSTOMER_X81`) everywhere else, including to AI providers. Rehydration
   happens only in the authorised output layer. Voice audio is transcribed on
   Rekoda-controlled infrastructure and never sent to third parties.
3. **Secrets are never committed.** CI runs a secret scanner on every push.
   Provider credentials supplied by merchants (e.g. Paystack keys) are
   encrypted at rest with AES-256-GCM under a key that lives only in the
   environment.
4. **All webhooks are signature-verified** (Meta `X-Hub-Signature-256`,
   Twilio `X-Twilio-Signature`, Paystack HMAC-SHA512) and processed
   idempotently — a replayed or forged delivery cannot create a second
   financial record.
5. **Money is integer kobo and double-entry.** Financial mutations are
   transactional, auditable (append-only audit events), and never performed
   by AI output without deterministic validation.
6. **Authentication is passwordless**: phone-verified OTP, single-use
   hashed magic links with short TTLs, HTTP-only session cookies,
   constant-time comparisons. Magic-link tokens are never logged and are
   invalidated on first use.
7. **Least privilege everywhere**: fine-grained access tokens with expiry,
   role-scoped dashboard permissions (owner vs accountant), and admin
   actions written to their own audit trail.

## Token hygiene for contributors

Access tokens (GitHub PATs, provider keys) must be fine-grained, expiring,
and scoped to this repository or the specific provider resource. Any token
that is ever pasted into a chat, ticket, log, or screenshot is considered
burned — rotate it immediately.
