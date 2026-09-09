#!/usr/bin/env node
/**
 * The single trusted publisher operation (docs/AUTONOMOUS-ENGINEERING.md
 * §6): reads the UNTRUSTED unsigned verdict handed over by the AI runner
 * (as bounded structured data — never an extracted archive),
 * independently validates every field against the FRESH trusted target
 * values passed on the command line (schema, PR, issue, HEAD, revision,
 * snapshot, refresh generation, reviewer role), then ISSUES the V4
 * evidence: inside the caller's per-(PR, role) issuance lane it fetches
 * the COMPLETE existing role evidence, computes the next monotonic
 * EVIDENCE_SEQUENCE itself (the AI supplies no issuance metadata),
 * generates a fresh EVIDENCE_ID, and signs that exact in-memory
 * canonical payload with the role key from --sign-env — validation,
 * issuance, and signing are one atomic operation over one in-memory
 * object. Any mismatch, malformation, or unprovable evidence history
 * exits 1: a missing/invalid verdict is a BLOCK, and the artifact can
 * never choose its own target, sequence, or generation.
 *
 *   node scripts/agents/sign-evidence.mjs --file $RUNNER_TEMP/verdict.json \
 *     --marker REKODA_CLAUDE_APPROVAL --repo o/n --pr 55 --issue 44 \
 *     --head <sha> --revision 1 --snapshot-hash <sha256> \
 *     --refresh-generation 0 --sign-env CLAUDE_REVIEWER_SIGNING_KEY > marker.md
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign as cryptoSign, randomBytes } from 'node:crypto';
import {
  canonicalVerdictPayload,
  buildVerdictMarkerLines,
  parseMarkers,
  verifySignature,
} from './evaluator.mjs';
import { ghPagedComplete } from './gh-lib.mjs';

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
if (!args.repo || !args.repo.includes('/'))
  fail('--repo owner/name is required: the signer fetches the existing role evidence itself.');

// The FRESH trusted target (independently re-resolved by the caller),
// including the ACTIVE authorized contract SNAPSHOT hash and the
// CURRENT durable refresh generation for this role.
const expected = {
  pr: Number(args.pr),
  issue: Number(args.issue),
  head: String(args.head ?? '').toLowerCase(),
  revision: Number(args.revision),
  snapshotHash: String(args['snapshot-hash'] ?? '').toLowerCase(),
  refreshGeneration: Number(args['refresh-generation']),
};
if (!/^[0-9a-f]{40}$/.test(expected.head)) fail('Expected HEAD SHA is not 40-hex.');
if (!/^[0-9a-f]{64}$/.test(expected.snapshotHash))
  fail(
    'Expected contract snapshot hash (--snapshot-hash) is not 64-hex — an unauthorized/amended/diverged contract is never signed.',
  );
if (
  !Number.isInteger(expected.pr) ||
  !Number.isInteger(expected.issue) ||
  !Number.isInteger(expected.revision)
)
  fail('Expected PR/issue/revision are not integers.');
if (!Number.isInteger(expected.refreshGeneration) || expected.refreshGeneration < 0)
  fail(
    'Expected --refresh-generation is not a non-negative integer — evidence must bind the current durable refresh generation.',
  );

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
if (String(doc.contract_snapshot_sha256 ?? '').toLowerCase() !== expected.snapshotHash)
  fail(
    `Verdict names contract snapshot ${doc.contract_snapshot_sha256}, expected ${expected.snapshotHash} — the reviewer must have assessed the exact authorized contract snapshot.`,
  );
if (Number(doc.refresh_generation) !== expected.refreshGeneration)
  fail(
    `Verdict was produced under refresh generation ${doc.refresh_generation}, but the current durable generation is ${expected.refreshGeneration} — a newer forced refresh supersedes this review; not signing.`,
  );
if (doc.verdict !== 'APPROVE' && doc.verdict !== 'BLOCK')
  fail(`Verdict must be APPROVE or BLOCK, got: ${doc.verdict}.`);
if (!Array.isArray(doc.findings)) fail('Verdict must carry a findings array (empty when none).');

// ISSUANCE (X2): the signer — inside the caller's per-(PR, role)
// concurrency lane — reads the COMPLETE existing role evidence and
// creates the next monotonic sequence itself. Signatures are verified
// with the public half of OUR OWN signing key, so only evidence this
// authority actually issued advances the sequence; an unprovably
// complete history refuses issuance (a hidden later BLOCK must never be
// re-sequenced past).
let privateKey;
try {
  privateKey = createPrivateKey(keyPem);
} catch (e) {
  fail(`Signing key is not a valid private key: ${e.message}`);
}
const ownPublicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });

const comments = ghPagedComplete(`repos/${args.repo}/issues/${expected.pr}/comments`);
const reviews = ghPagedComplete(`repos/${args.repo}/pulls/${expected.pr}/reviews`);
if (!comments.complete || !reviews.complete)
  fail(
    'The existing evidence history could not be proven complete — refusing to issue a sequence over a partial view.',
  );
let maxSequence = 0;
for (const body of [
  ...comments.items.map((c) => c.body ?? ''),
  ...reviews.items.map((r) => r.body ?? ''),
]) {
  for (const m of parseMarkers(body, markerName)) {
    if (m.malformed) continue;
    if (m.pr !== expected.pr) continue;
    if (!verifySignature(canonicalVerdictPayload(m), m.signature, ownPublicPem)) continue;
    if (m.evidenceSequence > maxSequence) maxSequence = m.evidenceSequence;
  }
}

// Canonicalize from the EXPECTED values plus the signer's OWN issuance
// identity (never the artifact's claims) and sign that exact in-memory
// payload.
const m = {
  name: markerName,
  pr: expected.pr,
  issue: expected.issue,
  headSha: expected.head,
  contractRevision: expected.revision,
  contractSnapshotSha256: expected.snapshotHash,
  refreshGeneration: expected.refreshGeneration,
  evidenceSequence: maxSequence + 1,
  evidenceId: randomBytes(16).toString('hex'),
  verdict: doc.verdict,
};
const canonical = canonicalVerdictPayload(m);
let signature;
try {
  signature = cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
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
