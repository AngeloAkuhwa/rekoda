# 0034 — The operator plane has identities, not a shared secret

**Status:** Accepted
**Date:** 2026-09-01
**Amends:** nothing. This is the first ADR to describe the operator plane's
authentication; the plane predates it and carried a static header credential
by default rather than by decision.

## Context

`/v1/ops/*` and the plan endpoint are the only routes in Rekoda that act
across every tenant. They read the estate's queue depth and margin, they
resolve payment exceptions, they record refunds against a merchant's charge,
and they move a business between paid plans.

Until now the whole of that authority was one value: `REKODA_OPERATOR_SECRET`,
compared in constant time against a plaintext request header. Two separate
failures wore that one shape.

**Possession is not identity.** Everyone who has ever run an ops command holds
the credential. It appears in shell history, in a proxy access log, in a
runbook, in whatever a person pasted into a chat during an incident. Removing
one person's access means rotating it for everybody, which means it does not
really happen. The audit row says an operator acted; it cannot say which one.

**A claim is not a fact.** The refund, plan-change and exception-resolution
endpoints each took an `actor` string in the request body and wrote it into
the audit trail. Whoever held the secret also chose what the record said they
were called. That is not an audit trail; it is a field.

And there was no third question at all. A credential that could read the
margin report could also refund any merchant in the estate, because there was
only one credential and it meant "yes".

## Decision

1. **The operator plane authenticates a verified identity, not a secret.** In
   production the API verifies a signed token: issuer, audience, expiry and
   signature, against a published key set. `jose` does the cryptography;
   hand-rolled JWT verification is where `alg: none` and key-confusion bugs
   live, and this is the one boundary in Rekoda where such a bug hands over
   every merchant's money.

2. **The verifier is provider-neutral.** `OPERATOR_OIDC_ISSUER`,
   `OPERATOR_OIDC_AUDIENCE` and `OPERATOR_OIDC_JWKS_URL` are deployment facts.
   Cloudflare Access, an identity-aware proxy or a plain OIDC provider all
   satisfy them, and none of them is named in the code. Rekoda's domain logic
   must not couple to whichever one the deployment picks.

3. **Network placement and application authentication are separate controls.**
   `/v1/ops/*` is not intended to be reachable from the open internet, and
   identity-aware access at the edge is the first control. The verification in
   the application is defence in depth, not a substitute for it — and not
   redundant either: the edge is a deployment fact that a repository cannot
   assert, and this one is enforced by code.

4. **Authority is scoped.** Five scopes, because "authenticated" and "may
   refund every merchant in the estate" are different questions:

   ```
   ops:read      read the estate: health, margin, graduation, integrity, a business
   ops:payment   move money or close a payment exception
   ops:privacy   act on personal data
   ops:billing   change what a business pays
   ops:security  security-plane actions
   ```

   A token minted for a dashboard cannot issue a refund. A scope the code does
   not recognise is dropped rather than carried, because an unrecognised scope
   authorises nothing and keeping it only makes a log line look like
   permission.

5. **Every operator route declares the scope it needs, and one that does not
   is refused.** Not defaulted to the narrowest scope, not defaulted to any
   scope: a route nobody decided the authority for is a mistake in this
   repository, and it answers 503 so it reads like one. `operator-plane.test.ts`
   reads the declarations back off the controllers and fails if a route exists
   without one, so the invariant survives the next endpoint somebody adds.

6. **The audit actor is the verified subject, and nothing else.** The `actor`
   field is gone from `opsRefundRequest`, `opsResolveEventRequest` and
   `setPlanRequest`. This is a **breaking change to the operator API**, and
   deliberately so: leaving the field accepted-but-ignored would leave scripts
   that still send it looking correct.

7. **Production fails closed at boot.** With no verifier configured, the API
   refuses to start. Not a runtime 503 — a process that came up without
   operator identity is a process where somebody reaches for the static secret
   during an incident, and an incident is exactly when estate-wide authority
   should be hardest to get. Half a configuration is refused everywhere,
   production or not: two of three variables is somebody mid-rollout, and
   silently reading that as "no verifier" would turn a half-finished
   deployment change into a quiet downgrade to the shared secret.

8. **`REKODA_OPERATOR_SECRET` survives as a development stand-in and is
   refused in production.** Refused, not ignored: a secret sitting in a
   production environment reads as a live credential to everyone who finds it,
   and the one thing worse than a shared secret is a shared secret people
   believe still works. Where it does apply, everything it authorises is
   audited as `operator:local:operator-secret` — the honest record of a
   credential that names nobody.

9. **401 and 403 now mean different things.** They used to be one blanket 403.
   401 is "no credential, or one that does not verify". 403 is "verified, and
   this scope is not yours" — and it names the missing scope, because that
   tells the caller about their own token rather than about the deployment.
   The authentication refusal stays uniform whatever went wrong: a caller who
   learns *which* check failed learns whether they have the right issuer, the
   right audience or merely a stale token, and that is a map.

## Consequences

Standing up an identity provider is now a prerequisite for production, listed
in `docs/HANDOFF.md` beside the other launch credentials. `docs/runbooks/incident.md`
polls with a bearer token; the operator running it needs `ops:read`, and the
refund and exception-resolution steps need `ops:payment`.

Removing a person is now a change at the identity provider rather than a
rotation that logs everyone out. `docs/runbooks/key-rotation.md` records that
`REKODA_OPERATOR_SECRET` no longer exists in production, so there is nothing
there to rotate.

## What this ADR does not do

It does not model an operator organisation: roles, groups and approval
workflows are the identity provider's, not Rekoda's. It does not add a second
approval step to any operator action — a refund still takes one authorised
person, and whether that is right is a separate decision. It does not extend
scopes to merchant-facing routes, which are governed by sessions and the
tenant role model. And it does not assert anything about where `/v1/ops/*` is
reachable from: that is a deployment fact, recorded as one when the owner
confirms it, never inferred from this repository.
