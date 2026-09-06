#!/usr/bin/env node
/**
 * Deterministic negative-case coverage for the merge-policy evaluator —
 * the behavioural evidence the frozen contract requires before activation
 * (docs/AUTONOMOUS-ENGINEERING.md §5.B). Every BLOCK case proves the gate
 * fails CLOSED; the positive cases prove a valid PR passes only with the
 * complete evidence. No network, no live GitHub.
 *
 * Run: node --test scripts/agents/evaluator.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKERS,
  evaluate,
  parseMarkers,
  parseClosingRefs,
  computeContractRevision,
  sha256Hex,
  normalizeBody,
  issueFormField,
} from './evaluator.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const OWNER = 'AngeloAkuhwa';
const CODEX = 'chatgpt-codex-connector[bot]';
const ACTIONS = 'github-actions[bot]';
const CLAUDE_BOT = 'claude[bot]';

const ISSUE_BODY = [
  '### Outcome',
  'A working thing.',
  '### Owner decision reference (if required and resolved)',
  '_No response_',
].join('\n');

const marker = (name, { pr = 55, issue = 44, head = HEAD, rev = 1, verdict = 'APPROVE' } = {}) =>
  `Review done.\n\n${name}\nPR: ${pr}\nISSUE: ${issue}\nHEAD_SHA: ${head}\nCONTRACT_REVISION: ${rev}\nVERDICT: ${verdict}\n`;

const baselineComment = (body = ISSUE_BODY, rev = 1, kind = 'REKODA_CONTRACT_BASELINE') => ({
  author: ACTIONS,
  createdAt: '2026-09-01T00:00:00Z',
  body: `${kind}\nISSUE: 44\nREVISION: ${rev}\nBODY_SHA256: ${sha256Hex(normalizeBody(body))}`,
});

/** A fully valid builder:claude R1 state. Mutate per test case. */
function validState(overrides = {}) {
  const state = {
    pr: {
      number: 55,
      headSha: HEAD,
      riskLabels: ['risk:R1'],
      builderLabels: ['builder:claude'],
      author: CLAUDE_BOT,
    },
    prBody: 'Closes #44',
    issue: {
      number: 44,
      exists: true,
      agentTask: true,
      labels: ['agent-task', 'risk:R1', 'builder:claude', 'status:in-review'],
      riskLabels: ['risk:R1'],
      builderLabels: ['builder:claude'],
      body: ISSUE_BODY,
      comments: [baselineComment()],
    },
    techEvidence: {
      candidates: [
        { author: CODEX, createdAt: '2026-09-02T00:00:00Z', body: marker(MARKERS.codex) },
      ],
    },
    geminiEvidence: {
      candidates: [
        { author: ACTIONS, createdAt: '2026-09-02T01:00:00Z', body: marker(MARKERS.gemini) },
      ],
    },
    ownerReviews: [],
    unresolvedThreads: 0,
    config: {
      ownerLogin: OWNER,
      codexLogin: CODEX,
      trustedMarkerAuthors: [ACTIONS],
      authorizedRevisionAuthors: [ACTIONS, OWNER],
      claudeSideAuthors: [CLAUDE_BOT, ACTIONS],
    },
  };
  return deepMerge(state, overrides);
}

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === 'object' &&
      !Array.isArray(base[k])
    )
      deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}

const codes = (r) => r.reasons.map((x) => x.code);
const expectBlock = (state, code, mode = 'full') => {
  const r = evaluate(state, mode);
  assert.equal(r.pass, false, `expected BLOCK, got PASS`);
  assert.ok(codes(r).includes(code), `expected reason ${code}, got ${codes(r).join(', ')}`);
};

// ---------------------------------------------------------------------------
// Positive cases: valid evidence at each risk level passes.
// ---------------------------------------------------------------------------

test('valid R1 builder:claude passes', () => {
  const r = evaluate(validState());
  assert.deepEqual(r, { pass: true, reasons: [] });
});

test('valid R0 passes', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R0'];
  s.issue.riskLabels = ['risk:R0'];
  assert.equal(evaluate(s).pass, true);
});

test('valid R2 builder:codex passes (Claude technical marker from trusted identity)', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R2'];
  s.pr.builderLabels = ['builder:codex'];
  s.pr.author = OWNER; // Codex Cloud PRs are authored by the connected account
  s.issue.riskLabels = ['risk:R2'];
  s.issue.builderLabels = ['builder:codex'];
  s.techEvidence.candidates = [
    { author: ACTIONS, createdAt: '2026-09-02T00:00:00Z', body: marker(MARKERS.claude) },
  ];
  const r = evaluate(s);
  assert.deepEqual(r, { pass: true, reasons: [] });
});

test('valid owner-authorized R3 passes only with decision reference AND owner approval of HEAD', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R3'];
  s.issue.riskLabels = ['risk:R3'];
  s.issue.body = ISSUE_BODY.replace('_No response_', 'docs/REKODA_OWNER_DECISIONS.md OWN-15');
  s.issue.comments = [baselineComment(s.issue.body)];
  s.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: HEAD }];
  const r = evaluate(s);
  assert.deepEqual(r, { pass: true, reasons: [] });
});

// ---------------------------------------------------------------------------
// Negative cases 1–20: each fails CLOSED with its machine-readable reason.
// ---------------------------------------------------------------------------

test('1. missing technical approval blocks', () => {
  expectBlock(validState({ techEvidence: { candidates: [] } }), 'TECH_APPROVAL_MISSING');
});

test('2. stale technical approval (old HEAD) blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [
    { author: CODEX, createdAt: 'x', body: marker(MARKERS.codex, { head: OLD_HEAD }) },
  ];
  expectBlock(s, 'TECH_APPROVAL_STALE');
});

test('3. wrong technical reviewer identity blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [
    { author: 'random-user', createdAt: 'x', body: marker(MARKERS.codex) },
  ];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_REVIEWER') && codes(r).includes('TECH_APPROVAL_MISSING'));
});

test('4. malformed technical approval blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [
    {
      author: CODEX,
      createdAt: 'x',
      body: `${MARKERS.codex}\nPR: 55\nHEAD_SHA: ${HEAD}\nVERDICT: APPROVE`,
    }, // no ISSUE/REVISION
  ];
  expectBlock(s, 'TECH_MALFORMED');
});

test('5. technical BLOCK verdict blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [
    { author: CODEX, createdAt: 'x', body: marker(MARKERS.codex, { verdict: 'BLOCK' }) },
  ];
  expectBlock(s, 'TECH_BLOCK');
});

test('6. missing Gemini acceptance blocks', () => {
  expectBlock(validState({ geminiEvidence: { candidates: [] } }), 'GEMINI_APPROVAL_MISSING');
});

test('7. stale Gemini acceptance blocks', () => {
  const s = validState();
  s.geminiEvidence.candidates = [
    { author: ACTIONS, createdAt: 'x', body: marker(MARKERS.gemini, { head: OLD_HEAD }) },
  ];
  expectBlock(s, 'GEMINI_APPROVAL_STALE');
});

test('8. Gemini BLOCK verdict blocks', () => {
  const s = validState();
  s.geminiEvidence.candidates = [
    { author: ACTIONS, createdAt: 'x', body: marker(MARKERS.gemini, { verdict: 'BLOCK' }) },
  ];
  expectBlock(s, 'GEMINI_BLOCK');
});

test('9. approval for wrong PR blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [
    { author: CODEX, createdAt: 'x', body: marker(MARKERS.codex, { pr: 99 }) },
  ];
  expectBlock(s, 'TECH_WRONG_PR');
});

test('10. approval for wrong linked issue blocks', () => {
  const s = validState();
  s.geminiEvidence.candidates = [
    { author: ACTIONS, createdAt: 'x', body: marker(MARKERS.gemini, { issue: 999 }) },
  ];
  expectBlock(s, 'GEMINI_WRONG_ISSUE');
});

test('11. approval for wrong contract revision blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [
    { author: CODEX, createdAt: 'x', body: marker(MARKERS.codex, { rev: 3 }) },
  ];
  expectBlock(s, 'TECH_WRONG_REVISION');
});

test('12. unauthorized contract amendment blocks, and invalidates both approvals without a push', () => {
  const s = validState();
  s.issue.body = ISSUE_BODY + '\n\nQuietly widened scope.';
  // markers still reference revision 1 and the same HEAD — the body change alone must block
  expectBlock(s, 'CONTRACT_AMENDED_UNAUTHORIZED');
});

test('12b. an authorized revision marker re-validates the amended body but old approvals no longer match', () => {
  const s = validState();
  const newBody = ISSUE_BODY + '\n\nAuthorized scope change.';
  s.issue.body = newBody;
  s.issue.comments = [
    baselineComment(),
    {
      author: OWNER,
      createdAt: 'y',
      body: `REKODA_CONTRACT_REVISION\nISSUE: 44\nREVISION: 2\nBODY_SHA256: ${sha256Hex(normalizeBody(newBody))}\nREASON: scope change`,
    },
  ];
  const r = evaluate(s); // approvals still bind revision 1
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_REVISION') && codes(r).includes('GEMINI_WRONG_REVISION'));
  // fresh verdicts for revision 2 pass again
  s.techEvidence.candidates.push({
    author: CODEX,
    createdAt: 'z',
    body: marker(MARKERS.codex, { rev: 2 }),
  });
  s.geminiEvidence.candidates.push({
    author: ACTIONS,
    createdAt: 'z',
    body: marker(MARKERS.gemini, { rev: 2 }),
  });
  assert.equal(evaluate(s).pass, true);
});

test('12c. a revision marker from an unauthorized author does not count', () => {
  const s = validState();
  const newBody = ISSUE_BODY + '\n\nSneaky change.';
  s.issue.body = newBody;
  s.issue.comments = [
    baselineComment(),
    {
      author: 'random-user',
      createdAt: 'y',
      body: `REKODA_CONTRACT_REVISION\nISSUE: 44\nREVISION: 2\nBODY_SHA256: ${sha256Hex(normalizeBody(newBody))}\nREASON: trust me`,
    },
  ];
  expectBlock(s, 'CONTRACT_AMENDED_UNAUTHORIZED');
});

test('13. issue/PR risk mismatch blocks', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R2'];
  expectBlock(s, 'RISK_MISMATCH');
});

test('14. issue/PR builder mismatch blocks', () => {
  const s = validState();
  s.issue.builderLabels = ['builder:codex'];
  expectBlock(s, 'BUILDER_MISMATCH');
});

test('15. missing authoritative linked issue blocks', () => {
  expectBlock(validState({ prBody: 'No closing reference here.' }), 'LINKED_ISSUE_MISSING');
  expectBlock(validState({ prBody: 'Closes #44 and closes #45' }), 'LINKED_ISSUE_AMBIGUOUS');
  const s = validState();
  s.issue.exists = false;
  expectBlock(s, 'ISSUE_NOT_FOUND');
});

test('16. unresolved blocking review threads block', () => {
  expectBlock(validState({ unresolvedThreads: 2 }), 'THREADS_UNRESOLVED');
});

test('17. unresolved R3 owner decision blocks', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R3'];
  s.issue.riskLabels = ['risk:R3'];
  s.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: HEAD }];
  expectBlock(s, 'R3_OWNER_DECISION_MISSING'); // decision reference is "_No response_"
});

test('18. missing/stale R3 owner approval blocks, and never substitutes for peer review', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R3'];
  s.issue.riskLabels = ['risk:R3'];
  s.issue.body = ISSUE_BODY.replace('_No response_', 'OWN-15');
  s.issue.comments = [baselineComment(s.issue.body)];
  expectBlock(s, 'R3_OWNER_APPROVAL_MISSING');
  s.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: OLD_HEAD }];
  expectBlock(s, 'R3_OWNER_APPROVAL_MISSING');
  // owner approval present but peer technical approval missing → still blocked
  s.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: HEAD }];
  s.techEvidence.candidates = [];
  expectBlock(s, 'TECH_APPROVAL_MISSING');
});

test('19. attempted reviewer self-approval blocks', () => {
  // builder:claude — a Claude-side identity posting the Codex marker
  const s = validState();
  s.techEvidence.candidates = [{ author: CLAUDE_BOT, createdAt: 'x', body: marker(MARKERS.codex) }];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_SELF_REVIEW'));
  // builder:codex — the PR author (Codex acts as the owner account) posting the Claude marker
  const s2 = validState();
  s2.pr.builderLabels = ['builder:codex'];
  s2.issue.builderLabels = ['builder:codex'];
  s2.pr.author = OWNER;
  s2.techEvidence.candidates = [{ author: OWNER, createdAt: 'x', body: marker(MARKERS.claude) }];
  const r2 = evaluate(s2);
  assert.equal(r2.pass, false);
  assert.ok(codes(r2).includes('TECH_SELF_REVIEW'));
});

test('20. missing required CI evidence blocks when supplied', () => {
  expectBlock(validState({ ci: { complete: false } }), 'CI_INCOMPLETE');
});

// ---------------------------------------------------------------------------
// Supersession and ordering semantics
// ---------------------------------------------------------------------------

test('a later explicit APPROVE for the same HEAD/revision supersedes an earlier BLOCK', () => {
  const s = validState();
  s.techEvidence.candidates = [
    { author: CODEX, createdAt: '1', body: marker(MARKERS.codex, { verdict: 'BLOCK' }) },
    { author: CODEX, createdAt: '2', body: marker(MARKERS.codex, { verdict: 'APPROVE' }) },
  ];
  assert.equal(evaluate(s).pass, true);
});

test('a later explicit BLOCK supersedes an earlier APPROVE for the same HEAD/revision', () => {
  const s = validState();
  s.techEvidence.candidates = [
    { author: CODEX, createdAt: '1', body: marker(MARKERS.codex, { verdict: 'APPROVE' }) },
    { author: CODEX, createdAt: '2', body: marker(MARKERS.codex, { verdict: 'BLOCK' }) },
  ];
  expectBlock(s, 'TECH_BLOCK');
});

test('a new HEAD invalidates every prior approval', () => {
  const s = validState();
  s.pr.headSha = 'c'.repeat(40); // push happened; markers still name the old HEAD
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_APPROVAL_STALE') && codes(r).includes('GEMINI_APPROVAL_STALE'));
});

test('label integrity: both-or-neither builder labels block', () => {
  expectBlock(validState({ pr: { builderLabels: [] } }), 'BUILDER_LABEL_INVALID');
  expectBlock(
    validState({ pr: { builderLabels: ['builder:claude', 'builder:codex'] } }),
    'BUILDER_LABEL_INVALID',
  );
  expectBlock(validState({ pr: { riskLabels: ['risk:R1', 'risk:R2'] } }), 'RISK_LABEL_INVALID');
});

test('an issue with an unresolved owner-decision label blocks', () => {
  const s = validState();
  s.issue.labels.push('needs-owner-decision');
  expectBlock(s, 'DECISION_STATE_INVALID');
});

test('missing contract baseline fails closed', () => {
  const s = validState();
  s.issue.comments = [];
  expectBlock(s, 'CONTRACT_BASELINE_MISSING');
});

// ---------------------------------------------------------------------------
// Gate modes
// ---------------------------------------------------------------------------

test('policy mode ignores reviewer verdicts but keeps structural failures', () => {
  const s = validState({ techEvidence: { candidates: [] }, geminiEvidence: { candidates: [] } });
  assert.equal(evaluate(s, 'policy').pass, true); // reviewer gates own those
  const s2 = validState({ techEvidence: { candidates: [] }, unresolvedThreads: 1 });
  expectBlock(s2, 'THREADS_UNRESOLVED', 'policy');
});

test('technical mode fails on prerequisites and technical reasons only', () => {
  const s = validState({ geminiEvidence: { candidates: [] }, techEvidence: { candidates: [] } });
  const r = evaluate(s, 'technical');
  assert.equal(r.pass, false);
  assert.deepEqual(codes(r), ['TECH_APPROVAL_MISSING']);
});

test('acceptance mode fails on prerequisites and Gemini reasons only', () => {
  const s = validState({ geminiEvidence: { candidates: [] }, techEvidence: { candidates: [] } });
  const r = evaluate(s, 'acceptance');
  assert.equal(r.pass, false);
  assert.deepEqual(codes(r), ['GEMINI_APPROVAL_MISSING']);
});

// ---------------------------------------------------------------------------
// Parser unit coverage
// ---------------------------------------------------------------------------

test('parseMarkers: valid block parses, junk fields are malformed', () => {
  const [m] = parseMarkers(marker(MARKERS.gemini), MARKERS.gemini);
  assert.deepEqual(m, {
    pr: 55,
    issue: 44,
    headSha: HEAD,
    contractRevision: 1,
    verdict: 'APPROVE',
    malformed: false,
  });
  const [bad] = parseMarkers(
    `${MARKERS.gemini}\nPR: x\nISSUE: 44\nHEAD_SHA: nope\nCONTRACT_REVISION: 1\nVERDICT: LGTM`,
    MARKERS.gemini,
  );
  assert.equal(bad.malformed, true);
});

test('parseClosingRefs finds distinct closing keywords only', () => {
  assert.deepEqual(parseClosingRefs('Closes #12, fixes #12, resolves #13; see #14'), [12, 13]);
  assert.deepEqual(parseClosingRefs('relates to #9'), []);
});

test('computeContractRevision: highest authorized revision governs', () => {
  const body = 'The contract.';
  const rev = computeContractRevision({
    issueNumber: 7,
    issueBody: body,
    issueComments: [
      {
        author: ACTIONS,
        body: `REKODA_CONTRACT_BASELINE\nISSUE: 7\nREVISION: 1\nBODY_SHA256: ${'0'.repeat(64)}`,
      },
      {
        author: OWNER,
        body: `REKODA_CONTRACT_REVISION\nISSUE: 7\nREVISION: 2\nBODY_SHA256: ${sha256Hex(body)}\nREASON: fix`,
      },
    ],
    authorizedAuthors: [ACTIONS, OWNER],
  });
  assert.equal(rev.revision, 2);
  assert.equal(rev.amended, false);
});

test('issueFormField extracts issue-form sections and treats _No response_ as empty', () => {
  assert.equal(issueFormField(ISSUE_BODY, 'Owner decision reference'), null);
  assert.equal(issueFormField(ISSUE_BODY, 'Outcome'), 'A working thing.');
});
