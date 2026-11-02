# 0036 — Platform-wide, address-keyed data is not tenant data, and says so

**Status:** Accepted
**Date:** 2026-11-02
**Owner rulings:** OWN-49 and OWN-55 (email suppression), OWN-58 and OWN-66 (billing-email limit per address)
**Relates to:** ADR 0035 and its Amendment 1, which classify cross-tenant access to TENANT data.
This ADR does not amend them: it records a kind of data they do not cover.

## Context

Two owner rulings need facts about an email ADDRESS that hold whichever business is asking:

- **Suppression** (OWN-49, OWN-55; migration 0179 `email_suppressions`): a mailbox that bounced
  or complained rejects Rekoda for every merchant.
- **The billing-email confirmation limit per address** (OWN-58, OWN-66; migration 0185
  `billing_email_address_requests`): at most 5 requests an hour per normalised address across all
  businesses, 60 seconds apart.

A tenant-scoped table cannot answer either question. The application role, pinned to one
business, can only count that business's rows. ADR 0035 Amendment 1 lists three classes of access
to tenant data. Neither table holds tenant data, and until now nothing said so in one place.

## Decision

Platform-wide, address-keyed data is a fourth, separate kind of data. It is not an exception to
tenant isolation, because it holds nothing a tenant owns. A table qualifies only if all of these
hold:

1. **No tenant column and no business identifier.** The table also holds nothing that joins back
   to a business, such as a token hash or a link id.
2. **The address is never stored**, only a hash of the normalised address.
   - New tables use a keyed HMAC under `MATCH_KEY` in their own keyspace (`billingEmailAddressKeyFor`,
     prefix `billing-email-address:`), so a dump cannot be matched against a list of guessed
     addresses.
   - `email_suppressions` predates this rule and keeps its unkeyed SHA-256. Moving it to a keyed
     hash is a follow-up, not part of this decision.
3. **Least privilege, stated in the migration.** The worker role has no access.
   - New tables are reached by the application role only through `SECURITY DEFINER` functions
     with a pinned `search_path`, validated inputs and `EXECUTE` revoked from `PUBLIC` and the
     worker. The table itself is revoked from both roles. (0185 does this.)
   - `email_suppressions` grants the application role `SELECT` and `INSERT` directly. It
     predates this rule.
4. **What a response reveals is only what the owner's rule requires**, and that residual is
   written down here and in `REKODA_LAUNCH_READINESS.md`.
5. **Erasure by key:** an operator can remove an address by deriving its key
   (`docs/runbooks/data-erasure.md`).
6. **Short-lived where the rule allows it.** The 0185 counter prunes rows older than a day on
   later requests. Suppressions are permanent by design.

## Accepted residuals (inherent to the owner rulings, not defects)

- **Existence signal.** A business that enters an address can learn one bit about other businesses:
  - From the per-address limit: whether that address was asked for by some business in the last
    hour (it is refused with no request of its own).
  - From suppression: whether the address has bounced or complained.

  The signal costs a real request every time. While a business is inside its own cooldown, the
  address's wait is folded into its answer only when the business's own latest link was issued for
  the address it keeps now, that is, it asked for that address itself. An address switched to during
  the cooldown, in one step or in two (switch, then ask again), is answered with the business's own
  wait only, so addresses cannot be probed for free.

  No business, count, time or identity is revealed. The refusal is the same shape as a business's
  own, and its retry time is fixed (60 s or 3600 s), never "N seconds since another business
  asked". Any cross-business limit gives at least this signal.

- **Allowance exhaustion.** A business that enters someone else's address can use up that
  address's hourly allowance and delay the real owner's confirmation by up to an hour at a time.
  - The mailbox still receives at most five links an hour, which is the abuse the limit exists to
    stop.
  - The operator remedy is to erase the address's key.
  - Whether to add a per-business share of the per-address allowance is OPEN OWNER DECISION OD-39
    in `REKODA_LAUNCH_READINESS.md`.

## Consequences

- A new platform-wide, address-keyed table follows the six conditions above and adds a line here.
  Anything that needs a business id is tenant data and falls under ADR 0035.
- The RLS exemption register stays a list of tables WITH `business_id`, and these tables are not
  in it.
