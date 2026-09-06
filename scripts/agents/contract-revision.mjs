#!/usr/bin/env node
/**
 * Contract-revision helper (docs/AUTONOMOUS-ENGINEERING.md §6): computes
 * the body hash of an issue and prints (or posts) the baseline/revision
 * marker. Provenance rules (enforced by the evaluator):
 *   - a marker AUTHORED by the owner's human account is authorized as-is;
 *   - a marker posted by any workflow is authorized only when SIGNED by
 *     the contract-authority key (--sign-env, available only in the
 *     agent-contract-authority environment).
 * The builder holds neither, by design.
 *
 *   node scripts/agents/contract-revision.mjs --repo o/n --issue 44 --baseline [--post] [--sign-env NAME]
 *   node scripts/agents/contract-revision.mjs --repo o/n --issue 44 --revision 2 --reason "scope change" [--post] [--sign-env NAME]
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { normalizeBody, sha256Hex, canonicalContractPayload } from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? 'true'] : null))
    .filter(Boolean),
);
const repo = args.repo;
const issue = Number(args.issue);
if (!repo || !Number.isInteger(issue)) {
  console.error(
    'Usage: contract-revision.mjs --repo owner/name --issue N (--baseline | --revision K --reason "…") [--post] [--sign-env NAME]',
  );
  process.exit(2);
}

const raw = JSON.parse(
  execFileSync('gh', ['api', `repos/${repo}/issues/${issue}`], { encoding: 'utf8' }),
);
const hash = sha256Hex(normalizeBody(raw.body ?? ''));

let m;
if (args.baseline === 'true') {
  m = { kind: 'REKODA_CONTRACT_BASELINE', issue, revision: 1, bodySha256: hash, reason: '' };
} else {
  const rev = Number(args.revision);
  if (!Number.isInteger(rev) || rev < 2) {
    console.error('A revision marker needs --revision K (K >= 2) and --reason.');
    process.exit(2);
  }
  const reason = String(args.reason ?? '')
    .replace(/\n/g, ' ')
    .trim();
  if (!reason) {
    console.error('A revision marker requires a non-empty --reason.');
    process.exit(2);
  }
  m = { kind: 'REKODA_CONTRACT_REVISION', issue, revision: rev, bodySha256: hash, reason };
}

const lines = [
  m.kind,
  `ISSUE: ${m.issue}`,
  `REVISION: ${m.revision}`,
  `BODY_SHA256: ${m.bodySha256}`,
];
if (m.kind === 'REKODA_CONTRACT_REVISION') lines.push(`REASON: ${m.reason}`);
if (args['sign-env']) {
  const keyPem = process.env[args['sign-env']];
  if (!keyPem) {
    console.error(`Signing key env ${args['sign-env']} is empty.`);
    process.exit(1);
  }
  const sig = cryptoSign(
    null,
    Buffer.from(canonicalContractPayload(m), 'utf8'),
    createPrivateKey(keyPem),
  ).toString('base64');
  lines.push(`SIGNATURE: ${sig}`);
}

const body = '```\n' + lines.join('\n') + '\n```';
if (args.post === 'true') {
  execFileSync(
    'gh',
    ['api', '--method', 'POST', `repos/${repo}/issues/${issue}/comments`, '-f', `body=${body}`],
    { encoding: 'utf8' },
  );
  console.log(`Posted to #${issue}:\n${lines.join('\n')}`);
} else {
  console.log(`Post this comment on #${issue} (or re-run with --post):\n\n${body}`);
}
