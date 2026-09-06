#!/usr/bin/env node
/**
 * Deterministic behavioural evidence for the merge-policy evaluator —
 * the twenty §5.B block cases, the positive cases, and the provenance,
 * stickiness, history, WIP, and ordering properties the implementation
 * audit demanded. Nothing here mocks away the property under test: the
 * signatures are real Ed25519 signatures over the real canonical
 * payloads, verified by the real verifier. No network, no live GitHub.
 *
 * Run: node --test scripts/agents/evaluator.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKERS,
  evaluate,
  parseMarkers,
  parseClosingRefs,
  computeContractRevision,
  canonicalVerdictPayload,
  canonicalContractPayload,
  verifySignature,
  sha256Hex,
  normalizeBody,
  issueFormField,
  isGoverned,
  isActorAuthorized,
  isContractAmendmentAuthorized,
  evaluateBuildAdmission,
  linkedOpenPrs,
  selectLinkedPrs,
  resolveWorkflowRunTarget,
  amendmentTransaction,
  buildVerdictMarkerLines,
  buildContractMarkerLines,
  buildFreezeMarkerLines,
  parseRevisionMarkers,
  parseFreezeMarkers,
  canonicalFreezePayload,
  contractSnapshotHash,
  resolveVerdict,
  chooseCheckAction,
  readyPromotionAction,
  parsePrNumbersJson,
  FREEZE_MARKER,
  SCHEME,
} from './evaluator.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const OWNER = 'AngeloAkuhwa';
const CODEX = 'chatgpt-codex-connector[bot]';
const ACTIONS = 'github-actions[bot]';

// Real reviewer-specific signing authorities (ephemeral test keys).
const keyPair = () => generateKeyPairSync('ed25519');
const CLAUDE_KEY = keyPair();
const GEMINI_KEY = keyPair();
const AUTHORITY_KEY = keyPair();
const ROGUE_KEY = keyPair(); // an "unrelated workflow" that also signs things
const pem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signWith = (k, payload) =>
  cryptoSign(null, Buffer.from(payload, 'utf8'), k.privateKey).toString('base64');

const ISSUE_BODY = [
  '### Outcome',
  'A working thing.',
  '### Owner decision reference (if required and resolved)',
  '_No response_',
].join('\n');

const BODY_HASH = sha256Hex(normalizeBody(ISSUE_BODY));

/**
 * The V3 authoritative contract-snapshot hash (issue, revision, risk,
 * builder, body) computed via the REAL production function.
 */
const snapHash = ({
  issue = 44,
  revision = 1,
  risk = 'risk:R1',
  builder = 'builder:claude',
  body = ISSUE_BODY,
} = {}) =>
  contractSnapshotHash({
    issue,
    revision,
    risk,
    builder,
    bodySha256: sha256Hex(normalizeBody(body)),
  });

/** The active-contract snapshot hash every default (claude-built) verdict binds. */
const CONTRACT_HASH = snapHash();
/** The active-contract snapshot hash for the codex-built default state. */
const CODEX_CONTRACT_HASH = snapHash({ builder: 'builder:codex' });

/** Build a verdict marker body; sign with `key` unless key === null. */
function marker(
  name,
  {
    pr = 55,
    issue = 44,
    head = HEAD,
    rev = 1,
    contractHash = CONTRACT_HASH,
    verdict = 'APPROVE',
    key = undefined,
    dropSig = false,
  } = {},
) {
  const m = {
    name,
    pr,
    issue,
    headSha: head,
    contractRevision: rev,
    contractSnapshotSha256: contractHash,
    verdict,
  };
  const lines = [
    `${name}`,
    `SCHEME: ${SCHEME}`,
    `PR: ${pr}`,
    `ISSUE: ${issue}`,
    `HEAD_SHA: ${head}`,
    `CONTRACT_REVISION: ${rev}`,
    `CONTRACT_SNAPSHOT_SHA256: ${contractHash}`,
    `VERDICT: ${verdict}`,
  ];
  if (!dropSig && key) lines.push(`SIGNATURE: ${signWith(key, canonicalVerdictPayload(m))}`);
  return `Review done.\n\n${lines.join('\n')}\n`;
}

/** Contract marker comment; authorized by owner authorship or a signature. */
function contractComment({
  kind = 'REKODA_CONTRACT_BASELINE',
  issue = 44,
  revision = 1,
  body = ISSUE_BODY,
  risk = 'risk:R1',
  builder = 'builder:claude',
  reason = 'scope change',
  author = OWNER,
  key = null,
  createdAt = '2026-09-01T00:00:00Z',
  id = 1,
} = {}) {
  const m = {
    kind,
    issue,
    revision,
    risk,
    builder,
    bodySha256: sha256Hex(normalizeBody(body)),
    reason,
  };
  const lines = [
    kind,
    `SCHEME: ${SCHEME}`,
    `ISSUE: ${issue}`,
    `REVISION: ${revision}`,
    `RISK: ${risk}`,
    `BUILDER: ${builder}`,
    `BODY_SHA256: ${m.bodySha256}`,
  ];
  if (kind === 'REKODA_CONTRACT_REVISION') lines.push(`REASON: ${reason}`);
  if (key) lines.push(`SIGNATURE: ${signWith(key, canonicalContractPayload(m))}`);
  return { author, createdAt, id, body: lines.join('\n') };
}

const codexReview = (over = {}) => ({
  author: CODEX,
  kind: 'review',
  reviewState: 'COMMENTED',
  commitId: HEAD,
  createdAt: '2026-09-02T00:00:00Z',
  id: 10,
  body: marker(MARKERS.codex),
  ...over,
});

/** A fully valid builder:claude R1 state. Mutate per test case. */
function validState(overrides = {}) {
  const state = {
    pr: {
      number: 55,
      headSha: HEAD,
      riskLabels: ['risk:R1'],
      builderLabels: ['builder:claude'],
      author: 'claude[bot]',
      enrollment: { everLabeledAgent: true, complete: true },
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
      comments: [contractComment()],
    },
    techEvidence: { candidates: [codexReview()] },
    geminiEvidence: {
      candidates: [
        {
          author: ACTIONS,
          kind: 'comment',
          createdAt: '2026-09-02T01:00:00Z',
          id: 20,
          body: marker(MARKERS.gemini, { key: GEMINI_KEY }),
        },
      ],
    },
    ownerReviews: [],
    unresolvedThreads: 0,
    openLanes: [{ issue: 44, status: 'status:in-review' }],
    config: {
      ownerLogin: OWNER,
      codexLogin: CODEX,
      publicKeys: {
        claudeReviewer: pem(CLAUDE_KEY),
        geminiReviewer: pem(GEMINI_KEY),
        contractAuthority: pem(AUTHORITY_KEY),
      },
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

/** Claude-built PR state variant: builder:codex with a signed Claude verdict. */
function codexBuiltState() {
  const s = validState();
  s.pr.builderLabels = ['builder:codex'];
  s.pr.author = OWNER; // Codex Cloud PRs are authored by the connected account
  s.issue.labels = ['agent-task', 'risk:R1', 'builder:codex', 'status:in-review'];
  s.issue.builderLabels = ['builder:codex'];
  // The signed contract records builder:codex — labels and snapshot agree.
  s.issue.comments = [contractComment({ builder: 'builder:codex' })];
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-02T00:00:00Z',
      id: 11,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY, contractHash: CODEX_CONTRACT_HASH }),
    },
  ];
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-02T01:00:00Z',
      id: 20,
      body: marker(MARKERS.gemini, { key: GEMINI_KEY, contractHash: CODEX_CONTRACT_HASH }),
    },
  ];
  return s;
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

test('valid R1 builder:claude passes', () => {
  assert.deepEqual(evaluate(validState()), { pass: true, reasons: [] });
});

test('valid R0 passes', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R0'];
  s.issue.riskLabels = ['risk:R0'];
  assert.equal(evaluate(s).pass, true);
});

test('valid R2 builder:codex passes with a SIGNED Claude technical verdict', () => {
  const s = codexBuiltState();
  s.pr.riskLabels = ['risk:R2'];
  s.issue.riskLabels = ['risk:R2'];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

test('valid owner-authorized R3 passes only with decision reference AND owner approval of HEAD', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R3'];
  s.issue.riskLabels = ['risk:R3'];
  s.issue.body = ISSUE_BODY.replace('_No response_', 'docs/REKODA_OWNER_DECISIONS.md OWN-15');
  s.issue.labels = ['agent-task', 'risk:R3', 'builder:claude', 'status:in-review'];
  s.issue.comments = [contractComment({ body: s.issue.body, risk: 'risk:R3' })];
  // Verdicts bind the ACTIVE contract snapshot — here the R3 snapshot.
  const r3Hash = snapHash({ risk: 'risk:R3', body: s.issue.body });
  s.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex, { contractHash: r3Hash }) }),
  ];
  s.geminiEvidence.candidates[0].body = marker(MARKERS.gemini, {
    key: GEMINI_KEY,
    contractHash: r3Hash,
  });
  s.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: HEAD }];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

test('valid workflow-specific provenance succeeds (signature is what counts, not the author string)', () => {
  const s = validState();
  // even with an unexpected author, a correctly signed Gemini marker is valid evidence
  s.geminiEvidence.candidates = [
    {
      author: 'some-mirror-bot',
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { key: GEMINI_KEY }),
    },
  ];
  assert.equal(evaluate(s).pass, true);
});

// ---------------------------------------------------------------------------
// BLOCKER 1 — forgery is technically impossible, not just forbidden
// ---------------------------------------------------------------------------

test('generic github-actions[bot] comment cannot forge Gemini approval (unsigned)', () => {
  const s = validState();
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { dropSig: true }),
    },
  ];
  expectBlock(s, 'GEMINI_UNAUTHORIZED');
});

test('generic github-actions[bot] comment cannot forge Claude approval (unsigned)', () => {
  const s = codexBuiltState();
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.claude, { dropSig: true }),
    },
  ];
  expectBlock(s, 'TECH_UNAUTHORIZED');
});

test('a marker signed by the WRONG key (unrelated workflow with its own key) is rejected', () => {
  const s = validState();
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { key: ROGUE_KEY }),
    },
  ];
  expectBlock(s, 'GEMINI_UNAUTHORIZED');
  const s2 = codexBuiltState();
  // the builder's own signing attempt with a key it could plausibly hold (e.g. Gemini's) still fails Claude verification
  s2.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.claude, { key: GEMINI_KEY }),
    },
  ];
  expectBlock(s2, 'TECH_UNAUTHORIZED');
});

test('a tampered signed marker fails verification (signature binds every field)', () => {
  const s = validState();
  const good = marker(MARKERS.gemini, { key: GEMINI_KEY });
  const tampered = good.replace('VERDICT: APPROVE', 'VERDICT: BLOCK'); // flip after signing
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: tampered },
  ];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('GEMINI_UNAUTHORIZED'));
});

test('missing public key fails closed (no key material → no valid approval possible)', () => {
  const s = validState();
  s.config.publicKeys.geminiReviewer = null;
  expectBlock(s, 'GEMINI_UNAUTHORIZED');
});

test('builder cannot authorize its own contract revision (unsigned bot marker ignored → amendment blocks)', () => {
  const s = validState();
  const newBody = ISSUE_BODY + '\n\nBuilder widened its own scope.';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      author: ACTIONS,
      key: null,
      id: 2,
    }),
  ];
  expectBlock(s, 'CONTRACT_AMENDED_UNAUTHORIZED');
});

test('unrelated workflow cannot authorize a contract revision with the wrong key', () => {
  const s = validState();
  const newBody = ISSUE_BODY + '\n\nRogue amendment.';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      author: ACTIONS,
      key: ROGUE_KEY,
      id: 2,
    }),
  ];
  expectBlock(s, 'CONTRACT_AMENDED_UNAUTHORIZED');
});

test('only contract-authority-SIGNED revisions are authoritative', () => {
  const s = validState();
  const newBody = ISSUE_BODY + '\n\nAuthorized change.';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 2,
      createdAt: 'y',
    }),
  ];
  // approvals still bind revision 1 → invalidated without any push
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_REVISION') && codes(r).includes('GEMINI_WRONG_REVISION'));
  // fresh verdicts for revision 2 — binding the rev-2 snapshot hash — pass again
  const rev2Hash = snapHash({ revision: 2, body: newBody });
  s.techEvidence.candidates.push(
    codexReview({
      id: 12,
      createdAt: 'z',
      body: marker(MARKERS.codex, { rev: 2, contractHash: rev2Hash }),
    }),
  );
  s.geminiEvidence.candidates.push({
    author: ACTIONS,
    kind: 'comment',
    createdAt: 'z',
    id: 21,
    body: marker(MARKERS.gemini, { rev: 2, contractHash: rev2Hash, key: GEMINI_KEY }),
  });
  assert.equal(evaluate(s).pass, true);
});

// ---------------------------------------------------------------------------
// Codex provenance: marker AND review commit_id must bind the current HEAD
// ---------------------------------------------------------------------------

test('Codex marker claiming current HEAD inside a review of an OLD commit blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [codexReview({ commitId: OLD_HEAD })]; // marker says HEAD, review binds OLD_HEAD
  expectBlock(s, 'TECH_APPROVAL_STALE');
});

test('a dismissed Codex review does not count', () => {
  const s = validState();
  s.techEvidence.candidates = [codexReview({ reviewState: 'DISMISSED' })];
  expectBlock(s, 'TECH_UNAUTHORIZED');
});

test('a Codex marker in a plain comment (not a review) does not count', () => {
  const s = validState();
  s.techEvidence.candidates = [
    { author: CODEX, kind: 'comment', createdAt: 'x', id: 1, body: marker(MARKERS.codex) },
  ];
  expectBlock(s, 'TECH_UNAUTHORIZED');
});

test('a Codex-named marker from any other identity does not count', () => {
  const s = validState();
  s.techEvidence.candidates = [codexReview({ author: 'claude[bot]' })];
  expectBlock(s, 'TECH_UNAUTHORIZED');
});

// ---------------------------------------------------------------------------
// The twenty §5.B negative cases (those not already covered above)
// ---------------------------------------------------------------------------

test('1. missing technical approval blocks', () => {
  expectBlock(validState({ techEvidence: { candidates: [] } }), 'TECH_APPROVAL_MISSING');
});

test('2. stale technical approval (old HEAD everywhere) blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({ commitId: OLD_HEAD, body: marker(MARKERS.codex, { head: OLD_HEAD }) }),
  ];
  expectBlock(s, 'TECH_APPROVAL_STALE');
});

test('4. malformed technical approval blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({ body: `${MARKERS.codex}\nPR: 55\nHEAD_SHA: ${HEAD}\nVERDICT: APPROVE` }),
  ];
  expectBlock(s, 'TECH_MALFORMED');
});

test('5. technical BLOCK verdict blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [codexReview({ body: marker(MARKERS.codex, { verdict: 'BLOCK' }) })];
  expectBlock(s, 'TECH_BLOCK');
});

test('6.-8. Gemini missing / stale / BLOCK verdicts block', () => {
  expectBlock(validState({ geminiEvidence: { candidates: [] } }), 'GEMINI_APPROVAL_MISSING');
  const s = validState();
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { head: OLD_HEAD, key: GEMINI_KEY }),
    },
  ];
  expectBlock(s, 'GEMINI_APPROVAL_STALE');
  const s2 = validState();
  s2.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { verdict: 'BLOCK', key: GEMINI_KEY }),
    },
  ];
  expectBlock(s2, 'GEMINI_BLOCK');
});

test('9.-11. approvals for wrong PR / issue / revision block', () => {
  const s = validState();
  s.techEvidence.candidates = [codexReview({ body: marker(MARKERS.codex, { pr: 99 }) })];
  expectBlock(s, 'TECH_WRONG_PR');
  const s2 = validState();
  s2.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { issue: 999, key: GEMINI_KEY }),
    },
  ];
  expectBlock(s2, 'GEMINI_WRONG_ISSUE');
  const s3 = validState();
  s3.techEvidence.candidates = [codexReview({ body: marker(MARKERS.codex, { rev: 3 }) })];
  expectBlock(s3, 'TECH_WRONG_REVISION');
});

test('12. unauthorized contract amendment blocks (body edit, no authorized marker)', () => {
  const s = validState();
  s.issue.body = ISSUE_BODY + '\n\nQuietly widened scope.';
  expectBlock(s, 'CONTRACT_AMENDED_UNAUTHORIZED');
});

test('13.-14. issue/PR risk and builder mismatches block', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R2'];
  expectBlock(s, 'RISK_MISMATCH');
  const s2 = validState();
  s2.issue.builderLabels = ['builder:codex'];
  expectBlock(s2, 'BUILDER_MISMATCH');
});

test('15. missing / ambiguous / unresolvable authoritative issue blocks', () => {
  expectBlock(validState({ prBody: 'No closing reference here.' }), 'LINKED_ISSUE_MISSING');
  expectBlock(validState({ prBody: 'Closes #44 and closes #45' }), 'LINKED_ISSUE_AMBIGUOUS');
  const s = validState();
  s.issue.exists = false;
  expectBlock(s, 'ISSUE_NOT_FOUND');
});

test('16. unresolved blocking review threads block', () => {
  expectBlock(validState({ unresolvedThreads: 2 }), 'THREADS_UNRESOLVED');
});

test('17.-18. R3 without decision / without current owner approval blocks; owner approval never substitutes', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R3'];
  s.issue.riskLabels = ['risk:R3'];
  s.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: HEAD }];
  expectBlock(s, 'R3_OWNER_DECISION_MISSING');
  const s2 = validState();
  s2.pr.riskLabels = ['risk:R3'];
  s2.issue.riskLabels = ['risk:R3'];
  s2.issue.body = ISSUE_BODY.replace('_No response_', 'OWN-15');
  s2.issue.comments = [contractComment({ body: s2.issue.body })];
  expectBlock(s2, 'R3_OWNER_APPROVAL_MISSING');
  s2.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: OLD_HEAD }];
  expectBlock(s2, 'R3_OWNER_APPROVAL_MISSING');
  s2.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: HEAD }];
  s2.techEvidence.candidates = [];
  expectBlock(s2, 'TECH_APPROVAL_MISSING'); // owner approval present, peer review still required
});

test('20. missing required CI evidence blocks when supplied', () => {
  expectBlock(validState({ ci: { complete: false } }), 'CI_INCOMPLETE');
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — sticky governance: the Codex escape sequence
// ---------------------------------------------------------------------------

test('an enrolled PR cannot escape by removing labels and the closing reference', () => {
  const s = validState();
  // The escape: strip both labels, blank the closing reference.
  s.pr.riskLabels = [];
  s.pr.builderLabels = [];
  s.prBody = 'Docs touch-up.';
  s.issue = null;
  // Immutable label history keeps it governed…
  assert.equal(isGoverned(s), true);
  // …and evaluation then fails closed on every stripped element.
  const r = evaluate(s, 'policy');
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('RISK_LABEL_INVALID'));
  assert.ok(codes(r).includes('BUILDER_LABEL_INVALID'));
  assert.ok(codes(r).includes('LINKED_ISSUE_MISSING'));
});

test('a never-enrolled ordinary PR is not governed', () => {
  const s = validState();
  s.pr.riskLabels = [];
  s.pr.builderLabels = [];
  s.pr.enrollment = { everLabeledAgent: false, complete: true };
  s.prBody = 'Human PR.';
  s.issue = null;
  assert.equal(isGoverned(s), false);
});

test('8. replacing the authoritative issue with an unrelated one blocks', () => {
  const s = validState();
  s.prBody = 'Closes #77';
  s.issue = {
    number: 77,
    exists: true,
    agentTask: false,
    labels: [],
    riskLabels: [],
    builderLabels: [],
    body: 'unrelated',
    comments: [],
  };
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('ISSUE_NOT_AGENT_TASK'));
});

// ---------------------------------------------------------------------------
// IMPORTANT 1 — contract history semantics
// ---------------------------------------------------------------------------

test('baseline with revision != 1 is invalid history', () => {
  const s = validState();
  s.issue.comments = [contractComment({ revision: 3 })];
  expectBlock(s, 'CONTRACT_HISTORY_INVALID');
});

test('duplicate same-revision markers with different hashes are rejected', () => {
  const s = validState();
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: ISSUE_BODY + '\nA',
      key: AUTHORITY_KEY,
      id: 2,
    }),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: ISSUE_BODY + '\nB',
      key: AUTHORITY_KEY,
      id: 3,
    }),
  ];
  expectBlock(s, 'CONTRACT_HISTORY_INVALID');
});

test('a skipped revision is rejected (monotonic 1..N required)', () => {
  const s = validState();
  const newBody = ISSUE_BODY + '\nX';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 3,
      body: newBody,
      key: AUTHORITY_KEY,
      id: 2,
    }),
  ];
  expectBlock(s, 'CONTRACT_HISTORY_INVALID');
});

test('a revision marker without a REASON is malformed and does not count', () => {
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [
      contractComment(),
      {
        author: OWNER,
        createdAt: 'y',
        id: 2,
        body: `REKODA_CONTRACT_REVISION\nISSUE: 44\nREVISION: 2\nBODY_SHA256: ${'0'.repeat(64)}`,
      },
    ],
    ownerLogin: OWNER,
    contractAuthorityKey: null,
  });
  assert.equal(rev.revision, 1); // the malformed marker was ignored
});

test('a replayed lower revision never lowers the current revision', () => {
  const v2 = ISSUE_BODY + '\nv2';
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: v2,
    issueComments: [
      contractComment(),
      contractComment({
        kind: 'REKODA_CONTRACT_REVISION',
        revision: 2,
        body: v2,
        key: AUTHORITY_KEY,
        id: 2,
        createdAt: 'y',
      }),
      contractComment({ id: 3, createdAt: 'z' }), // baseline reposted later (same rev-1 hash)
    ],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(rev.revision, 2);
  assert.equal(rev.amended, false);
});

test('missing contract baseline fails closed', () => {
  const s = validState();
  s.issue.comments = [];
  expectBlock(s, 'CONTRACT_BASELINE_MISSING');
});

// ---------------------------------------------------------------------------
// IMPORTANT 2 — deterministic global WIP
// ---------------------------------------------------------------------------

test('13g. two active implementation lanes are rejected', () => {
  const s = validState();
  s.openLanes = [
    { issue: 44, status: 'status:in-review' },
    { issue: 51, status: 'status:building' },
  ];
  expectBlock(s, 'WIP_VIOLATION', 'policy');
});

// ---------------------------------------------------------------------------
// IMPORTANT 5 — verdict ordering and evidence lifecycle
// ---------------------------------------------------------------------------

test('a later explicit APPROVE supersedes an earlier BLOCK for the same HEAD/revision (and vice versa)', () => {
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({ id: 1, createdAt: '1', body: marker(MARKERS.codex, { verdict: 'BLOCK' }) }),
    codexReview({ id: 2, createdAt: '2', body: marker(MARKERS.codex, { verdict: 'APPROVE' }) }),
  ];
  assert.equal(evaluate(s).pass, true);
  const s2 = validState();
  s2.techEvidence.candidates = [
    codexReview({ id: 1, createdAt: '1', body: marker(MARKERS.codex, { verdict: 'APPROVE' }) }),
    codexReview({ id: 2, createdAt: '2', body: marker(MARKERS.codex, { verdict: 'BLOCK' }) }),
  ];
  expectBlock(s2, 'TECH_BLOCK');
});

test('14g. equal timestamps break ties deterministically by GitHub id', () => {
  const t = '2026-09-02T00:00:00Z';
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({ id: 9, createdAt: t, body: marker(MARKERS.codex, { verdict: 'APPROVE' }) }),
    codexReview({ id: 3, createdAt: t, body: marker(MARKERS.codex, { verdict: 'BLOCK' }) }),
  ];
  // id 9 is later than id 3 at the same instant → APPROVE governs
  assert.equal(evaluate(s).pass, true);
});

test('malformed or unauthorized later evidence does not erase a previous valid verdict', () => {
  const s = validState();
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '1',
      id: 1,
      body: marker(MARKERS.gemini, { key: GEMINI_KEY }),
    },
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2',
      id: 2,
      body: marker(MARKERS.gemini, { verdict: 'BLOCK', dropSig: true }),
    },
  ];
  assert.equal(evaluate(s).pass, true); // the unsigned later BLOCK is not evidence
});

test('a new HEAD invalidates every prior approval', () => {
  const s = validState();
  s.pr.headSha = 'c'.repeat(40);
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_APPROVAL_STALE') && codes(r).includes('GEMINI_APPROVAL_STALE'));
});

// ---------------------------------------------------------------------------
// BLOCKER 4 — actor authorization threshold
// ---------------------------------------------------------------------------

test('10g. unauthorized actors are rejected; write+ actors are accepted', () => {
  for (const p of ['none', 'read', 'triage', '', undefined])
    assert.equal(isActorAuthorized(p), false, String(p));
  for (const p of ['write', 'maintain', 'admin']) assert.equal(isActorAuthorized(p), true, p);
});

// ---------------------------------------------------------------------------
// Structural and mode coverage
// ---------------------------------------------------------------------------

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

test('policy mode ignores reviewer verdicts but keeps structural failures', () => {
  const s = validState({ techEvidence: { candidates: [] }, geminiEvidence: { candidates: [] } });
  assert.equal(evaluate(s, 'policy').pass, true);
  const s2 = validState({ techEvidence: { candidates: [] }, unresolvedThreads: 1 });
  expectBlock(s2, 'THREADS_UNRESOLVED', 'policy');
});

test('technical and acceptance modes fail on their own family plus prerequisites only', () => {
  const s = validState({ geminiEvidence: { candidates: [] }, techEvidence: { candidates: [] } });
  assert.deepEqual(codes(evaluate(s, 'technical')), ['TECH_APPROVAL_MISSING']);
  assert.deepEqual(codes(evaluate(s, 'acceptance')), ['GEMINI_APPROVAL_MISSING']);
});

// ---------------------------------------------------------------------------
// Parser / primitive units
// ---------------------------------------------------------------------------

test('parseMarkers: valid signed block parses; junk fields are malformed', () => {
  const [m] = parseMarkers(marker(MARKERS.gemini, { key: GEMINI_KEY }), MARKERS.gemini);
  assert.equal(m.malformed, false);
  assert.equal(verifySignature(canonicalVerdictPayload(m), m.signature, pem(GEMINI_KEY)), true);
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

test('issueFormField extracts issue-form sections and treats _No response_ as empty', () => {
  assert.equal(issueFormField(ISSUE_BODY, 'Owner decision reference'), null);
  assert.equal(issueFormField(ISSUE_BODY, 'Outcome'), 'A working thing.');
});

// ---------------------------------------------------------------------------
// Protocol scheme/version (audit item 5)
// ---------------------------------------------------------------------------

test('16g. a marker without a SCHEME line is malformed and never counts', () => {
  const s = validState();
  const noScheme = marker(MARKERS.gemini, { key: GEMINI_KEY }).replace(`SCHEME: ${SCHEME}\n`, '');
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: noScheme },
  ];
  expectBlock(s, 'GEMINI_MALFORMED');
});

test('16h. an unknown/future scheme is rejected even with a valid-looking signature', () => {
  const s = validState();
  const future = marker(MARKERS.gemini, { key: GEMINI_KEY }).replace(
    `SCHEME: ${SCHEME}`,
    'SCHEME: REKODA_AGENT_EVIDENCE_V9',
  );
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: future },
  ];
  expectBlock(s, 'GEMINI_MALFORMED');
  const sc = validState();
  sc.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex).replace(`SCHEME: ${SCHEME}`, 'SCHEME: OTHER') }),
  ];
  expectBlock(sc, 'TECH_MALFORMED');
});

test('16i. a contract marker with a wrong scheme does not count', () => {
  const s = validState();
  const c = contractComment();
  c.body = c.body.replace(`SCHEME: ${SCHEME}`, 'SCHEME: NOPE');
  s.issue.comments = [c];
  expectBlock(s, 'CONTRACT_BASELINE_MISSING');
});

// ---------------------------------------------------------------------------
// Sticky governance: complete history or fail closed (audit item 10)
// ---------------------------------------------------------------------------

test('11g/12g. incomplete or failed enrollment history fails CLOSED, never neutral', () => {
  const s = validState();
  s.pr.riskLabels = [];
  s.pr.builderLabels = [];
  s.prBody = 'Nothing here.';
  s.issue = null;
  s.pr.enrollment = { everLabeledAgent: false, complete: false }; // pagination not exhausted / API failure
  assert.equal(isGoverned(s), true);
  expectBlock(s, 'ENROLLMENT_HISTORY_INCOMPLETE', 'policy');
  // reviewer gates also refuse while governance is unprovable
  expectBlock(s, 'ENROLLMENT_HISTORY_INCOMPLETE', 'technical');
  expectBlock(s, 'ENROLLMENT_HISTORY_INCOMPLETE', 'acceptance');
});

// ---------------------------------------------------------------------------
// Verdict ordering across id domains (audit item 15)
// ---------------------------------------------------------------------------

test('15g. contradictory contemporaneous verdicts across id domains fail closed', () => {
  const t = '2026-09-02T00:00:00Z';
  const s = codexBuiltState();
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: t,
      id: 5,
      body: marker(MARKERS.claude, {
        key: CLAUDE_KEY,
        verdict: 'APPROVE',
        contractHash: CODEX_CONTRACT_HASH,
      }),
    },
    {
      author: ACTIONS,
      kind: 'review',
      createdAt: t,
      id: 999999,
      body: marker(MARKERS.claude, {
        key: CLAUDE_KEY,
        verdict: 'BLOCK',
        contractHash: CODEX_CONTRACT_HASH,
      }),
    },
  ];
  expectBlock(s, 'TECH_AMBIGUOUS_ORDER');
});

test('15h. contemporaneous agreeing verdicts across domains are fine; a later one still governs', () => {
  const t = '2026-09-02T00:00:00Z';
  const s = codexBuiltState();
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: t,
      id: 5,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY, contractHash: CODEX_CONTRACT_HASH }),
    },
    {
      author: ACTIONS,
      kind: 'review',
      createdAt: t,
      id: 999999,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY, contractHash: CODEX_CONTRACT_HASH }),
    },
  ];
  assert.equal(evaluate(s).pass, true);
  s.techEvidence.candidates.push({
    author: ACTIONS,
    kind: 'comment',
    createdAt: '2026-09-03T00:00:00Z',
    id: 6,
    body: marker(MARKERS.claude, {
      key: CLAUDE_KEY,
      verdict: 'BLOCK',
      contractHash: CODEX_CONTRACT_HASH,
    }),
  });
  expectBlock(s, 'TECH_BLOCK'); // clearly-later valid verdict wins
});

// ---------------------------------------------------------------------------
// Build admission (audit items 8/11) — the no-secret preflight's brain
// ---------------------------------------------------------------------------

const OK_CONTRACT = { baselineFound: true, invalid: null, amended: false, revision: 1 };

const readyIssue = (over = {}) => ({
  number: 60,
  exists: true,
  state: 'open',
  agentTask: true,
  labels: ['agent-task', 'risk:R1', 'builder:claude', 'status:ready'],
  riskLabels: ['risk:R1'],
  builderLabels: ['builder:claude'],
  ...over,
});

test('a valid READY builder:claude issue is admitted when the lane is free', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.deepEqual(r, { admit: true, reasons: [] });
});

test('6g. an unrelated/non-agent issue is rejected', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue({ agentTask: false, labels: ['status:ready'] }),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.equal(r.admit, false);
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_NOT_AGENT_TASK'));
});

test('7g. a builder:codex issue never admits the Claude builder', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue({
      builderLabels: ['builder:codex'],
      labels: ['agent-task', 'risk:R1', 'builder:codex', 'status:ready'],
    }),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_WRONG_BUILDER'));
});

test('8g. a closed or missing issue is rejected', () => {
  assert.ok(
    evaluateBuildAdmission({
      contract: OK_CONTRACT,
      issue: readyIssue({ state: 'closed' }),
      requiredBuilder: 'builder:claude',
      openLanes: [],
    }).reasons.some((x) => x.code === 'ADMIT_ISSUE_NOT_OPEN'),
  );
  assert.ok(
    evaluateBuildAdmission({
      contract: OK_CONTRACT,
      issue: null,
      requiredBuilder: 'builder:claude',
      openLanes: [],
    }).reasons.some((x) => x.code === 'ADMIT_ISSUE_NOT_FOUND'),
  );
});

test('9g. blocked-decision / needs-owner-decision issues are rejected', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue({
      labels: [
        'agent-task',
        'risk:R1',
        'builder:claude',
        'status:ready',
        'status:blocked-decision',
      ],
    }),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_BLOCKED_DECISION'));
});

test('a not-READY issue is rejected', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue({ labels: ['agent-task', 'risk:R1', 'builder:claude', 'backlog'] }),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_NOT_READY'));
});

test('13g2. an occupied implementation lane rejects a second admission', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [{ issue: 44, status: 'status:in-review' }],
  });
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_LANE_OCCUPIED'));
});

// ---------------------------------------------------------------------------
// Contract-authority amendment authorization (audit item 12)
// ---------------------------------------------------------------------------

test('14g2. contract amendments are owner-only; write collaborators are rejected', () => {
  assert.equal(isContractAmendmentAuthorized(OWNER, OWNER), true);
  for (const actor of ['some-collaborator', ACTIONS, 'claude[bot]', '', undefined])
    assert.equal(isContractAmendmentAuthorized(actor, OWNER), false, String(actor));
});

// ---------------------------------------------------------------------------
// Authority/watch redispatch targeting (audit items 4/5)
// ---------------------------------------------------------------------------

test('4g. linkedOpenPrs finds exactly the open PRs closing the changed issue', () => {
  const prs = [
    { number: 70, body: 'Closes #44' },
    { number: 71, body: 'Fixes #45' },
    { number: 72, body: 'refs #44 only' },
    { number: 73, body: 'Resolves #44 and more text' },
  ];
  assert.deepEqual(linkedOpenPrs(prs, 44), [70, 73]);
  assert.deepEqual(linkedOpenPrs(prs, 99), []);
});

test('5g. a signed revision invalidates same-HEAD approvals regardless of comment-event delivery', () => {
  // The dispatch is direct (no reliance on GITHUB_TOKEN comment events);
  // the policy consequence is provable purely: same HEAD + revision 2 ⇒
  // both rev-1 approvals stale until re-issued.
  const s = validState();
  const newBody = ISSUE_BODY + '\n\nAuthorized change.';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 2,
      createdAt: 'y',
    }),
  ];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_REVISION') && codes(r).includes('GEMINI_WRONG_REVISION'));
});

// ---------------------------------------------------------------------------
// Phase-2: workflow_run target resolution (activation blocker 1)
// ---------------------------------------------------------------------------

const cand = (over = {}) => ({
  number: 90,
  state: 'open',
  headSha: HEAD,
  baseRepo: 'AngeloAkuhwa/rekoda',
  ...over,
});

test('workflow_run resolver: exactly one matching open candidate resolves', () => {
  assert.deepEqual(
    resolveWorkflowRunTarget({ headSha: HEAD, candidates: [cand()], repo: 'AngeloAkuhwa/rekoda' }),
    { pr: 90, status: 'ok' },
  );
});

test('workflow_run resolver: zero candidates → none (nothing to evaluate)', () => {
  assert.equal(
    resolveWorkflowRunTarget({ headSha: HEAD, candidates: [], repo: 'x/y' }).status,
    'none',
  );
  assert.equal(
    resolveWorkflowRunTarget({
      headSha: HEAD,
      candidates: [cand({ state: 'closed' })],
      repo: 'AngeloAkuhwa/rekoda',
    }).status,
    'none',
  );
});

test('workflow_run resolver: multiple open candidates → ambiguous, fail closed', () => {
  const r = resolveWorkflowRunTarget({
    headSha: HEAD,
    candidates: [cand(), cand({ number: 91 })],
    repo: 'AngeloAkuhwa/rekoda',
  });
  assert.deepEqual(r, { pr: null, status: 'ambiguous' });
});

test('workflow_run resolver: force-pushed candidate (current HEAD moved) → stale, do not evaluate', () => {
  const r = resolveWorkflowRunTarget({
    headSha: OLD_HEAD,
    candidates: [cand()], // candidate now at HEAD, run was for OLD_HEAD
    repo: 'AngeloAkuhwa/rekoda',
  });
  assert.deepEqual(r, { pr: 90, status: 'stale' });
});

test('workflow_run resolver: wrong-base-repo candidate is not a target', () => {
  const r = resolveWorkflowRunTarget({
    headSha: HEAD,
    candidates: [cand({ baseRepo: 'someone/else' })],
    repo: 'AngeloAkuhwa/rekoda',
  });
  assert.equal(r.status, 'none');
});

test('workflow_run resolver: malformed triggering SHA resolves nothing', () => {
  assert.equal(
    resolveWorkflowRunTarget({ headSha: 'not-a-sha', candidates: [cand()] }).status,
    'none',
  );
});

// ---------------------------------------------------------------------------
// Phase-2: signer-time independent revalidation (activation blocker 2)
// ---------------------------------------------------------------------------

test('an unsigned AI verdict cannot choose its target: only markers matching the FRESH target count', () => {
  // The signing job binds evidence to freshly re-resolved values; a
  // verdict naming an attacker-chosen PR/HEAD/revision is exactly a
  // mistargeted marker, which the evaluator rejects wholesale.
  const s = codexBuiltState();
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY, pr: 999 }),
    },
  ];
  expectBlock(s, 'TECH_WRONG_PR');
});

test('HEAD moved between AI review and signing → the signed-late verdict is stale for the new HEAD', () => {
  const s = codexBuiltState();
  s.pr.headSha = 'd'.repeat(40); // push landed after the AI reviewed
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_APPROVAL_STALE'));
});

test('contract revision moved between AI review and signing → verdict binds the old revision and is rejected', () => {
  const s = codexBuiltState();
  const newBody = ISSUE_BODY + '\n\nRevised mid-review.';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment({ builder: 'builder:codex' }),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      builder: 'builder:codex',
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 2,
      createdAt: 'y',
    }),
  ];
  expectBlock(s, 'TECH_WRONG_REVISION');
});

// ---------------------------------------------------------------------------
// Phase-2: baseline before admission (activation blocker 5)
// ---------------------------------------------------------------------------

test('admission without a contract baseline is refused — no lane claim, no builder', () => {
  const r = evaluateBuildAdmission({
    contract: { baselineFound: false, invalid: null, amended: false },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.equal(r.admit, false);
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_BASELINE_MISSING'));
  const r2 = evaluateBuildAdmission({
    contract: undefined,
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(r2.reasons.some((x) => x.code === 'ADMIT_BASELINE_MISSING'));
});

test('admission with an invalid or amended contract is refused', () => {
  const bad = evaluateBuildAdmission({
    contract: {
      baselineFound: true,
      invalid: 'conflicting markers for revision 2',
      amended: false,
    },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(bad.reasons.some((x) => x.code === 'ADMIT_CONTRACT_INVALID'));
  const amended = evaluateBuildAdmission({
    contract: { baselineFound: true, invalid: null, amended: true },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(amended.reasons.some((x) => x.code === 'ADMIT_CONTRACT_INVALID'));
});

test('admission with a valid baseline (and everything else) is granted', () => {
  const r = evaluateBuildAdmission({
    contract: { baselineFound: true, invalid: null, amended: false, revision: 1 },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.deepEqual(r, { admit: true, reasons: [] });
});

// ---------------------------------------------------------------------------
// Phase-2: complete linked-PR pagination (activation blocker 4)
// ---------------------------------------------------------------------------

test('linked-PR selection finds PRs beyond the first page and fails closed on incomplete listings', () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: 'unrelated' }));
  const page2 = [{ number: 150, body: 'Closes #44' }];
  const all = [...page1, ...page2];
  assert.deepEqual(selectLinkedPrs({ openPrs: all, complete: true, issueNumber: 44 }), {
    ok: true,
    prs: [150],
  });
  assert.deepEqual(selectLinkedPrs({ openPrs: all, complete: true, issueNumber: 9999 }), {
    ok: true,
    prs: [],
  });
  const incomplete = selectLinkedPrs({ openPrs: page1, complete: false, issueNumber: 44 });
  assert.equal(incomplete.ok, false); // pagination ceiling / API failure → never silently miss a PR
});

// ---------------------------------------------------------------------------
// D1 — authoritative contract transitions and the freeze-before-mutate
// transaction (final Phase-2 audit)
// ---------------------------------------------------------------------------

test('an owner-authored UNSIGNED revision comment is a PROPOSAL, never the active contract', () => {
  const v2 = ISSUE_BODY + '\n\nProposed change.';
  // Unit: with the body unchanged, the owner-unsigned rev-2 marker does
  // not move the active revision.
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [
      contractComment(),
      contractComment({
        kind: 'REKODA_CONTRACT_REVISION',
        revision: 2,
        body: v2,
        author: OWNER,
        id: 2,
      }),
    ],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(rev.revision, 1);
  // Full gate: with the body ALSO edited, nothing silently transitions —
  // the previous contract stays active and the mismatch blocks.
  const s = validState();
  s.issue.body = v2;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: v2,
      author: OWNER,
      id: 2,
    }),
  ];
  expectBlock(s, 'CONTRACT_AMENDED_UNAUTHORIZED');
});

test('a direct issue-body edit alone never replaces the active merge contract', () => {
  const s = validState();
  s.issue.body = ISSUE_BODY + '\n\nEdited without any transaction.';
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('CONTRACT_AMENDED_UNAUTHORIZED'));
  // and the reviewer approvals for revision 1 do not validate a new contract:
  assert.ok(!codes(r).includes('TECH_WRONG_REVISION')); // no rev-2 exists to bind to
});

test('unprovably complete comment history yields no revision and blocks', () => {
  const s = validState();
  s.issue.commentsComplete = false;
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('CONTRACT_HISTORY_INVALID'));
});

test('amendment transaction: sign only after the freeze marker is durable AND every barrier completed', () => {
  const ok = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeMarkerPosted: true,
    barrierResults: { 70: true, 73: true },
    signOk: true,
    dispatchResults: { 70: true, 73: true },
  });
  assert.deepEqual(ok, {
    signed: true,
    barriered: [70, 73],
    dispatched: [70, 73],
    state: 'complete',
  });
});

test('amendment transaction: no durable freeze marker → nothing signed, nothing mutated', () => {
  const r = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeMarkerPosted: false,
    barrierResults: {},
    signOk: true,
    dispatchResults: {},
  });
  assert.deepEqual(r, {
    signed: false,
    barriered: [],
    dispatched: [],
    state: 'aborted_before_freeze',
  });
});

test('amendment transaction: a failed barrier forbids signing; the freeze keeps every linked PR evaluator-blocked', () => {
  const r = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeMarkerPosted: true,
    barrierResults: { 70: true, 73: false },
    signOk: true,
    dispatchResults: {},
  });
  assert.equal(r.signed, false);
  assert.equal(r.state, 'frozen_blocked');
  assert.deepEqual(r.barriered, [70]);
  assert.deepEqual(r.dispatched, []);
});

test('amendment transaction: barriers ok but signing fails → freeze stays active, PRs remain blocked, never re-green', () => {
  const r = amendmentTransaction({
    linkedPrs: [70],
    freezeMarkerPosted: true,
    barrierResults: { 70: true },
    signOk: false,
    dispatchResults: {},
  });
  assert.equal(r.signed, false);
  assert.equal(r.state, 'frozen_blocked');
});

test('amendment transaction: dispatch failure after signing leaves the PR blocked (wrong revision), not green', () => {
  const r = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeMarkerPosted: true,
    barrierResults: { 70: true, 73: true },
    signOk: true,
    dispatchResults: { 70: true, 73: false },
  });
  assert.equal(r.signed, true);
  assert.equal(r.state, 'signed_awaiting_dispatch');
  assert.deepEqual(r.dispatched, [70]);
});

test('a baseline deep in a very large comment history is still found (position-independent)', () => {
  const noise = Array.from({ length: 350 }, (_, i) => ({
    author: 'someone',
    createdAt: `t${i}`,
    id: i + 100,
    body: `comment ${i}`,
  }));
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [...noise, contractComment({ id: 9999 })],
    ownerLogin: OWNER,
    contractAuthorityKey: null,
  });
  assert.equal(rev.revision, 1);
  assert.equal(rev.amended, false);
});

// ---------------------------------------------------------------------------
// V2 evidence — verdicts bind the CONTRACT SNAPSHOT HASH, not just a number
// ---------------------------------------------------------------------------

test('a verdict binding a DIFFERENT contract snapshot hash blocks (wrong contract, right revision number)', () => {
  const s = validState();
  const foreign = sha256Hex(normalizeBody(ISSUE_BODY + '\n\nSomething else entirely.'));
  s.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex, { contractHash: foreign }) }),
  ];
  s.geminiEvidence.candidates[0].body = marker(MARKERS.gemini, {
    key: GEMINI_KEY,
    contractHash: foreign,
  });
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_CONTRACT'));
  assert.ok(codes(r).includes('GEMINI_WRONG_CONTRACT'));
});

test('A→B→A: a verdict signed for snapshot B never authorizes after the contract returns to A', () => {
  // The issue body went A → B (authorized revision 2) → A (authorized
  // revision 3). A reviewer verdict produced under B binds B's hash and
  // revision 2; after the return to A it must not count — on EITHER axis.
  const bodyA = ISSUE_BODY;
  const bodyB = ISSUE_BODY + '\n\nTemporary requirement.';
  const hashB = snapHash({ revision: 2, body: bodyB });
  const s = validState();
  s.issue.body = bodyA;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: bodyB,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 2,
      createdAt: 'y',
    }),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 3,
      body: bodyA,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 3,
      createdAt: 'z',
    }),
  ];
  s.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex, { rev: 2, contractHash: hashB }) }),
  ];
  s.geminiEvidence.candidates[0].body = marker(MARKERS.gemini, {
    rev: 2,
    contractHash: hashB,
    key: GEMINI_KEY,
  });
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_REVISION') || codes(r).includes('TECH_WRONG_CONTRACT'));
  assert.ok(
    codes(r).includes('GEMINI_WRONG_REVISION') || codes(r).includes('GEMINI_WRONG_CONTRACT'),
  );
});

test('a V1-shaped marker (no CONTRACT_BODY_SHA256 line) is malformed evidence under V2', () => {
  const s = validState();
  const v1Lines = [
    MARKERS.gemini,
    `SCHEME: ${SCHEME}`,
    'PR: 55',
    'ISSUE: 44',
    `HEAD_SHA: ${HEAD}`,
    'CONTRACT_REVISION: 1',
    'VERDICT: APPROVE',
  ].join('\n');
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: v1Lines },
  ];
  expectBlock(s, 'GEMINI_MALFORMED');
});

test('a marker carrying the old V1 scheme string is rejected even with every V2 field present', () => {
  const s = validState();
  const oldScheme = marker(MARKERS.gemini, { key: GEMINI_KEY }).replace(
    `SCHEME: ${SCHEME}`,
    'SCHEME: REKODA_AGENT_EVIDENCE_V1',
  );
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: oldScheme },
  ];
  expectBlock(s, 'GEMINI_MALFORMED');
});

// ---------------------------------------------------------------------------
// END-TO-END with the REAL generators — the published bytes are the parsed
// bytes: generator → parser → verifier → policy, no hand-built fixtures
// ---------------------------------------------------------------------------

test('E2E: real baseline generator output → parseRevisionMarkers → signature → revision 1 → build admission', () => {
  // EXACTLY what contract-revision.mjs posts: the shared generator's
  // lines, signed over the canonical payload, wrapped in a code fence.
  const m = {
    kind: 'REKODA_CONTRACT_BASELINE',
    issue: 44,
    revision: 1,
    risk: 'risk:R1',
    builder: 'builder:claude',
    bodySha256: sha256Hex(normalizeBody(ISSUE_BODY)),
    reason: '',
  };
  const signature = signWith(AUTHORITY_KEY, canonicalContractPayload(m));
  const posted = '```\n' + buildContractMarkerLines(m, signature).join('\n') + '\n```';

  const parsed = parseRevisionMarkers(posted);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].malformed, false, 'the generated baseline must parse clean');
  assert.equal(parsed[0].scheme, SCHEME);
  assert.equal(parsed[0].kind, 'REKODA_CONTRACT_BASELINE');
  assert.equal(parsed[0].risk, 'risk:R1');
  assert.equal(parsed[0].builder, 'builder:claude');
  assert.ok(
    verifySignature(canonicalContractPayload(parsed[0]), parsed[0].signature, pem(AUTHORITY_KEY)),
    'the parsed marker must re-verify against the authority key',
  );

  const contract = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [{ author: ACTIONS, createdAt: 'x', id: 1, body: posted }],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude', 'status:ready'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(contract.revision, 1);
  assert.equal(contract.amended, false);
  assert.equal(contract.labelsDiverged, false);
  assert.equal(contract.invalid, null);
  assert.equal(contract.snapshotHash, CONTRACT_HASH);

  const admission = evaluateBuildAdmission({
    contract,
    issue: readyIssue({ number: 44 }),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.deepEqual(admission, { admit: true, reasons: [] });
});

test('E2E: real revision generator output advances the computed revision to 2', () => {
  const newBody = ISSUE_BODY + '\n\nAuthorized amendment.';
  const m2 = {
    kind: 'REKODA_CONTRACT_REVISION',
    issue: 44,
    revision: 2,
    risk: 'risk:R1',
    builder: 'builder:claude',
    bodySha256: sha256Hex(normalizeBody(newBody)),
    reason: 'scope change',
  };
  const posted2 =
    '```\n' +
    buildContractMarkerLines(m2, signWith(AUTHORITY_KEY, canonicalContractPayload(m2))).join('\n') +
    '\n```';
  const contract = computeContractRevision({
    issueNumber: 44,
    issueBody: newBody,
    issueComments: [contractComment(), { author: ACTIONS, createdAt: 'y', id: 2, body: posted2 }],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude', 'status:in-review'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(contract.revision, 2);
  assert.equal(contract.amended, false);
  assert.equal(contract.expectedHash, m2.bodySha256);
  assert.equal(contract.snapshotHash, snapHash({ revision: 2, body: newBody }));
});

test('E2E: real verdict generator output → parseMarkers → resolveVerdict APPROVE against the matching target', () => {
  // EXACTLY what sign-evidence.mjs prints: the shared generator's lines
  // in a fence, followed by the findings text.
  const m = {
    name: MARKERS.gemini,
    pr: 55,
    issue: 44,
    headSha: HEAD,
    contractRevision: 1,
    contractSnapshotSha256: CONTRACT_HASH,
    verdict: 'APPROVE',
  };
  const signature = signWith(GEMINI_KEY, canonicalVerdictPayload(m));
  const posted = [
    '```',
    ...buildVerdictMarkerLines(m, signature),
    '```',
    '',
    'No blocking findings.',
  ].join('\n');

  const parsed = parseMarkers(posted, MARKERS.gemini);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].malformed, false, 'the generated verdict must parse clean');
  assert.equal(parsed[0].contractSnapshotSha256, CONTRACT_HASH);

  const r = resolveVerdict({
    candidates: [{ author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: posted }],
    markerName: MARKERS.gemini,
    provenance: { kind: 'signature', publicKey: pem(GEMINI_KEY) },
    target: {
      pr: 55,
      issue: 44,
      headSha: HEAD,
      contractRevision: 1,
      contractSnapshotSha256: CONTRACT_HASH,
    },
  });
  assert.equal(r.verdict, 'APPROVE');
});

test('E2E: the same real generator output resolves to NO verdict for a different contract snapshot', () => {
  const m = {
    name: MARKERS.gemini,
    pr: 55,
    issue: 44,
    headSha: HEAD,
    contractRevision: 1,
    contractSnapshotSha256: CONTRACT_HASH,
    verdict: 'APPROVE',
  };
  const posted = [
    '```',
    ...buildVerdictMarkerLines(m, signWith(GEMINI_KEY, canonicalVerdictPayload(m))),
    '```',
  ].join('\n');
  const r = resolveVerdict({
    candidates: [{ author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: posted }],
    markerName: MARKERS.gemini,
    provenance: { kind: 'signature', publicKey: pem(GEMINI_KEY) },
    target: {
      pr: 55,
      issue: 44,
      headSha: HEAD,
      contractRevision: 1,
      contractSnapshotSha256: snapHash({ body: ISSUE_BODY + '\n\nMoved on.' }),
    },
  });
  assert.equal(r.verdict ?? null, null);
});

// ---------------------------------------------------------------------------
// workflow_run resolver — exhaustive-listing semantics (later pages)
// ---------------------------------------------------------------------------

test('resolver: an INCOMPLETE candidate listing is unprovable — fail closed, never guess', () => {
  const r = resolveWorkflowRunTarget({
    headSha: HEAD,
    candidates: [cand()],
    repo: 'AngeloAkuhwa/rekoda',
    complete: false,
  });
  assert.deepEqual(r, { pr: null, status: 'unprovable' });
});

test('resolver: the true candidate deep in a multi-page listing still resolves to exactly one PR', () => {
  const candidates = Array.from({ length: 250 }, (_, i) =>
    cand({ number: i + 1, state: 'closed', headSha: OLD_HEAD }),
  );
  candidates.push(cand({ number: 251 })); // the single open match, "page 3"
  assert.deepEqual(
    resolveWorkflowRunTarget({
      headSha: HEAD,
      candidates,
      repo: 'AngeloAkuhwa/rekoda',
      complete: true,
    }),
    { pr: 251, status: 'ok' },
  );
});

test('resolver: a second open candidate on a later page makes the request ambiguous over the COMPLETE set', () => {
  const candidates = Array.from({ length: 120 }, (_, i) =>
    cand({ number: i + 1, state: 'closed', headSha: OLD_HEAD }),
  );
  candidates[0] = cand({ number: 1 }); // page-1 open match
  candidates.push(cand({ number: 121 })); // page-2 open match
  assert.deepEqual(
    resolveWorkflowRunTarget({
      headSha: HEAD,
      candidates,
      repo: 'AngeloAkuhwa/rekoda',
      complete: true,
    }),
    { pr: null, status: 'ambiguous' },
  );
});

// ---------------------------------------------------------------------------
// chooseCheckAction — fail-closed upsert decision with app verification
// ---------------------------------------------------------------------------

test('check upsert: a failed lookup ABORTS a passing conclusion — absence of green already blocks; no blind duplicate-passing', () => {
  for (const conclusion of ['success', 'neutral']) {
    const d = chooseCheckAction({
      lookupOk: false,
      runs: [],
      name: 'Technical Review Gate',
      conclusion,
    });
    assert.equal(d.action, 'abort', `${conclusion} must abort on lookup failure`);
  }
});

test('check upsert: a failed lookup NEVER abandons a FAILURE — the revocation posts blind and the newest run governs', () => {
  // The stale-green scenario: an old SUCCESS exists on this HEAD, the
  // current state says BLOCK, and the read needed to find the old run
  // fails. Abandoning the write would leave the old green
  // merge-authorizing; instead the failure is POSTed blind — GitHub
  // evaluates the most recent run per (name, app), so the new failure
  // governs the required check.
  const d = chooseCheckAction({
    lookupOk: false,
    runs: [],
    name: 'Technical Review Gate',
    conclusion: 'failure',
  });
  assert.equal(d.action, 'post');
  assert.equal(d.degraded, true);
});

test('check upsert: an existing GitHub-Actions run of the same name is PATCHed in place', () => {
  const d = chooseCheckAction({
    lookupOk: true,
    runs: [
      { id: 7, name: 'Some other check', appSlug: 'github-actions' },
      { id: 9, name: 'Technical Review Gate', appSlug: 'github-actions' },
    ],
    name: 'Technical Review Gate',
  });
  assert.deepEqual(d, { action: 'patch', id: 9 });
});

test('check upsert: a same-name run from a FOREIGN app is never adopted — a fresh run is created', () => {
  const d = chooseCheckAction({
    lookupOk: true,
    runs: [{ id: 13, name: 'Technical Review Gate', appSlug: 'evil-third-party-app' }],
    name: 'Technical Review Gate',
  });
  assert.deepEqual(d, { action: 'post' });
});

test('check upsert: no existing run at all → create', () => {
  assert.deepEqual(chooseCheckAction({ lookupOk: true, runs: [], name: 'Agent policy gate' }), {
    action: 'post',
  });
});

// ---------------------------------------------------------------------------
// readyPromotionAction — both label orderings promote; the decision reads
// the RE-FETCHED labels, never the single triggering event
// ---------------------------------------------------------------------------

test('READY promotion: builder label first, then status:ready — proceeds and dispatches Claude', () => {
  const d = readyPromotionAction({
    labels: ['agent-task', 'risk:R1', 'builder:claude', 'status:ready'],
  });
  assert.deepEqual(d, {
    proceed: true,
    dispatchClaude: true,
    risk: 'risk:R1',
    builder: 'builder:claude',
  });
});

test('READY promotion: status:ready first, then builder label — the later builder event still promotes', () => {
  // Same final label set regardless of arrival order; the builder:claude
  // "labeled" event re-fetches and sees status:ready already present.
  const d = readyPromotionAction({
    labels: ['status:ready', 'agent-task', 'risk:R2', 'builder:claude'],
  });
  assert.deepEqual(d, {
    proceed: true,
    dispatchClaude: true,
    risk: 'risk:R2',
    builder: 'builder:claude',
  });
});

test('READY promotion: builder:codex proceeds but never dispatches the Claude builder', () => {
  const d = readyPromotionAction({
    labels: ['agent-task', 'risk:R1', 'status:ready', 'builder:codex'],
  });
  assert.deepEqual(d, {
    proceed: true,
    dispatchClaude: false,
    risk: 'risk:R1',
    builder: 'builder:codex',
  });
});

test('READY promotion: missing pieces or ambiguous builders never proceed', () => {
  assert.equal(readyPromotionAction({ labels: ['agent-task', 'builder:claude'] }).proceed, false);
  assert.equal(readyPromotionAction({ labels: ['status:ready', 'builder:claude'] }).proceed, false);
  assert.equal(readyPromotionAction({ labels: ['agent-task', 'status:ready'] }).proceed, false);
  assert.equal(
    readyPromotionAction({
      labels: ['agent-task', 'status:ready', 'builder:claude', 'builder:codex'],
    }).proceed,
    false,
  );
});

// ---------------------------------------------------------------------------
// V3 — the native Codex marker contract (AGENTS.md documents EXACTLY this)
// ---------------------------------------------------------------------------

test('the DOCUMENTED native Codex V3 block parses and resolves to APPROVE with platform provenance', () => {
  // Byte-for-byte the block AGENTS.md instructs native Codex to emit,
  // with values copied from review-context output.
  const documented = [
    'REKODA_CODEX_APPROVAL',
    `SCHEME: ${SCHEME}`,
    'PR: 55',
    'ISSUE: 44',
    `HEAD_SHA: ${HEAD}`,
    'CONTRACT_REVISION: 1',
    `CONTRACT_SNAPSHOT_SHA256: ${CONTRACT_HASH}`,
    'VERDICT: APPROVE',
  ].join('\n');
  const r = resolveVerdict({
    candidates: [
      {
        author: CODEX,
        kind: 'review',
        reviewState: 'COMMENTED',
        commitId: HEAD,
        createdAt: 'x',
        id: 1,
        body: `Findings: none.\n\n${documented}`,
      },
    ],
    markerName: MARKERS.codex,
    provenance: { kind: 'codex', login: CODEX },
    target: {
      pr: 55,
      issue: 44,
      headSha: HEAD,
      contractRevision: 1,
      contractSnapshotSha256: CONTRACT_HASH,
    },
  });
  assert.equal(r.verdict, 'APPROVE');
  // …and end-to-end through evaluate(): a full valid state whose only
  // technical evidence is the documented block.
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({
      body: `${documented}\n`,
    }),
  ];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

test('the OLD documented Codex block (no SCHEME, no snapshot hash) is malformed and blocks', () => {
  const old = [
    'REKODA_CODEX_APPROVAL',
    'PR: 55',
    'ISSUE: 44',
    `HEAD_SHA: ${HEAD}`,
    'CONTRACT_REVISION: 1',
    'VERDICT: APPROVE',
  ].join('\n');
  const s = validState();
  s.techEvidence.candidates = [codexReview({ body: old })];
  expectBlock(s, 'TECH_MALFORMED');
});

test('a native Codex block binding the WRONG snapshot hash blocks (TECH_WRONG_CONTRACT)', () => {
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({
      body: marker(MARKERS.codex, { contractHash: snapHash({ body: ISSUE_BODY + '\n\nOther.' }) }),
    }),
  ];
  expectBlock(s, 'TECH_WRONG_CONTRACT');
});

// ---------------------------------------------------------------------------
// V3 — risk/builder are part of the signed contract snapshot
// ---------------------------------------------------------------------------

test('a risk label change WITHOUT an authorized revision blocks even with issue and PR consistent', () => {
  const s = validState();
  // Someone flips BOTH issue and PR labels R1 → R2 consistently; the body
  // hash and revision are untouched, and old approvals bind them.
  s.pr.riskLabels = ['risk:R2'];
  s.issue.riskLabels = ['risk:R2'];
  s.issue.labels = ['agent-task', 'risk:R2', 'builder:claude', 'status:in-review'];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('CONTRACT_LABELS_DIVERGED'));
  // and no mode is exempt — the finalizer computes all three from this state
  for (const mode of ['policy', 'technical', 'acceptance']) {
    assert.equal(evaluate(s, mode).pass, false, `mode ${mode} must block`);
  }
});

test('a builder label change WITHOUT an authorized revision blocks (old approvals cannot survive)', () => {
  const s = validState();
  s.pr.builderLabels = ['builder:codex'];
  s.issue.builderLabels = ['builder:codex'];
  s.issue.labels = ['agent-task', 'risk:R1', 'builder:codex', 'status:in-review'];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('CONTRACT_LABELS_DIVERGED'));
});

test('an authorized revision RECORDING the new labels re-activates the contract — but demands fresh evidence', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R2'];
  s.issue.riskLabels = ['risk:R2'];
  s.issue.labels = ['agent-task', 'risk:R2', 'builder:claude', 'status:in-review'];
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      risk: 'risk:R2',
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 2,
      createdAt: 'y',
    }),
  ];
  // The old rev-1 evidence no longer matches the rev-2 snapshot…
  const stale = evaluate(s);
  assert.equal(stale.pass, false);
  assert.ok(
    codes(stale).includes('TECH_WRONG_REVISION') || codes(stale).includes('TECH_WRONG_CONTRACT'),
  );
  // …fresh evidence binding the new snapshot passes.
  const h2 = snapHash({ revision: 2, risk: 'risk:R2' });
  s.techEvidence.candidates = [
    codexReview({
      id: 12,
      createdAt: 'z',
      body: marker(MARKERS.codex, { rev: 2, contractHash: h2 }),
    }),
  ];
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'z',
      id: 21,
      body: marker(MARKERS.gemini, { rev: 2, contractHash: h2, key: GEMINI_KEY }),
    },
  ];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

// ---------------------------------------------------------------------------
// V3 — the amendment freeze is EVALUATOR state, not just red check writes
// ---------------------------------------------------------------------------

/** An authority-signed freeze comment via the REAL generator. */
function freezeComment({ issue = 44, from = 1, target = 2, key = AUTHORITY_KEY, id = 5 } = {}) {
  const f = { issue, fromRevision: from, targetRevision: target };
  const signature = key ? signWith(key, canonicalFreezePayload(f)) : undefined;
  return {
    author: ACTIONS,
    createdAt: 'f',
    id,
    body: '```\n' + buildFreezeMarkerLines(f, signature).join('\n') + '\n```',
  };
}

test('a signed amendment freeze blocks EVERY gate mode — a rev-N publisher cannot conclude green mid-amendment', () => {
  const s = validState(); // rev-1 contract, valid rev-1 evidence — would pass
  assert.equal(evaluate(s).pass, true);
  s.issue.comments = [...s.issue.comments, freezeComment()];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('CONTRACT_AMENDMENT_IN_PROGRESS'));
  for (const mode of ['policy', 'technical', 'acceptance']) {
    assert.equal(evaluate(s, mode).pass, false, `mode ${mode} must refuse green mid-amendment`);
  }
});

test('a HIGHER revision with an UNCHANGED body hash still yields no merge window', () => {
  // The amendment changes only revision+reason: body hash identical at
  // rev 1 and rev 2. During the freeze every mode blocks; after the
  // rev-2 marker exists the freeze expires but rev-1 evidence fails on
  // revision AND snapshot (revision is inside the snapshot payload).
  const s = validState();
  s.issue.comments = [...s.issue.comments, freezeComment()];
  assert.equal(evaluate(s).pass, false); // frozen
  s.issue.comments = [
    ...s.issue.comments,
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 6,
      createdAt: 'g',
    }),
  ];
  const after = evaluate(s);
  assert.equal(after.pass, false); // freeze expired, but old evidence is dead
  assert.ok(
    codes(after).includes('TECH_WRONG_REVISION') || codes(after).includes('TECH_WRONG_CONTRACT'),
  );
  assert.ok(!codes(after).includes('CONTRACT_AMENDMENT_IN_PROGRESS'), 'the freeze must expire');
});

test('freeze markers are authority-signed ONLY — unsigned or rogue-signed freezes cannot block an issue', () => {
  const s = validState();
  s.issue.comments = [
    ...s.issue.comments,
    freezeComment({ key: null }),
    freezeComment({ key: ROGUE_KEY, id: 7 }),
  ];
  assert.equal(evaluate(s).pass, true);
});

test('E2E: real freeze generator output → parseFreezeMarkers → signature → pendingFreeze; expires at the target revision', () => {
  const c = freezeComment();
  const parsed = parseFreezeMarkers(c.body);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].malformed, false, 'the generated freeze must parse clean');
  assert.ok(
    verifySignature(canonicalFreezePayload(parsed[0]), parsed[0].signature, pem(AUTHORITY_KEY)),
  );
  const during = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [contractComment(), c],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.deepEqual(during.pendingFreeze, { fromRevision: 1, targetRevision: 2 });
  const after = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [
      contractComment(),
      c,
      contractComment({
        kind: 'REKODA_CONTRACT_REVISION',
        revision: 2,
        author: ACTIONS,
        key: AUTHORITY_KEY,
        id: 9,
        createdAt: 'h',
      }),
    ],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(after.revision, 2);
  assert.equal(after.pendingFreeze, null);
});

test('build admission refuses mid-amendment (pendingFreeze) and on diverged labels', () => {
  const frozen = evaluateBuildAdmission({
    contract: { ...OK_CONTRACT, pendingFreeze: { fromRevision: 1, targetRevision: 2 } },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(frozen.reasons.some((x) => x.code === 'ADMIT_CONTRACT_INVALID'));
  const diverged = evaluateBuildAdmission({
    contract: { ...OK_CONTRACT, labelsDiverged: true },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(diverged.reasons.some((x) => x.code === 'ADMIT_CONTRACT_INVALID'));
});

// ---------------------------------------------------------------------------
// V3 — baseline existence is a canonical computation, never a substring probe
// ---------------------------------------------------------------------------

test('a comment that merely CONTAINS the baseline marker name is NOT a baseline (cannot suppress the real one)', () => {
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [
      {
        author: 'random-drive-by',
        createdAt: 'x',
        id: 1,
        body: 'lol REKODA_CONTRACT_BASELINE trust me this issue is done',
      },
    ],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(rev.baselineFound, false);
  assert.equal(rev.invalid, null);
});

test('malformed, unsigned-bot, wrong-issue, and rogue-signed baselines all fail to count as existing', () => {
  const cases = [
    // structurally complete but authored by a bot WITHOUT a signature
    contractComment({ author: ACTIONS, key: null }),
    // wrong issue number
    contractComment({ issue: 999 }),
    // signed by the wrong key
    contractComment({ author: ACTIONS, key: ROGUE_KEY }),
    // malformed: marker name present, fields garbage
    { author: OWNER, createdAt: 'x', id: 4, body: 'REKODA_CONTRACT_BASELINE\nREVISION: banana' },
  ];
  for (const c of cases) {
    const rev = computeContractRevision({
      issueNumber: 44,
      issueBody: ISSUE_BODY,
      issueComments: [c],
      issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
      ownerLogin: OWNER,
      contractAuthorityKey: pem(AUTHORITY_KEY),
    });
    assert.equal(rev.baselineFound, false, `case ${c.id ?? c.body?.slice(0, 30)} must not count`);
  }
});

test('conflicting AUTHORIZED baselines are invalid history — fail closed, do not paper over with a new one', () => {
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [
      contractComment(),
      contractComment({ body: ISSUE_BODY + '\n\nDifferent.', id: 2, createdAt: 'y' }),
    ],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(rev.revision, null);
  assert.ok(rev.invalid);
});

test('two authorized markers for one revision that disagree only on RISK or BUILDER conflict', () => {
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [contractComment(), contractComment({ risk: 'risk:R2', id: 2, createdAt: 'y' })],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(rev.revision, null);
  assert.ok(rev.invalid);
});

// ---------------------------------------------------------------------------
// Linked-PR JSON — [70,73] is 70 and 73, NEVER 7073
// ---------------------------------------------------------------------------

test('parsePrNumbersJson: [70,73] dispatches exactly 70 and 73 — never a concatenation', () => {
  assert.deepEqual(parsePrNumbersJson('[70,73]'), [70, 73]);
  assert.deepEqual(parsePrNumbersJson('[]'), []);
  assert.deepEqual(parsePrNumbersJson('[7073]'), [7073]); // a real single PR list stays itself
});

test('parsePrNumbersJson: anything but a JSON array of positive integers fails closed', () => {
  assert.equal(parsePrNumbersJson('7073'), null); // bare number is not a list
  assert.equal(parsePrNumbersJson('[70,"73"]'), null);
  assert.equal(parsePrNumbersJson('[70,0]'), null);
  assert.equal(parsePrNumbersJson('[70,-3]'), null);
  assert.equal(parsePrNumbersJson('[70,73.5]'), null);
  assert.equal(parsePrNumbersJson('70 73'), null);
  assert.equal(parsePrNumbersJson(''), null);
  assert.equal(parsePrNumbersJson(null), null);
});

// ---------------------------------------------------------------------------
// Governance is decided from CURRENT state — never a resolver-time snapshot
// ---------------------------------------------------------------------------

test('a PR ungoverned at resolve time that gains agent labels is governed on re-evaluation — never neutral-green', () => {
  // Resolver-time snapshot: a plain PR.
  const before = {
    pr: {
      riskLabels: [],
      builderLabels: [],
      enrollment: { everLabeledAgent: false, complete: true },
    },
    issue: null,
  };
  assert.equal(isGoverned(before), false);
  // The finalizer re-normalizes: the SAME PR now carries agent labels.
  const after = {
    ...before,
    pr: { ...before.pr, riskLabels: ['risk:R1'], builderLabels: ['builder:claude'] },
  };
  assert.equal(isGoverned(after), true);
  // …or now closes an agent-task issue.
  const viaIssue = { ...before, issue: { agentTask: true } };
  assert.equal(isGoverned(viaIssue), true);
  // …or its sticky label-event history is discovered late.
  const viaHistory = {
    ...before,
    pr: { ...before.pr, enrollment: { everLabeledAgent: true, complete: true } },
  };
  assert.equal(isGoverned(viaHistory), true);
  // Unprovable enrollment can never look neutral either.
  const unprovable = {
    ...before,
    pr: { ...before.pr, enrollment: { everLabeledAgent: false, complete: false } },
  };
  assert.equal(isGoverned(unprovable), true);
});

// ---------------------------------------------------------------------------
// Threat: a tampered PR-branch review-context helper cannot move the contract
// ---------------------------------------------------------------------------

test('THREAT: attacker-selected snapshot hash (tampered PR-branch helper) never validates — the target hash derives from issue state only', () => {
  // A Claude-built PR edits review-context.mjs to print an
  // attacker-chosen CONTRACT_SNAPSHOT_SHA256 with APPROVE instructions.
  // The gates compute the target snapshot hash from the ISSUE's signed
  // contract with trusted default-branch code — nothing in the PR's
  // file tree is an input to it — so a Codex marker binding the
  // attacker's hash is rejected, and only the true hash validates.
  const attackerHash = sha256Hex('attacker-selected value');
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex, { contractHash: attackerHash }) }),
  ];
  expectBlock(s, 'TECH_WRONG_CONTRACT');
  // The true hash (issue-derived) still validates — proving the target
  // came from the issue contract, not from any reviewed file content.
  s.techEvidence.candidates = [codexReview({ body: marker(MARKERS.codex) })];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

// ---------------------------------------------------------------------------
// READY promotion — every participating label may arrive last
// ---------------------------------------------------------------------------

test('READY promotion: ALL label-arrival orders promote exactly at the completing event — including risk LAST', () => {
  const required = ['agent-task', 'status:ready', 'builder:claude', 'risk:R2'];
  // Every permutation: each proper prefix declines; the full set proceeds.
  const permute = (arr) =>
    arr.length <= 1
      ? [arr]
      : arr.flatMap((x, i) =>
          permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]),
        );
  for (const order of permute(required)) {
    for (let k = 1; k < order.length; k++) {
      assert.equal(
        readyPromotionAction({ labels: order.slice(0, k) }).proceed,
        false,
        `prefix ${order.slice(0, k).join(',')} must decline`,
      );
    }
    const full = readyPromotionAction({ labels: order });
    assert.equal(full.proceed, true, `full set ${order.join(',')} must promote`);
    assert.equal(full.dispatchClaude, true);
    assert.equal(full.risk, 'risk:R2');
  }
});

test('READY promotion: removing the blocking decision label is the completing transition', () => {
  const withBlock = [
    'agent-task',
    'status:ready',
    'builder:codex',
    'risk:R1',
    'needs-owner-decision',
  ];
  assert.equal(readyPromotionAction({ labels: withBlock }).proceed, false);
  const cleared = withBlock.filter((l) => l !== 'needs-owner-decision');
  assert.deepEqual(readyPromotionAction({ labels: cleared }), {
    proceed: true,
    dispatchClaude: false,
    risk: 'risk:R1',
    builder: 'builder:codex',
  });
});

// ---------------------------------------------------------------------------
// Static workflow-graph assertions — the dependency/trigger shape itself
// ---------------------------------------------------------------------------

const WORKFLOWS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.github',
  'workflows',
);
const gatesYml = readFileSync(join(WORKFLOWS_DIR, 'agent-gates.yml'), 'utf8');
const authorityYml = readFileSync(join(WORKFLOWS_DIR, 'agent-contract-authority.yml'), 'utf8');

/** The YAML text of one job, from its header to the next top-level job. */
function jobBlock(yml, jobId) {
  const m = yml.match(new RegExp(`\\n  ${jobId}:\\n([\\s\\S]*?)(?=\\n  [a-z_]+:\\n|$)`));
  assert.ok(m, `job ${jobId} must exist`);
  return m[0];
}

test('WORKFLOW GRAPH: both AI reviewer jobs depend on invalidate and require its SUCCESS', () => {
  for (const job of ['technical_ai', 'acceptance_ai']) {
    const block = jobBlock(gatesYml, job);
    assert.ok(
      /needs:\s*\[resolve,\s*invalidate\]/.test(block),
      `${job} must need [resolve, invalidate]`,
    );
    assert.ok(
      block.includes("needs.invalidate.result == 'success'"),
      `${job} must require the invalidation to have SUCCEEDED before any fresh review starts`,
    );
  }
});

test('WORKFLOW GRAPH: the finalizer refuses to run after a FAILED invalidation and never trusts resolver-time governance', () => {
  const finalize = jobBlock(gatesYml, 'finalize');
  assert.ok(
    finalize.includes(
      "needs.invalidate.result == 'success' || needs.invalidate.result == 'skipped'",
    ),
    'finalize must be gated on invalidation success-or-skipped',
  );
  assert.ok(
    !finalize.includes('needs.resolve.outputs.governed'),
    'finalize must not read resolver-time governance',
  );
  assert.ok(!/GOVERNED:/.test(finalize), 'finalize must carry no resolver-time GOVERNED env');
  // The neutral publication must come AFTER the fresh normalization.
  const normalizeAt = finalize.indexOf('normalize.mjs');
  const neutralAt = finalize.indexOf('Not agent-governed');
  assert.ok(
    normalizeAt > -1 && neutralAt > -1 && normalizeAt < neutralAt,
    'the neutral path must be decided only after re-normalizing CURRENT state',
  );
});

test('WORKFLOW GRAPH: only invalidate, finalize (gates) and barrier (authority) write checks; publishers are evidence-only', () => {
  for (const job of ['technical', 'acceptance']) {
    const block = jobBlock(gatesYml, job);
    assert.ok(!/checks:\s*write/.test(block), `${job} publisher must not hold checks: write`);
    assert.ok(!block.includes('post-check.mjs'), `${job} publisher must not write checks`);
  }
  for (const job of ['invalidate', 'finalize']) {
    assert.ok(/checks:\s*write/.test(jobBlock(gatesYml, job)), `${job} must hold checks: write`);
  }
  assert.ok(
    /checks:\s*write/.test(jobBlock(authorityYml, 'barrier')),
    'barrier must hold checks: write',
  );
});

test('WORKFLOW GRAPH: baseline promotion triggers symmetrically on every participating label — risk included — and on decision-label removal', () => {
  const baseline = jobBlock(authorityYml, 'baseline');
  for (const needle of [
    "github.event.label.name == 'status:ready'",
    "github.event.label.name == 'agent-task'",
    "startsWith(github.event.label.name, 'builder:')",
    "startsWith(github.event.label.name, 'risk:')",
    "github.event.action == 'unlabeled'",
    "github.event.label.name == 'needs-owner-decision'",
    "github.event.label.name == 'status:blocked-decision'",
  ]) {
    assert.ok(baseline.includes(needle), `baseline trigger must include: ${needle}`);
  }
  assert.ok(
    /types:\s*\[labeled,\s*unlabeled\]/.test(authorityYml),
    'issues trigger must include unlabeled',
  );
});
