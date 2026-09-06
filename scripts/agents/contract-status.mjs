#!/usr/bin/env node
/**
 * Authoritative contract status for ONE ISSUE, computed with the SAME
 * canonical parser/provenance the evaluator and build admission use —
 * never a substring probe. Text that merely CONTAINS a marker name, a
 * malformed marker, a wrong-scheme marker, an unsigned bot marker, a
 * wrong-issue marker, or an invalid signature is NOT a baseline and can
 * never suppress creation of the real one; conversely, conflicting
 * AUTHORIZED history is invalid and fails closed.
 *
 * Prints key=value lines (and mirrors them to GITHUB_OUTPUT):
 *   history_complete, baseline_found, invalid, revision, amended,
 *   labels_diverged, pending_freeze_target, contract_ok, risk, builder,
 *   contract_body_sha256, contract_snapshot_sha256
 *
 *   GH_TOKEN=… node scripts/agents/contract-status.mjs --repo o/n --issue 44
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeContractRevision } from './evaluator.mjs';
import { ghPagedComplete } from './gh-lib.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const repo = args.repo;
const issue = Number(args.issue);
if (!repo || !Number.isInteger(issue)) {
  console.error('Usage: contract-status.mjs --repo owner/name --issue N');
  process.exit(2);
}

const raw = JSON.parse(
  execFileSync('gh', ['api', `repos/${repo}/issues/${issue}`], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }),
);
const history = ghPagedComplete(`repos/${repo}/issues/${issue}/comments`);

const keyPath = join(dirname(fileURLToPath(import.meta.url)), 'keys', 'contract-authority.pub.pem');
const rev = history.complete
  ? computeContractRevision({
      issueNumber: issue,
      issueBody: raw.body ?? '',
      issueComments: history.items.map((c) => ({
        author: c.user?.login ?? '',
        createdAt: c.created_at,
        id: c.id,
        body: c.body ?? '',
      })),
      issueLabels: (raw.labels ?? []).map((l) => l.name),
      ownerLogin: process.env.OWNER_LOGIN || 'AngeloAkuhwa',
      contractAuthorityKey: existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : null,
    })
  : { revision: null, baselineFound: false, invalid: 'comment history unprovable', amended: false };

const contractOk =
  history.complete &&
  rev.revision !== null &&
  rev.baselineFound === true &&
  !rev.invalid &&
  rev.amended !== true &&
  rev.labelsDiverged !== true &&
  !rev.pendingFreeze;

const out = {
  history_complete: history.complete ? 'true' : 'false',
  baseline_found: rev.baselineFound ? 'true' : 'false',
  invalid: rev.invalid ?? '',
  revision: rev.revision ?? '',
  amended: rev.amended ? 'true' : 'false',
  labels_diverged: rev.labelsDiverged ? 'true' : 'false',
  pending_freeze_target: rev.pendingFreeze?.targetRevision ?? '',
  contract_ok: contractOk ? 'true' : 'false',
  risk: rev.expectedRisk ?? '',
  builder: rev.expectedBuilder ?? '',
  contract_body_sha256: rev.expectedHash ?? '',
  contract_snapshot_sha256: rev.snapshotHash ?? '',
};
for (const [k, v] of Object.entries(out)) {
  console.log(`${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}
