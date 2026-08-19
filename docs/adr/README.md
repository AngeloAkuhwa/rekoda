# Architecture Decision Records

Every significant decision is recorded here before or with the code that
implements it. ADRs are immutable once **Accepted** — to change course, write
a new ADR that supersedes the old one.

| # | Title | Status |
|---|---|---|
| [0001](0001-modular-monolith-typescript.md) | Modular monolith on TypeScript (NestJS + Next.js + Postgres) | Accepted |
| [0002](0002-meta-direct-for-chat.md) | Meta Cloud API direct for Rekoda Chat; Twilio for Integrate WABAs | Accepted |
| [0003](0003-paystack-merchant-owned-account.md) | Integrate connects the merchant's own Paystack account (vaulted key) | Proposed |
| [0004](0004-double-entry-ledger-integer-kobo.md) | Double-entry ledger, integer kobo | Accepted |
| [0005](0005-pii-gateway-scope.md) | Privacy gateway: deterministic-first tokenisation, self-hosted STT | Accepted |
| [0006](0006-hosting-hetzner-cloudflare.md) | Hosting: Hetzner + Cloudflare + R2 (no Azure) | Accepted |
| [0007](0007-ai-router-sonnet-default.md) | AI router: deterministic-first, Sonnet as default brain | Accepted |

Template: [0000-template.md](0000-template.md)
