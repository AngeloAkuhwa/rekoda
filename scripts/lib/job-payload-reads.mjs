/**
 * Boundary rule: a job's payload is read across tenants only by the claim (final review of PR #432,
 * 14 Nov 2026).
 *
 * The worker's queue policy (`worker_claim`, migration 0004) lets its credential read every
 * tenant's job row, because it claims work across tenants. The database therefore cannot refuse an
 * unpinned read of what a job carries, and the cutover enrolment of dead jobs once read every
 * tenant's payloads in one unpinned query. This rule holds the repositories to the shape that
 * replaced it: in `packages/db/src/repos`, an SQL statement that reads `payload` from `jobs` is
 * either part of the claim itself (the worker takes one job to run it under that job's own tenant,
 * or ends the job it holds the lease on), or is bounded in the statement to the pinned tenant
 * (`business_id = ... current_setting('app.business_id', true)`), or runs in a function handed a
 * pinned `TenantDb` and names that business in the statement (`business_id = ${businessId}`), as a
 * job handler does on the application credential, where RLS also holds it to the pin.
 *
 * It is a TRIPWIRE, not a guarantee: a regular expression over source text. It recognises a named
 * `payload`, `*`, `to_jsonb(` and `row_to_json(`, top-level functions and `const` arrow functions,
 * and strips `--` and block comments; `sql.raw`, SQL built outside an `sql` template, and files
 * outside the repositories are not seen. The guarantee is review plus the statement-level test
 * (`packages/db/src/ops/dead-job-enrolment-pin.test.ts`).
 */

/** Functions whose statements may read a job's payload without a tenant pin, and why. */
export const CLAIM_FUNCTIONS = new Map([
  ['claimNext', 'the claim: one job, run afterwards under its own tenant (invariant 3)'],
  ['markFailed', 'the job this worker holds the lease on, by id'],
]);

const REPOS = 'packages/db/src/repos/';
const FUNCTION_START =
  /^(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>)/gm;
/** What reads a whole job row, or its payload, without naming the column. */
const READS_PAYLOAD = /\bpayload\b|(?:^|[\s,.])\*|\bto_jsonb\s*\(|\brow_to_json\s*\(/;
const SQL_TEMPLATE = /\bsql`([\s\S]*?)`/g;
const READS_JOBS = /\b(?:FROM|UPDATE|JOIN)\s+(?:public\.)?jobs\b/i;
const PINNED = /business_id\s*=\s*nullif\(\s*current_setting\('app\.business_id',\s*true\)/i;
const NAMED_BUSINESS = /business_id\s*=\s*\$\{\s*businessId\s*\}/;
const TENANT_PARAMETER = /^[^{]*\btx:\s*TenantDb\b/;

/** Each top-level function of a file, with its body (up to the next top-level function). */
function functionsOf(body) {
  const starts = [...body.matchAll(FUNCTION_START)].map((m) => ({
    name: m[1] ?? m[2],
    at: m.index,
  }));
  return starts.map((start, i) => ({
    name: start.name,
    body: body.slice(start.at, i + 1 < starts.length ? starts[i + 1].at : body.length),
  }));
}

export function jobPayloadReadViolations(rel, body) {
  if (!rel.startsWith(REPOS)) return [];
  const found = [];
  for (const fn of functionsOf(body)) {
    if (CLAIM_FUNCTIONS.has(fn.name)) continue;
    for (const [, template] of fn.body.matchAll(SQL_TEMPLATE)) {
      const statement = template.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (!READS_PAYLOAD.test(statement) || !READS_JOBS.test(statement)) continue;
      if (PINNED.test(statement)) continue;
      if (TENANT_PARAMETER.test(fn.body) && NAMED_BUSINESS.test(statement)) continue;
      found.push({
        rel,
        spec: fn.name,
        rule: {
          verb: 'reads a job payload in',
          name: 'cross-tenant job payload read',
          reason:
            "outside the claim, read a job's payload only in a statement bounded to the pinned tenant (business_id = nullif(current_setting('app.business_id', true), '')::uuid, under withBusiness or an explicit pin); discover across tenants by id through a worker-only definer function (ADR 0035 Amendment 1), as jobsRepo.enrolUnrecordedDeaths does",
        },
      });
    }
  }
  return found;
}
