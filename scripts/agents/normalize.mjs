#!/usr/bin/env node
/**
 * Normalizes live GitHub state for the pure policy evaluator
 * (scripts/agents/evaluator.mjs). All network access lives HERE; the
 * evaluator stays pure. Untrusted text (bodies, comments, reviews) is
 * carried as JSON values only — never through a shell.
 *
 * Usage:  GH_TOKEN=… node scripts/agents/normalize.mjs \
 *           --repo owner/name --pr 123 --out /tmp/state.json
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseClosingRefs } from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const repo = args.repo;
const prNumber = Number(args.pr);
if (!repo || !Number.isInteger(prNumber)) {
  console.error('Usage: normalize.mjs --repo owner/name --pr N [--out file]');
  process.exit(2);
}

const OWNER_LOGIN = process.env.OWNER_LOGIN || 'AngeloAkuhwa';
const CODEX_LOGIN = process.env.CODEX_LOGIN || 'chatgpt-codex-connector[bot]';
const TRUSTED_MARKER_AUTHORS = ['github-actions[bot]'];
const AUTHORIZED_REVISION_AUTHORS = ['github-actions[bot]', OWNER_LOGIN];
const CLAUDE_SIDE_AUTHORS = ['claude[bot]', 'github-actions[bot]'];

function gh(pathname, extra = []) {
  return JSON.parse(
    execFileSync('gh', ['api', pathname, ...extra], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

function ghPaged(pathname) {
  // Up to 3 pages of 100 — a PR/issue with more comments than that has
  // bigger problems than this gate.
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const chunk = gh(`${pathname}${pathname.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...chunk);
    if (chunk.length < 100) break;
  }
  return out;
}

const pr = gh(`repos/${repo}/pulls/${prNumber}`);
const prLabels = (pr.labels ?? []).map((l) => l.name);

const refs = parseClosingRefs(pr.body ?? '');
let issue = null;
if (refs.length === 1) {
  try {
    const raw = gh(`repos/${repo}/issues/${refs[0]}`);
    const labels = (raw.labels ?? []).map((l) => l.name);
    const comments = ghPaged(`repos/${repo}/issues/${refs[0]}/comments`).map((c) => ({
      author: c.user?.login ?? '',
      createdAt: c.created_at,
      body: c.body ?? '',
    }));
    issue = {
      number: refs[0],
      exists: !raw.pull_request, // a PR number is not an issue
      agentTask: labels.includes('agent-task'),
      labels,
      riskLabels: labels.filter((l) => /^risk:R[0-3]$/.test(l)),
      builderLabels: labels.filter((l) => /^builder:(claude|codex)$/.test(l)),
      body: raw.body ?? '',
      comments,
    };
  } catch {
    issue = {
      number: refs[0],
      exists: false,
      agentTask: false,
      labels: [],
      riskLabels: [],
      builderLabels: [],
      body: '',
      comments: [],
    };
  }
}

// Reviews (Codex technical markers + owner approvals) — commit_id binds them.
const reviews = ghPaged(`repos/${repo}/pulls/${prNumber}/reviews`).map((r) => ({
  author: r.user?.login ?? '',
  state: r.state,
  commitId: r.commit_id,
  createdAt: r.submitted_at,
  body: r.body ?? '',
}));

// PR issue-comments (Claude + Gemini markers posted by the review workflows).
const prComments = ghPaged(`repos/${repo}/issues/${prNumber}/comments`).map((c) => ({
  author: c.user?.login ?? '',
  createdAt: c.created_at,
  body: c.body ?? '',
}));

// Unresolved review threads.
const [owner, name] = repo.split('/');
const threads = JSON.parse(
  execFileSync(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      'query=query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved}}}}}',
      '-f',
      `o=${owner}`,
      '-f',
      `n=${name}`,
      '-F',
      `pr=${prNumber}`,
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  ),
);
const unresolvedThreads = (
  threads.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
).filter((t) => t.isResolved === false).length;

const prBuilder = prLabels.filter((l) => /^builder:(claude|codex)$/.test(l));
// Codex markers arrive in review bodies, Claude/Gemini markers in PR
// comments; both sources are merged and time-ordered so the evaluator's
// latest-valid-verdict-wins rule is exact, and wrong-identity attempts
// from either source are diagnosed.
const byCreatedAt = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
const techCandidates = [...reviews, ...prComments].sort(byCreatedAt);

const state = {
  pr: {
    number: prNumber,
    headSha: (pr.head?.sha ?? '').toLowerCase(),
    riskLabels: prLabels.filter((l) => /^risk:R[0-3]$/.test(l)),
    builderLabels: prBuilder,
    author: pr.user?.login ?? '',
    draft: Boolean(pr.draft),
    fork: (pr.head?.repo?.full_name ?? repo) !== repo,
  },
  prBody: pr.body ?? '',
  issue,
  techEvidence: { candidates: techCandidates },
  geminiEvidence: { candidates: prComments },
  ownerReviews: reviews.map((r) => ({ author: r.author, state: r.state, commitId: r.commitId })),
  unresolvedThreads,
  config: {
    ownerLogin: OWNER_LOGIN,
    codexLogin: CODEX_LOGIN,
    trustedMarkerAuthors: TRUSTED_MARKER_AUTHORS,
    authorizedRevisionAuthors: AUTHORIZED_REVISION_AUTHORS,
    claudeSideAuthors: CLAUDE_SIDE_AUTHORS,
  },
};

const json = JSON.stringify(state, null, 2);
if (args.out) writeFileSync(args.out, json);
else process.stdout.write(json);
