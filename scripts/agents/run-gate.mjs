#!/usr/bin/env node
/**
 * Gate CLI over the pure evaluator: reads a normalized state JSON, runs
 * evaluate() in the given mode, prints the reasons, exits 0 on PASS and
 * 1 on BLOCK. Also exposes the contract revision and linked issue for
 * workflow steps (--print-context).
 *
 * Usage: node scripts/agents/run-gate.mjs --state /tmp/state.json --mode policy|technical|acceptance|full
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { evaluate, computeContractRevision, resolveVerdict, MARKERS } from './evaluator.mjs';

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
  const rev = state.issue
    ? computeContractRevision({
        issueNumber: state.issue.number,
        issueBody: state.issue.body,
        issueComments: state.issue.comments,
        authorizedAuthors: cfg.authorizedRevisionAuthors,
      })
    : { revision: null };
  const builder = state.pr.builderLabels.length === 1 ? state.pr.builderLabels[0] : '';
  // A PR is agent-governed when it carries agent labels OR closes an
  // agent-task issue — removing a label is not an escape hatch.
  const governed =
    state.pr.riskLabels.length > 0 ||
    state.pr.builderLabels.length > 0 ||
    Boolean(state.issue?.agentTask);
  const target =
    rev.revision !== null && state.issue
      ? {
          pr: state.pr.number,
          issue: state.issue.number,
          headSha: state.pr.headSha,
          contractRevision: rev.revision,
        }
      : null;
  const verdictOf = (candidates, markerName, expectedAuthors, forbiddenAuthors) =>
    target
      ? (resolveVerdict({ candidates, markerName, expectedAuthors, forbiddenAuthors, target })
          .verdict ?? 'none')
      : 'none';
  const techVerdict =
    builder === 'builder:claude'
      ? verdictOf(
          state.techEvidence?.candidates,
          MARKERS.codex,
          [cfg.codexLogin],
          cfg.claudeSideAuthors,
        )
      : builder === 'builder:codex'
        ? verdictOf(state.techEvidence?.candidates, MARKERS.claude, cfg.trustedMarkerAuthors, [
            state.pr.author,
            cfg.codexLogin,
          ])
        : 'none';
  const geminiVerdict = verdictOf(
    state.geminiEvidence?.candidates,
    MARKERS.gemini,
    cfg.trustedMarkerAuthors,
    [state.pr.author],
  );
  const ctx = {
    governed: governed ? 'true' : 'false',
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
