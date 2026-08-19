# 0020 — Identity persistence: the setup grant, and a second pin for the bootstrap read

**Status:** Accepted
**Date:** 2026-08-19
**Implements:** MASTER-PLAN §5.2.2, §5.2.6 · **closes** 4.4 #1, #2, #5
**Builds on:** [0001](0001-modular-monolith-typescript.md) (RLS as the second line of defence)

## Context

M1 shipped the identity *rules* as pure, tested logic in `packages/core` behind a
dev-only in-memory store in `apps/web`. Replacing that store was an M1 exit
criterion, and doing it surfaced three decisions that are not obvious from the
spec and would otherwise be rediscovered — expensively — by whoever touches
identity next.

## Decision 1 — a session is bound to a business, so onboarding needs a different artefact

`sessions.business_id` is `NOT NULL`, deliberately: a session that is not
scoped to a tenant is a credential with no blast radius. But onboarding has a
real gap between *"this phone is verified"* and *"this merchant has a business"*,
and something has to authorise the request that closes it.

The tempting fix is to make `business_id` nullable. **Rejected:** it weakens the
invariant everywhere, permanently, to serve about ninety seconds of onboarding —
and every future reader of the sessions table then has to ask whether a null
means "onboarding" or "bug".

Instead the gap gets its own artefact: a **setup grant**. HMAC-signed,
stateless, thirty minutes, and authorising exactly one endpoint —
`POST /v1/businesses`. It is not stored, and that is a bounded cost: a stolen
grant lets the thief create a business for a phone number they already control,
and confers no read access to anything.

It is exchanged for a real session the moment the business exists, and the web
tier clears it in the same action — two credentials for the same identity must
not both stay live.

## Decision 2 — `app.user_id`, a second pin, for the one read that precedes the tenant

`memberships` is under `tenant_isolation`, which keys on `app.business_id`. But
the first question a sign-in must answer is *which* business — and at that
moment there is nothing to pin, so an unpinned `SELECT` correctly returns
nothing and the merchant can never get in.

**`SECURITY DEFINER` does not work here**, and the reason is worth recording
because it looks like it should. The tenant tables are under `FORCE ROW LEVEL
SECURITY`, so the policies apply to the table owner too; a definer-rights
function owned by that role is filtered exactly like every other caller. It
would have returned zero rows while looking like a fix.

The decision is a second, deliberately narrow pin — `app.user_id`, set by
`withUser()` — backed by a policy that is:

* **`SELECT`-only** — a pinned user can *discover* memberships, never mint one.
  Writes still go through `tenant_isolation`'s `WITH CHECK`.
* **one table** — businesses, ledgers and everything else are untouched.
* **fail-closed** — the same `nullif()` guard, so an unpinned transaction sees
  nothing rather than everything.

What it costs: code that can pin an arbitrary user id learns that user's
business ids and role names. It learns no financial data — reading a single
naira still requires pinning the business itself.

## Decision 3 — the rate limit is a claim about locking, not about counting

The five-attempt OTP limit was already tested, and the tests passed, and the
limit did not hold: five concurrent guesses each read `attempts = 0`, each
concluded they were within budget, and each wrote `attempts = 1`. An attacker
willing to open parallel connections had unlimited tries against a counter that
never climbed.

Every OTP decision now runs inside `withPhoneLock` — a transaction-scoped
advisory lock keyed on the phone number, released on commit or rollback with no
cleanup path to forget. The regression test issues twelve simultaneous guesses,
which is the only shape of test that can observe the difference.

The same reasoning applies to `upsertUserByPhone`: a read-then-write loses the
race between two devices verifying the same number, and the loser is a merchant
split across two ledgers. `ON CONFLICT` makes the unique index decide instead.

## Consequences

* **`apps/web` can no longer assert identity.** It holds no pool, no signing
  secret and no tenant pin — only opaque tokens the API issued. The interim
  signed-cookie marker is deleted.
* **Every guard is a round trip.** "A cookie is present" is a fact an attacker
  controls; the guards now ask the API instead. That costs latency on three
  onboarding pages and buys a check the web tier could not otherwise make.
* **One status for "no live challenge."** Consumed, expired and never-issued all
  answer `expired`, so probing a number cannot reveal whether a sign-in there
  recently succeeded. The merchant-facing copy has to be true of all three, and
  is.
* **The tenancy claim is now tested rather than asserted** — two tenants over
  one pooled connection, with the suite proven to go red under a superuser
  connection.
* **Boundaries are enforced in CI.** `scripts/check-boundaries.mjs` fails the
  build on a raw driver import outside `packages/db`, or any `@rekoda/db` import
  from `apps/web`. It should fold into `no-restricted-imports` when an ESLint
  toolchain lands.
