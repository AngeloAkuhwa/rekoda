# 0003 — Integrate connects the merchant's own Paystack account (vaulted key)

**Status:** Accepted — **reinstated as the default by
[0019](0019-paystack-account-model-final.md)** (19 Aug 2026). The merchant owns
their Paystack account, Rekoda vaults the key and never enters the money flow.
Collection is **Pay with Transfer** per [0016](0016-per-transaction-accounts-not-per-customer.md).
**Date:** 2026-08-19

## Context

Rekoda Integrate must observe a merchant's Paystack payments to reconcile
them against orders and invoices. Paystack offers three viable shapes:

1. **Merchant's own account** — Rekoda stores the merchant's secret key
   (encrypted), registers a webhook, and creates payment requests on the
   merchant's behalf. Money settles directly to the merchant.
2. **Subaccounts / split payments** under a Rekoda master account.
3. **Paystack Connect** (platform product).

## Decision

Route 1 for V1: **merchant's own Paystack account**, secret key encrypted
at rest with AES-256-GCM under an environment-held key (the vendor-SMTP
vault pattern, already proven), webhook signature verified per merchant.

## Consequences

Money never touches Rekoda — no settlement liability, no licensing
questions, the cleanest NDPA/compliance story, and merchants keep their
existing Paystack relationship and history. The cost: we hold merchant API
keys (mitigated by encryption, masking, never-display-back, and audit
events on every use), and merchants without a Paystack account have
onboarding friction (mitigated by a guided setup step; subaccounts/Connect
revisited post-V1 for that segment). Key rotation: merchants can replace
the key at any time; a failed-auth webhook or API call flags the connection
unhealthy in admin.
