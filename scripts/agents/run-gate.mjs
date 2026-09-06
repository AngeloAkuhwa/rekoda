#!/usr/bin/env node
/**
 * Gate CLI over the pure evaluator: reads a normalized state JSON, runs
 * evaluate() in the given mode, prints the reasons, exits 0 on PASS and
 * 1 on BLOCK. --print-context exposes constrained values (numbers,
 * enums, hex) for workflow steps — no untrusted free text ever reaches
 * a shell through these outputs.
 *
 * Usage: node scripts/agents/run-gate.mjs --state /tmp/state.json --mode policy|technical|acceptance|full
 */
import { readFileSync, appendFileSync } from 'node:fs';
import {
  evaluate,
  computeContractRevision,
  resolveVerdict,
  isGoverned,
  MARKERS,
} from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? 'true'] : null))
    .filter(Boolean),
);
const state = JSON.parse(readFileSync(args.state, 'utf8'));
const mode = args.mode ?? 'full';

if (args['print-context'] === 'true') {
  const cfg = state.config;
  const keys = cfg.publicKeys ?? {};
  const rev = state.issue
    ? computeContractRevision({
        issueNumber: state.issue.number,
        issueBody: state.issue.body,
        issueComments: state.issue.comments,
        ownerLogin: cfg.ownerLogin,
        contractAuthorityKey: keys.contractAuthority ?? null,
      })
    : { revision: null };
  const builder = state.pr.builderLabels.length === 1 ? state.pr.builderLabels[0] : '';
  const target =
    rev.revision !== null && state.issue
      ? {
          pr: state.pr.number,
          issue: state.issue.number,
          headSha: state.pr.headSha,
          contractRevision: rev.revision,
        }
      : null;
  const verdictOf = (candidates, markerName, provenance) =>
    target
      ? (resolveVerdict({ candidates, markerName, provenance, target }).verdict ?? 'none')
      : 'none';
  const techVerdict =
    builder === 'builder:claude'
      ? verdictOf(state.techEvidence?.candidates, MARKERS.codex, {
          kind: 'codex',
          login: cfg.codexLogin,
        })
      : builder === 'builder:codex'
        ? verdictOf(state.techEvidence?.candidates, MARKERS.claude, {
            kind: 'signature',
            publicKey: keys.claudeReviewer ?? null,
          })
        : 'none';
  const geminiVerdict = verdictOf(state.geminiEvidence?.candidates, MARKERS.gemini, {
    kind: 'signature',
    publicKey: keys.geminiReviewer ?? null,
  });
  const ctx = {
    governed: isGoverned(state) ? 'true' : 'false',
    issue: state.issue?.number ?? '',
    head_sha: state.pr.headSha,
    contract_revision: rev.revision ?? '',
    builder,
    draft: state.pr.draft ? 'true' : 'false',
    fork: state.pr.fork ? 'true' : 'false',
    tech_verdict: techVerdict,
    gemini_verdict: geminiVerdict,
  };
  for (const [k, v] of Object.entries(ctx)) {
    console.log(`${k}=${v}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  }
  process.exit(0);
}

const result = evaluate(state, mode);
for (const r of result.reasons) console.error(`::error::[${r.code}] ${r.message}`);
if (result.pass) {
  console.log(`Gate mode '${mode}' PASSED for PR #${state.pr.number} at ${state.pr.headSha}.`);
  process.exit(0);
}
console.error(
  `::error::Gate mode '${mode}' BLOCKED (${result.reasons.length} reason(s)) — docs/AUTONOMOUS-ENGINEERING.md §6.`,
);
process.exit(1);
