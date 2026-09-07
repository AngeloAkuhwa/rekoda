#!/usr/bin/env node
/**
 * The owner's amendment pre-authorization helper, run from TRUSTED MAIN:
 * prints the exact proposed contract snapshot for an issue so the owner
 * can review it and pass its hash into the amendment dispatch. What the
 * owner authorizes is what the authority signs — the workflow's plan
 * job re-computes and compares this hash, and the signer refuses at the
 * last instant if anything (body, risk, builder) drifted after
 * authorization.
 *
 *   GH_TOKEN=… node scripts/agents/amendment-context.mjs --repo o/n --issue 44 [--target-revision 2]
 *
 * Prints key=value lines: issue, from_revision, target_revision, risk,
 * builder, body_sha256, expected_snapshot_hash — plus the ready-to-run
 * dispatch command.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeContractRevision,
  contractSnapshotHash,
  normalizeBody,
  sha256Hex,
} from './evaluator.mjs';
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
  console.error('Usage: amendment-context.mjs --repo owner/name --issue N [--target-revision R]');
  process.exit(2);
}

const raw = JSON.parse(
  execFileSync('gh', ['api', `repos/${repo}/issues/${issue}`], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }),
);
const labels = (raw.labels ?? []).map((l) => l.name);
const risks = labels.filter((l) => /^risk:R[0-3]$/.test(l));
const builders = labels.filter((l) => /^builder:(claude|codex)$/.test(l));
if (risks.length !== 1 || builders.length !== 1) {
  console.error(
    `::error::Issue #${issue} must carry exactly one risk and one builder label (found risk: [${risks.join(', ')}], builder: [${builders.join(', ')}]).`,
  );
  process.exit(1);
}

const history = ghPagedComplete(`repos/${repo}/issues/${issue}/comments`);
if (!history.complete) {
  console.error('::error::Comment history could not be proven complete — no amendment context.');
  process.exit(1);
}
const keyPath = join(dirname(fileURLToPath(import.meta.url)), 'keys', 'contract-authority.pub.pem');
const rev = computeContractRevision({
  issueNumber: issue,
  issueBody: raw.body ?? '',
  issueComments: history.items.map((c) => ({
    author: c.user?.login ?? '',
    createdAt: c.created_at,
    id: c.id,
    body: c.body ?? '',
  })),
  issueLabels: labels,
  ownerLogin: process.env.OWNER_LOGIN || 'AngeloAkuhwa',
  contractAuthorityKey: existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : null,
});
if (rev.revision === null || rev.invalid) {
  console.error(
    `::error::Issue #${issue} has no valid current revision (${rev.invalid ?? 'no authorized baseline'}); amend only a valid contract.`,
  );
  process.exit(1);
}

const fromRevision = rev.revision;
const targetRevision = args['target-revision'] ? Number(args['target-revision']) : fromRevision + 1;
if (targetRevision !== fromRevision + 1) {
  console.error(
    `::error::Target revision ${targetRevision} does not continue the current revision ${fromRevision}.`,
  );
  process.exit(1);
}

const bodySha256 = sha256Hex(normalizeBody(raw.body ?? ''));
const expected = contractSnapshotHash({
  issue,
  revision: targetRevision,
  risk: risks[0],
  builder: builders[0],
  bodySha256,
});

const out = {
  issue,
  from_revision: fromRevision,
  target_revision: targetRevision,
  risk: risks[0],
  builder: builders[0],
  body_sha256: bodySha256,
  expected_snapshot_hash: expected,
};
for (const [k, v] of Object.entries(out)) {
  console.log(`${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}
console.log('');
console.log('Review the CURRENT issue body and the risk/builder above — that IS what');
console.log('will be signed. If it is what you intend, dispatch the amendment with:');
console.log('');
console.log(
  `  gh workflow run agent-contract-authority.yml --repo ${repo} --ref main \\\n    -f mode=revision -f issue=${issue} -f revision=${targetRevision} \\\n    -f reason="<why the contract changed>" \\\n    -f expected_snapshot_hash=${expected}`,
);
