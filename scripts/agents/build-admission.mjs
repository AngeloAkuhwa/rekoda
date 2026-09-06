#!/usr/bin/env node
/**
 * The no-secret builder-admission preflight (docs/AUTONOMOUS-ENGINEERING.md
 * §3): re-fetches live issue and lane state and runs the pure
 * evaluateBuildAdmission() — under the repository-wide
 * `rekoda-implementation-lane` concurrency group this constitutes the
 * atomic admission decision. With --transition it atomically claims the
 * lane (status:ready → status:building) so any subsequently admitted run
 * observes the occupied lane. Exit 0 = admitted; 1 = refused.
 *
 *   GH_TOKEN=… node scripts/agents/build-admission.mjs --repo o/n \
 *     --issue 60 --builder builder:claude [--transition]
 */
import { execFileSync } from 'node:child_process';
import { evaluateBuildAdmission } from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? 'true'] : null))
    .filter(Boolean),
);
const repo = args.repo;
const issueNumber = Number(args.issue);
const requiredBuilder = args.builder ?? 'builder:claude';
if (!repo || !Number.isInteger(issueNumber)) {
  console.error(
    'Usage: build-admission.mjs --repo o/n --issue N [--builder builder:claude|builder:codex] [--transition]',
  );
  process.exit(2);
}

function gh(pathname) {
  return JSON.parse(
    execFileSync('gh', ['api', pathname], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }),
  );
}

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
  };
} catch {
  issue = null;
}

const lanes = [];
for (const label of ['status:building', 'status:in-review']) {
  for (const i of gh(
    `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
  )) {
    if (i.pull_request) continue;
    lanes.push({ issue: i.number, status: label });
  }
}

const result = evaluateBuildAdmission({ issue, requiredBuilder, openLanes: lanes });
for (const r of result.reasons) console.error(`::error::[${r.code}] ${r.message}`);
if (!result.admit) {
  console.error(`::error::Builder admission refused for #${issueNumber}.`);
  process.exit(1);
}

if (args.transition === 'true') {
  // Claim the lane while still inside the concurrency lock: any later
  // admission re-fetches state and now observes status:building.
  execFileSync(
    'gh',
    [
      'issue',
      'edit',
      String(issueNumber),
      '--repo',
      repo,
      '--remove-label',
      'status:ready',
      '--add-label',
      'status:building',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'inherit'] },
  );
  console.log(`Lane claimed: #${issueNumber} → status:building.`);
}
console.log(`Builder admission granted for #${issueNumber} (${requiredBuilder}).`);
