#!/usr/bin/env node
/**
 * Resolves the privileged gates' target PR from an untrusted request
 * (docs/AUTONOMOUS-ENGINEERING.md §6), failing closed on ambiguity:
 *
 *   --head-sha <sha>   workflow_run path: list the commit's PRs and
 *                      accept only EXACTLY ONE open same-base candidate
 *                      whose CURRENT head still equals the sha.
 *                      zero → pr='' (nothing to evaluate, exit 0);
 *                      stale (force-push) → pr='' superseded (exit 0 —
 *                      the new head's own request owns evaluation);
 *                      ambiguous → exit 1; API failure → exit 1.
 *   --pr <n>           workflow_dispatch path: the number is a REQUEST;
 *                      the PR is fetched fresh and must be open in this
 *                      repository, else exit 1.
 *
 * Writes pr=<n|''> to GITHUB_OUTPUT.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolveWorkflowRunTarget } from './evaluator.mjs';
import { ghPagedComplete } from './gh-lib.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const repo = args.repo;
if (!repo) {
  console.error('Usage: resolve-target.mjs --repo o/n (--head-sha <sha> | --pr <n>)');
  process.exit(2);
}
const out = (pr) => {
  console.log(`pr=${pr}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pr=${pr}\n`);
};
const gh = (p) =>
  JSON.parse(execFileSync('gh', ['api', p], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

if (args.pr) {
  const n = Number(args.pr);
  let pr;
  try {
    pr = gh(`repos/${repo}/pulls/${n}`);
  } catch (e) {
    console.error(`::error::Requested PR #${n} could not be fetched: ${e.message}`);
    process.exit(1);
  }
  if (pr.state !== 'open' || (pr.base?.repo?.full_name ?? '') !== repo) {
    console.error(
      `::error::Requested PR #${n} is not an open PR of ${repo}; refusing to evaluate.`,
    );
    process.exit(1);
  }
  out(n);
  process.exit(0);
}

// Exhaustively paginated: the true candidate — or a second open PR that
// makes the request ambiguous — may sit past page 1, so a truncated
// listing is UNPROVABLE state, never treated as a complete answer.
const sha = String(args['head-sha'] ?? '').toLowerCase();
const paged = ghPagedComplete(`repos/${repo}/commits/${sha}/pulls`);
const candidates = paged.items.map((p) => ({
  number: p.number,
  state: p.state,
  headSha: (p.head?.sha ?? '').toLowerCase(),
  baseRepo: p.base?.repo?.full_name ?? '',
}));

const r = resolveWorkflowRunTarget({ headSha: sha, candidates, repo, complete: paged.complete });
if (r.status === 'ok') {
  out(r.pr);
} else if (r.status === 'none') {
  console.log(`No open PR of ${repo} currently targets ${sha} — nothing to evaluate.`);
  out('');
} else if (r.status === 'stale') {
  console.log(
    `PR #${r.pr} has moved past ${sha} (force-push/new push) — this request is superseded; the new head's own request owns evaluation.`,
  );
  out('');
} else if (r.status === 'unprovable') {
  console.error(
    `::error::Candidate listing for ${sha} is incomplete (API failure or pagination ceiling) — the target cannot be proven; failing closed.`,
  );
  process.exit(1);
} else {
  console.error(
    `::error::Multiple open PRs share commit ${sha}; a privileged evaluation must know exactly whom it judges — failing closed.`,
  );
  process.exit(1);
}
