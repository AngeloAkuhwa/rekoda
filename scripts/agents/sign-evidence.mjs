#!/usr/bin/env node
/**
 * The single trusted publisher operation (docs/AUTONOMOUS-ENGINEERING.md
 * §6): reads the UNTRUSTED unsigned verdict produced by the AI runner,
 * independently validates every field against the FRESH trusted target
 * values passed on the command line (schema, PR, issue, HEAD, revision,
 * reviewer role), canonicalizes, and signs that exact in-memory payload
 * with the role key from --sign-env — validation and signing are one
 * atomic operation over one in-memory object; no intermediate
 * "validated payload" file exists to be swapped between steps. Any
 * mismatch or malformation exits 1: a missing/invalid verdict is a
 * BLOCK, and the artifact can never choose its own target.
 *
 *   node scripts/agents/sign-evidence.mjs --file unsigned-verdict.json \
 *     --marker REKODA_CLAUDE_APPROVAL --pr 55 --issue 44 --head <sha> \
 *     --revision 1 --contract-hash <sha256-of-active-contract-body> \
 *     --sign-env CLAUDE_REVIEWER_SIGNING_KEY > marker.md
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { canonicalVerdictPayload, buildVerdictMarkerLines } from './evaluator.mjs';

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

const markerName = args.marker;
if (!/^REKODA_(CLAUDE|GEMINI)_APPROVAL$/.test(markerName ?? ''))
  fail(`Unknown reviewer marker name ${markerName}.`);
if (!args['sign-env'])
  fail('A --sign-env is required: unsigned reviewer verdicts are not acceptable evidence.');
const keyPem = process.env[args['sign-env']];
if (!keyPem)
  fail(
    `Signing key env ${args['sign-env']} is empty — the reviewer environment is not configured; refusing to publish an unsigned verdict.`,
  );

// The FRESH trusted target (independently re-resolved by the caller),
// including the ACTIVE authorized contract snapshot hash — the exact
// contract the reviewer was given to assess.
const expected = {
  pr: Number(args.pr),
  issue: Number(args.issue),
  head: String(args.head ?? '').toLowerCase(),
  revision: Number(args.revision),
  contractHash: String(args['contract-hash'] ?? '').toLowerCase(),
};
if (!/^[0-9a-f]{40}$/.test(expected.head)) fail('Expected HEAD SHA is not 40-hex.');
if (!/^[0-9a-f]{64}$/.test(expected.contractHash))
  fail(
    'Expected contract snapshot hash (--contract-hash) is not 64-hex — an unauthorized/amended contract is never signed.',
  );
if (
  !Number.isInteger(expected.pr) ||
  !Number.isInteger(expected.issue) ||
  !Number.isInteger(expected.revision)
)
  fail('Expected PR/issue/revision are not integers.');

// The UNTRUSTED unsigned verdict.
let doc;
try {
  doc = JSON.parse(readFileSync(args.file, 'utf8'));
} catch (e) {
  fail(
    `No parseable verdict file at ${args.file}: ${e.message}. A missing or malformed verdict is a BLOCK.`,
  );
}
if (Number(doc.pr) !== expected.pr) fail(`Verdict names PR ${doc.pr}, expected ${expected.pr}.`);
if (Number(doc.issue) !== expected.issue)
  fail(`Verdict names issue ${doc.issue}, expected ${expected.issue}.`);
if (String(doc.head_sha).toLowerCase() !== expected.head)
  fail(
    `Verdict names HEAD ${doc.head_sha}, expected ${expected.head} — verdicts bind to the exact current HEAD.`,
  );
if (Number(doc.contract_revision) !== expected.revision)
  fail(`Verdict names contract revision ${doc.contract_revision}, expected ${expected.revision}.`);
if (String(doc.contract_body_sha256 ?? '').toLowerCase() !== expected.contractHash)
  fail(
    `Verdict names contract snapshot ${doc.contract_body_sha256}, expected ${expected.contractHash} — the reviewer must have assessed the exact authorized contract snapshot.`,
  );
if (doc.verdict !== 'APPROVE' && doc.verdict !== 'BLOCK')
  fail(`Verdict must be APPROVE or BLOCK, got: ${doc.verdict}.`);
if (!Array.isArray(doc.findings)) fail('Verdict must carry a findings array (empty when none).');

// Canonicalize from the EXPECTED values (never the artifact's own claims)
// and sign that exact in-memory payload.
const m = {
  name: markerName,
  pr: expected.pr,
  issue: expected.issue,
  headSha: expected.head,
  contractRevision: expected.revision,
  contractBodySha256: expected.contractHash,
  verdict: doc.verdict,
};
const canonical = canonicalVerdictPayload(m);
let signature;
try {
  signature = cryptoSign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(keyPem)).toString(
    'base64',
  );
} catch (e) {
  fail(`Signing failed: ${e.message}`);
}

const findings =
  doc.findings.length === 0
    ? 'No blocking findings.'
    : doc.findings.map((f) => `- ${String(f).replace(/\n/g, ' ').slice(0, 500)}`).join('\n');

// Rendered through the SAME shared generator the parser is tested
// against — what is published is exactly what parseMarkers accepts.
console.log(['```', ...buildVerdictMarkerLines(m, signature), '```', '', findings].join('\n'));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${doc.verdict}\n`);
