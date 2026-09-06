#!/usr/bin/env node
/**
 * Deterministic validation of an AI reviewer's structured verdict file
 * (docs/AUTONOMOUS-ENGINEERING.md §6). Malformed = BLOCK; wrong PR,
 * issue, HEAD, or contract revision = BLOCK. This step holds NO signing
 * key: on success it writes a canonical payload file for the SEPARATE
 * signing step (scripts/agents/sign-evidence.mjs) — the AI step has
 * already terminated before any key exists in any process environment.
 *
 *   node scripts/agents/validate-verdict.mjs --file /tmp/review.json \
 *     --marker REKODA_CLAUDE_APPROVAL --pr 55 --issue 44 --head <sha> \
 *     --revision 1 --out /tmp/payload.json
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

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

let doc;
try {
  doc = JSON.parse(readFileSync(args.file, 'utf8'));
} catch (e) {
  fail(
    `No parseable verdict file at ${args.file}: ${e.message}. A missing or malformed verdict is a BLOCK.`,
  );
}

const expected = {
  pr: Number(args.pr),
  issue: Number(args.issue),
  head_sha: String(args.head).toLowerCase(),
  contract_revision: Number(args.revision),
};
if (!/^[0-9a-f]{40}$/.test(expected.head_sha)) fail('Expected HEAD SHA is not 40-hex.');

if (Number(doc.pr) !== expected.pr) fail(`Verdict names PR ${doc.pr}, expected ${expected.pr}.`);
if (Number(doc.issue) !== expected.issue)
  fail(`Verdict names issue ${doc.issue}, expected ${expected.issue}.`);
if (String(doc.head_sha).toLowerCase() !== expected.head_sha)
  fail(
    `Verdict names HEAD ${doc.head_sha}, expected ${expected.head_sha} — verdicts bind to the exact current HEAD.`,
  );
if (Number(doc.contract_revision) !== expected.contract_revision)
  fail(
    `Verdict names contract revision ${doc.contract_revision}, expected ${expected.contract_revision}.`,
  );
if (doc.verdict !== 'APPROVE' && doc.verdict !== 'BLOCK')
  fail(`Verdict must be APPROVE or BLOCK, got: ${doc.verdict}.`);
if (!Array.isArray(doc.findings)) fail('Verdict must carry a findings array (empty when none).');

const markerName = args.marker;
if (!/^REKODA_(CLAUDE|GEMINI|CODEX)_APPROVAL$/.test(markerName))
  fail(`Unknown marker name ${markerName}.`);

const findings =
  doc.findings.length === 0
    ? 'No blocking findings.'
    : doc.findings.map((f) => `- ${String(f).replace(/\n/g, ' ').slice(0, 500)}`).join('\n');

writeFileSync(
  args.out ?? '/tmp/rekoda-evidence-payload.json',
  JSON.stringify(
    {
      markerName,
      pr: expected.pr,
      issue: expected.issue,
      head_sha: expected.head_sha,
      contract_revision: expected.contract_revision,
      verdict: doc.verdict,
      findings,
    },
    null,
    2,
  ),
);
console.log(
  `Validated ${markerName} ${doc.verdict} for PR #${expected.pr} at ${expected.head_sha}.`,
);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${doc.verdict}\n`);
