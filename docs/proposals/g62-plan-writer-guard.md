# Proposal: enforce the single plan writer in the database (G-62 follow-up)

Status: **PROPOSED, awaiting owner agreement (OPEN OWNER DECISION, G-62b).** Written 1 Nov 2026.
Supersedes the approach of PR #387, which is **not authorised to merge**.

## 1. Where PR #387 stands (verified, all 81 threads read)

Head `b76a81b`. CI green. 81 review threads: 69 resolved, **12 unresolved** (11 distinct; two Codex
threads on `statementEnd` and comments are duplicates). Each one is a way the hand-written scanner
in `packages/db/src/single-plan-writer.test.ts` misses a plan write, so the guard could pass while a
second writer exists:

| # | Source | Finding | Scanner gap |
| - | ------ | ------- | ----------- |
| 1 | Codex | Regex literal after a control-condition `)` | `/*` inside the regex is read as a comment and hides later code |
| 2 | Codex | Regex literal containing `}` inside `.set({...})` | object boundary found early, `plan` never seen |
| 3 | Codex | Regex literal containing `;` in `.values()` | chain ends early, `onConflictDoUpdate` unseen |
| 4 | Codex | Cooked escapes in a `sql` template (`\'`) | JS escape read as an SQL escape, rest of statement swallowed |
| 5 | Codex (x2) | `;` inside an SQL comment before `ON CONFLICT` | statement end found early |
| 6 | Codex | Nested `/* /* */ */` SQL comments | `indexOf('*/')` stops at the inner terminator |
| 7 | Codex | JS comment holding `}` and a backtick inside an interpolation | interpolation/template end found early |
| 8 | Codex | `SET ${sql.raw('plan')} = ...` | interpolated left-hand side reads as `$1 = $1` |
| 9 | Codex | `COPY businesses (id, plan) FROM STDIN` | only UPDATE, INSERT and MERGE are recognised |
| 10 | CodeRabbit | `${patch}` nested inside a sliced fragment is not masked | nested fragment composed by Drizzle goes unseen |
| 11 | Codex | `public /* c */ . businesses` | comment around the schema dot defeats the table pattern |

All eleven are REAL-MINOR for the guard's own accuracy and none is a product defect today. None is
resolved. Findings keep arriving on every push because the approach is open-ended: it re-implements
parts of the TypeScript lexer, the template-literal grammar and the PostgreSQL SQL grammar (comments,
quoting, dollar quoting, `MERGE`, `COPY`), and each fix adds code that the next review attacks.

## 2. Can the scanner be reliable enough?

No, not for a security-relevant guard. 1,080 lines and 29 commits have not converged, and the failure
mode is silent: a miss is a green build. Three structural limits remain even if all eleven are fixed:

1. SQL assembled at run time (`sql.raw`, string building, a table imported under another name) is not
   statically decidable. #387 already records the alias case as out of scope.
2. SQL that lives outside `.ts` (migrations, scripts, `psql`) needs its own scanner.
3. It proves nothing about what actually runs.

## 3. Alternatives

| | A. Database trigger plus transaction-local marker | B. SECURITY DEFINER function plus column revokes | C. TypeScript AST sweep (ts-morph / TypeScript compiler API) | D. Allowlist and architecture rule only |
| - | - | - | - | - |
| What it does | A `BEFORE INSERT OR UPDATE OF plan, plan_expires_at` trigger refuses a change by `rekoda_app` or `rekoda_worker` unless the writer set `rekoda.plan_writer` for that transaction | The only way to change the two columns is a function owned by the migration owner; `UPDATE (plan, plan_expires_at)` is revoked from the runtime roles | Parses TS properly and finds `.update(businesses).set({plan})` and `sql` template text | A short list of files allowed to import `businesses`, plus a test that nothing else imports `subscriptions.ts` internals |
| Correctness | Enforced at runtime for every path, dynamic SQL included. Cannot be bypassed by accident. | Strongest against an accidental writer; same strength as A against code that can call the function | Better than a hand scanner for TS structure; still blind to run-time SQL, still needs SQL text parsing | Weak: guards imports, not writes |
| Maintainability | One 15-line function. No parser to keep correct | Revoking a column forces a table-level to column-level grant rewrite; every new `businesses` column then needs an explicit grant or UPDATE silently fails | A real dependency to keep in step with the TS version, plus SQL heuristics | Trivial |
| Testability | Direct: integration tests attempt a forbidden write as `rekoda_app` and assert it is refused and nothing changed | Same | Control cases for each AST shape | Easy, but proves little |
| New dependency | None | None | Yes (a parser dependency, needs owner approval, CLAUDE.md invariant on dependencies) | None |
| Runtime impact | One cheap trigger check, only on UPDATEs that name those columns | Function call on a rare path; table-wide grant change | None at run time | None |
| Migration risk | Low: one additive migration. Fixtures that seed a plan as the runtime role must set the marker (about 19 test files touch the plan; most seed as the owner role, which the trigger does not guard) | High: grant surgery on a hot, RLS-protected table; easy to break every tenant UPDATE | None | None |
| Limits | Any code that can run SQL as the app role can set the marker. It stops second writers and bugs, not an attacker who already executes arbitrary SQL (SQL injection is a separate boundary: parameterised queries, ADR 0001 RLS) | Same limit against an attacker; stronger only if the function validates its arguments | Static only | Static only |

## 4. Recommendation: Option A, plus a four-line static check

1. **Migration** (next number, additive, no data change): create `guard_plan_writes()` and the trigger
   on `businesses`. It raises SQLSTATE `42501` when the current role is `rekoda_app` or `rekoda_worker`,
   the marker `rekoda.plan_writer` is not `on`, and the statement inserts a business or changes `plan`
   or `plan_expires_at` (a no-op assignment is allowed). The owner role, used by migrations and fixtures,
   is not guarded, so migrations (including any future data fix) keep working.
2. **Writers**: `writeSubscriptionState`, `expireSubscription` and `createBusinessWithOwner` call a
   small helper in `subscriptions.ts` that runs `set_config('rekoda.plan_writer', 'on', true)` as their
   first statement. `true` makes it transaction-local, so it cannot leak to the next request on a
   pooled connection (this is validated below and gets its own regression test).
3. **Tests**: integration tests prove (a) a direct plan or expiry update as `rekoda_app` and
   `rekoda_worker` is refused with nothing changed, (b) each of the three writers still succeeds,
   (c) the marker does not outlive its transaction on the same connection, (d) `UPDATE businesses SET name`
   is unaffected, (e) the RED tests for G-62 in #281 still pass unchanged.
4. **Static check** (tiny, no SQL or TS parsing): a plain `readFileSync` assertion that the marker name
   appears in exactly `subscriptions.ts` and `identity.ts`, so the escape hatch itself stays in two files.
   This is an allowlist (option D) on one literal, not a scanner.

The runtime role that holds the marker is the same role that writes the plan, so this cannot be
bypassed by a code path that does not know about it, which is the failure #387 tried to detect. It does
not prevent a developer from copying the marker into a new file; the static check and review catch that.

## 5. Validation already done (no repository change)

On a scratch PostgreSQL 16 database with `rekoda_app` and `rekoda_worker` roles and a cut-down
`businesses` table:

- `UPDATE ... SET plan` as `rekoda_app` without the marker: refused (42501).
- `plan` plus `plan_expires_at` together: refused.
- `UPDATE ... SET name`: allowed. `SET plan = plan`: allowed (no change).
- With `set_config('rekoda.plan_writer','on', true)` inside a transaction: allowed, and a later plain
  update on the same connection after COMMIT is refused again.
- Owner role: unguarded, as intended.
- Finding: the check must use `current_user`, not `session_user`, or `SET ROLE` based tests pass
  incorrectly. Production connects as the role, so both agree there.

Not yet validated, and to be done in the implementation PR against the real schema: the full db and api
integration suites with the trigger in place (to find every runtime-role fixture that seeds a plan), the
worker role under the job queue, and the rollback path (`DROP TRIGGER`, `DROP FUNCTION`; no data change).

## 6. What stays the same

- #281's fix is untouched: `billingRepo.setPlan` still goes through `writeSubscriptionState`, the one
  writer `applyCycle` uses. This proposal only adds a database refusal behind it.
- No permissions are weakened and no grant changes. The trigger can only refuse more.
- No new dependency. No row is rewritten.

## 7. Decision needed

Approve Option A, or choose B, C or D. On approval: close #387 without merging, then one focused PR
(`feat/g62b-db-plan-writer-guard`) with the migration, the helper, the RED/GREEN tests and fresh Codex
and CodeRabbit reviews, merged only on exact-head CI and zero unresolved material findings.
