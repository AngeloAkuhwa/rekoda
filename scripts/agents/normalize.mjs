#!/usr/bin/env node
/**
 * Normalizes live GitHub state for the pure policy evaluator
 * (scripts/agents/evaluator.mjs). All network access lives HERE; the
 * evaluator stays pure. Untrusted text (bodies, comments, reviews) is
 * carried as JSON values only — never through a shell; every gh call
 * uses execFileSync array arguments.
 *
 * Reads reviewer/contract-authority PUBLIC keys from the TRUSTED
 * checkout (scripts/agents/keys/) so verification needs no secrets.
 *
 * Usage:  GH_TOKEN=… node scripts/agents/normalize.mjs \
 *           --repo owner/name --pr 123 --out /tmp/state.json
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const KEYS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'keys');
const publicKey = (name) => {
  const p = join(KEYS_DIR, `${name}.pub.pem`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

function gh(pathname, extra = []) {
  return JSON.parse(
    execFileSync('gh', ['api', pathname, ...extra], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

function ghPaged(pathname, pages = 3) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const chunk = gh(`${pathname}${pathname.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...chunk);
    if (chunk.length < 100) break;
  }
  return out;
}

const pr = gh(`repos/${repo}/pulls/${prNumber}`);
const prLabels = (pr.labels ?? []).map((l) => l.name);

// STICKY enrollment: the immutable label-event history. Removing a label
// later cannot remove the 'labeled' event, so a PR that ever entered the
// agent lane can never look neutral again.
const events = ghPaged(`repos/${repo}/issues/${prNumber}/events`, 3);
const everLabeledAgent = events.some(
  (e) =>
    e.event === 'labeled' && /^(risk:R[0-3]|builder:(claude|codex))$/.test(e.label?.name ?? ''),
);

const refs = parseClosingRefs(pr.body ?? '');
let issue = null;
if (refs.length === 1) {
  try {
    const raw = gh(`repos/${repo}/issues/${refs[0]}`);
    const labels = (raw.labels ?? []).map((l) => l.name);
    const comments = ghPaged(`repos/${repo}/issues/${refs[0]}/comments`).map((c) => ({
      author: c.user?.login ?? '',
      createdAt: c.created_at,
      id: c.id,
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

// Reviews (Codex markers + owner approvals) — commit_id and state bind them.
const reviews = ghPaged(`repos/${repo}/pulls/${prNumber}/reviews`).map((r) => ({
  author: r.user?.login ?? '',
  kind: 'review',
  reviewState: r.state,
  state: r.state,
  commitId: r.commit_id,
  createdAt: r.submitted_at,
  id: r.id,
  body: r.body ?? '',
}));

// PR issue-comments (signed Claude/Gemini markers posted by the gates).
const prComments = ghPaged(`repos/${repo}/issues/${prNumber}/comments`).map((c) => ({
  author: c.user?.login ?? '',
  kind: 'comment',
  createdAt: c.created_at,
  id: c.id,
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

// Global WIP: every open issue occupying the single implementation lane.
const laneIssues = new Map();
for (const label of ['status:building', 'status:in-review']) {
  for (const i of ghPaged(
    `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`,
    1,
  )) {
    if (i.pull_request) continue; // PRs carry status labels too; lanes are issues
    laneIssues.set(i.number, { issue: i.number, status: label });
  }
}
const openLanes = [...laneIssues.values()];

// All markers can appear in either source; merged, the evaluator orders
// them deterministically by (createdAt, id) and provenance decides what
// counts.
const allEvidence = [...reviews, ...prComments];

const state = {
  pr: {
    number: prNumber,
    headSha: (pr.head?.sha ?? '').toLowerCase(),
    riskLabels: prLabels.filter((l) => /^risk:R[0-3]$/.test(l)),
    builderLabels: prLabels.filter((l) => /^builder:(claude|codex)$/.test(l)),
    author: pr.user?.login ?? '',
    draft: Boolean(pr.draft),
    fork: (pr.head?.repo?.full_name ?? repo) !== repo,
    everLabeledAgent,
  },
  prBody: pr.body ?? '',
  issue,
  techEvidence: { candidates: allEvidence },
  geminiEvidence: { candidates: allEvidence },
  ownerReviews: reviews.map((r) => ({ author: r.author, state: r.state, commitId: r.commitId })),
  unresolvedThreads,
  openLanes,
  config: {
    ownerLogin: OWNER_LOGIN,
    codexLogin: CODEX_LOGIN,
    publicKeys: {
      claudeReviewer: publicKey('claude-reviewer'),
      geminiReviewer: publicKey('gemini-reviewer'),
      contractAuthority: publicKey('contract-authority'),
    },
  },
};

const json = JSON.stringify(state, null, 2);
if (args.out) writeFileSync(args.out, json);
else process.stdout.write(json);
