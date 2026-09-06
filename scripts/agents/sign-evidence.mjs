#!/usr/bin/env node
/**
 * The SEPARATE deterministic signing step (docs/AUTONOMOUS-ENGINEERING.md
 * §6): reads the already-validated canonical payload written by
 * validate-verdict.mjs, signs it with the role-specific Ed25519 private
 * key from the environment variable named by --sign-env, and prints the
 * complete marker block. This is the ONLY code path that touches a
 * reviewer signing key; the AI action has terminated before this runs
 * and never sees the key through input, env, file, or output.
 *
 *   node scripts/agents/sign-evidence.mjs --payload /tmp/payload.json \
 *     --sign-env CLAUDE_REVIEWER_SIGNING_KEY > /tmp/marker.md
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { canonicalVerdictPayload, SCHEME } from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

let p;
try {
  p = JSON.parse(readFileSync(args.payload, 'utf8'));
} catch (e) {
  fail(`No validated payload at ${args.payload}: ${e.message}.`);
}
if (!args['sign-env'])
  fail('A --sign-env is required: unsigned reviewer verdicts are not acceptable evidence.');
const keyPem = process.env[args['sign-env']];
if (!keyPem)
  fail(
    `Signing key env ${args['sign-env']} is empty — the reviewer environment is not configured; refusing to publish an unsigned verdict.`,
  );

let signature;
try {
  signature = cryptoSign(
    null,
    Buffer.from(
      canonicalVerdictPayload({
        name: p.markerName,
        pr: p.pr,
        issue: p.issue,
        headSha: p.head_sha,
        contractRevision: p.contract_revision,
        verdict: p.verdict,
      }),
      'utf8',
    ),
    createPrivateKey(keyPem),
  ).toString('base64');
} catch (e) {
  fail(`Signing failed: ${e.message}`);
}

console.log(
  [
    '```',
    p.markerName,
    `SCHEME: ${SCHEME}`,
    `PR: ${p.pr}`,
    `ISSUE: ${p.issue}`,
    `HEAD_SHA: ${p.head_sha}`,
    `CONTRACT_REVISION: ${p.contract_revision}`,
    `VERDICT: ${p.verdict}`,
    `SIGNATURE: ${signature}`,
    '```',
    '',
    p.findings,
  ].join('\n'),
);
