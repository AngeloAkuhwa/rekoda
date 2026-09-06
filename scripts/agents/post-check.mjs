#!/usr/bin/env node
/**
 * Publishes a stable-named check run bound to an exact commit SHA via the
 * Checks API — UPSERTING in place: if a check run with this name already
 * exists on the SHA (GitHub's list endpoint defaults to filter=latest,
 * one per name+app), it is PATCHed rather than duplicated, so one
 * name+SHA never carries ambiguous same-name conclusions and a same-HEAD
 * contract-revision redispatch deterministically flips the SAME required
 * check rather than racing a duplicate. Requires checks: write.
 *
 *   node scripts/agents/post-check.mjs --repo o/n --name "Technical Review Gate" \
 *     --sha <head> --conclusion success|failure|neutral --title "…" --summary "…"
 */
import { execFileSync } from 'node:child_process';
import { chooseCheckAction } from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const { repo, name, sha, conclusion } = args;
if (
  !repo ||
  !name ||
  !/^[0-9a-f]{40}$/i.test(sha ?? '') ||
  !['success', 'failure', 'neutral'].includes(conclusion)
) {
  console.error(
    'Usage: post-check.mjs --repo o/n --name N --sha <40hex> --conclusion success|failure|neutral [--title T --summary S]',
  );
  process.exit(2);
}

const gh = (ghArgs) => execFileSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

// Fail-closed upsert decision: a FAILED lookup ABORTS visibly (a blind
// POST during an API failure could race a concurrent creation into
// same-name duplicates with ambiguous conclusions), and an existing run
// is adopted for PATCH only when it belongs to the GitHub Actions app —
// a same-name run from a foreign app is never adopted as "ours".
let lookupOk = true;
let runs = [];
try {
  const list = JSON.parse(
    gh([
      'api',
      `repos/${repo}/commits/${sha.toLowerCase()}/check-runs?check_name=${encodeURIComponent(name)}&per_page=10`,
    ]),
  );
  runs = (list.check_runs ?? []).map((c) => ({ id: c.id, name: c.name, appSlug: c.app?.slug }));
} catch (e) {
  lookupOk = false;
  console.error(`::error::Check-run lookup failed for '${name}' on ${sha}: ${e.message}`);
}

const decision = chooseCheckAction({ lookupOk, runs, name });
if (decision.action === 'abort') {
  console.error(
    `::error::Refusing to publish check '${name}' without a provable current state (${decision.reason}); the required check stays missing/red — fail closed, not fail duplicate.`,
  );
  process.exit(1);
}
const existingId = decision.action === 'patch' ? decision.id : null;

const fields = [
  '-f',
  `status=completed`,
  '-f',
  `conclusion=${conclusion}`,
  '-f',
  `output[title]=${(args.title ?? name).slice(0, 250)}`,
  '-f',
  `output[summary]=${(args.summary ?? '').slice(0, 60000)}`,
];
if (existingId) {
  gh(['api', '--method', 'PATCH', `repos/${repo}/check-runs/${existingId}`, ...fields]);
  console.log(`Check '${name}' → ${conclusion} on ${sha} (updated in place, id ${existingId}).`);
} else {
  gh([
    'api',
    '--method',
    'POST',
    `repos/${repo}/check-runs`,
    '-f',
    `name=${name}`,
    '-f',
    `head_sha=${sha.toLowerCase()}`,
    ...fields,
  ]);
  console.log(`Check '${name}' → ${conclusion} on ${sha} (created).`);
}
