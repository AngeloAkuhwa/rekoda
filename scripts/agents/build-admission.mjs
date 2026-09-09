#!/usr/bin/env node
/**
 * The no-secret builder-admission preflight (docs/AUTONOMOUS-ENGINEERING.md
 * §3): re-fetches live issue and lane state and runs the pure
 * evaluators — under the repository-wide `rekoda-implementation-lane`
 * concurrency group this constitutes the atomic admission decision.
 *
 *   --phase admission (default): full evaluateBuildAdmission() — used
 *     by the admission AUTHORITY before it signs the lane claim,
 *     transitions the labels, and dispatches the builder. Includes:
 *     EXHAUSTIVE, deduplicated label-lane enumeration (an unprovably
 *     complete search blocks), durable LEASE occupancy over every open
 *     agent-task issue (a signed claim a compromised builder hid by
 *     removing status labels still occupies the lane), and the R3
 *     owner-decision requirement bound to the active snapshot.
 *   --phase start: evaluateBuildStart() — the builder preflight's
 *     post-claim verification: the signed lane claim must exist (only
 *     the authority can mint it), the issue must be status:building,
 *     the contract still valid. No label transition here.
 *
 *   GH_TOKEN=… node scripts/agents/build-admission.mjs --repo o/n \
 *     --issue 60 --builder builder:claude [--phase admission|start]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateBuildAdmission,
  evaluateBuildStart,
  computeContractRevision,
  resolveOwnerDecision,
  resolveLaneLease,
} from './evaluator.mjs';
import { gh, ghPagedComplete } from './gh-lib.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? 'true'] : null))
    .filter(Boolean),
);
const repo = args.repo;
const issueNumber = Number(args.issue);
const requiredBuilder = args.builder ?? 'builder:claude';
const phase = args.phase ?? 'admission';
if (!repo || !Number.isInteger(issueNumber) || !['admission', 'start'].includes(phase)) {
  console.error(
    'Usage: build-admission.mjs --repo o/n --issue N [--builder builder:claude|builder:codex] [--phase admission|start]',
  );
  process.exit(2);
}

const OWNER_LOGIN = process.env.OWNER_LOGIN || 'AngeloAkuhwa';
const keyPath = join(dirname(fileURLToPath(import.meta.url)), 'keys', 'contract-authority.pub.pem');
const authorityPublicKey = existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : null;

const toComments = (items) =>
  items.map((c) => ({
    author: c.user?.login ?? '',
    createdAt: c.created_at,
    id: c.id,
    body: c.body ?? '',
  }));

let issue = null;
try {
  const raw = gh(`repos/${repo}/issues/${issueNumber}`);
  const labels = (raw.labels ?? []).map((l) => l.name);
  issue = {
    number: issueNumber,
    exists: !raw.pull_request,
    state: raw.state,
    agentTask: labels.includes('agent-task'),
    labels,
    riskLabels: labels.filter((l) => /^risk:R[0-3]$/.test(l)),
    builderLabels: labels.filter((l) => /^builder:(claude|codex)$/.test(l)),
    body: raw.body ?? '',
  };
} catch {
  issue = null;
}

// Baseline-before-admission: the contract computed over the
// EXHAUSTIVELY paginated comment history; unprovable → invalid.
let contract = { baselineFound: false, invalid: null, amended: false };
let issueComments = [];
if (issue) {
  const history = ghPagedComplete(`repos/${repo}/issues/${issueNumber}/comments`);
  if (!history.complete) {
    contract = {
      baselineFound: false,
      invalid: 'comment history could not be proven complete',
      amended: false,
    };
  } else {
    issueComments = toComments(history.items);
    contract = computeContractRevision({
      issueNumber,
      issueBody: issue.body,
      issueComments,
      issueLabels: issue.labels,
      ownerLogin: OWNER_LOGIN,
      contractAuthorityKey: authorityPublicKey,
    });
  }
}

if (phase === 'start') {
  const lease = issue
    ? resolveLaneLease({ issueComments, issueNumber, authorityKey: authorityPublicKey })
    : { active: false };
  const result = evaluateBuildStart({ issue, requiredBuilder, lease, contract });
  for (const r of result.reasons) console.error(`::error::[${r.code}] ${r.message}`);
  if (!result.start) {
    console.error(`::error::Builder start refused for #${issueNumber}.`);
    process.exit(1);
  }
  console.log(
    `Builder start verified for #${issueNumber} (${requiredBuilder}): claimed lane, valid contract.`,
  );
  process.exit(0);
}

// LANE ENUMERATION, two layers, both fail-closed:
//   1. the label projection (status:building / status:in-review),
//      paginated to exhaustion and DEDUPLICATED across labels;
//   2. the durable lease: every OPEN agent-task issue's comments are
//      scanned for an active authority-signed claim — a builder that
//      stripped status labels cannot make its leased lane look free.
let laneSearchComplete = true;
const laneMap = new Map();
for (const label of ['status:building', 'status:in-review']) {
  const paged = ghPagedComplete(
    `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`,
  );
  if (!paged.complete) laneSearchComplete = false;
  for (const i of paged.items) {
    if (i.pull_request) continue; // PRs carry status labels too; lanes are issues
    if (!laneMap.has(i.number)) laneMap.set(i.number, { issue: i.number, status: label });
  }
}
const agentIssues = ghPagedComplete(`repos/${repo}/issues?state=open&labels=agent-task`);
if (!agentIssues.complete) laneSearchComplete = false;
else {
  for (const i of agentIssues.items) {
    if (i.pull_request) continue;
    if (laneMap.has(i.number) || i.number === issueNumber) continue;
    const h = ghPagedComplete(`repos/${repo}/issues/${i.number}/comments`);
    if (!h.complete) {
      laneSearchComplete = false;
      continue;
    }
    const lease = resolveLaneLease({
      issueComments: toComments(h.items),
      issueNumber: i.number,
      authorityKey: authorityPublicKey,
    });
    if (lease.active) laneMap.set(i.number, { issue: i.number, status: 'lease' });
  }
}
const lanes = [...laneMap.values()];

// R3 owner decision bound to the ACTIVE snapshot (X7).
const ownerDecision = issue
  ? resolveOwnerDecision({
      issueComments,
      issueNumber,
      snapshotHash: contract.snapshotHash ?? null,
      ownerLogin: OWNER_LOGIN,
    })
  : { approved: false };

const result = evaluateBuildAdmission({
  issue,
  requiredBuilder,
  openLanes: lanes,
  laneSearchComplete,
  contract,
  ownerDecision,
});
for (const r of result.reasons) console.error(`::error::[${r.code}] ${r.message}`);
if (!result.admit) {
  console.error(`::error::Builder admission refused for #${issueNumber}.`);
  process.exit(1);
}
console.log(`Builder admission granted for #${issueNumber} (${requiredBuilder}).`);
