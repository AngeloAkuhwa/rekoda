#!/usr/bin/env node
/**
 * The deterministic merge-policy evaluator for the autonomous engineering
 * control plane (docs/AUTONOMOUS-ENGINEERING.md §6, AGENTS.md §8–§9).
 *
 * PURE: no network, no filesystem, no environment. It takes normalized
 * GitHub state (scripts/agents/normalize.mjs produces it) and returns
 * PASS or BLOCK with machine-readable reasons. Every workflow gate calls
 * this module instead of reimplementing policy in shell, and
 * evaluator.test.mjs proves the negative cases fail CLOSED.
 *
 * PROVENANCE MODEL (the part that makes forgery impossible, not just
 * forbidden):
 *   - Claude/Gemini verdict markers count ONLY with a valid Ed25519
 *     signature over the canonical marker payload, verified against the
 *     committed public key for that reviewer (scripts/agents/keys/).
 *     The private keys live in reviewer-specific GitHub environments the
 *     builder job cannot reference — so neither the builder nor any
 *     unrelated workflow posting as github-actions[bot] can mint
 *     acceptable evidence. Author identity alone NEVER suffices.
 *   - Codex markers count ONLY inside a non-dismissed GitHub REVIEW
 *     authored by the Codex connector whose review commit_id equals the
 *     current PR HEAD, in addition to every marker field matching.
 *   - Contract baseline/revision markers count ONLY when authored by the
 *     owner's human account (platform-verified — a workflow cannot post
 *     as a human) or signed by the contract-authority key.
 *   - Missing/invalid provenance fails CLOSED.
 *
 * Untrusted text (PR bodies, issue bodies, comments, review bodies) is
 * parsed here as data with anchored line grammars — never interpolated
 * into a shell.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const MARKERS = {
  codex: 'REKODA_CODEX_APPROVAL',
  claude: 'REKODA_CLAUDE_APPROVAL',
  gemini: 'REKODA_GEMINI_APPROVAL',
};

const SHA40 = /^[0-9a-f]{40}$/;
const RISK_RE = /^risk:R[0-3]$/;
const BUILDER_RE = /^builder:(claude|codex)$/;

// ---------------------------------------------------------------------------
// Text + crypto primitives
// ---------------------------------------------------------------------------

export function normalizeBody(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical signed payload for a verdict marker — field order is fixed. */
export function canonicalVerdictPayload(m) {
  return `${m.name}\nPR: ${m.pr}\nISSUE: ${m.issue}\nHEAD_SHA: ${m.headSha}\nCONTRACT_REVISION: ${m.contractRevision}\nVERDICT: ${m.verdict}`;
}

/** Canonical signed payload for a contract marker — field order is fixed. */
export function canonicalContractPayload(m) {
  const base = `${m.kind}\nISSUE: ${m.issue}\nREVISION: ${m.revision}\nBODY_SHA256: ${m.bodySha256}`;
  return m.kind === 'REKODA_CONTRACT_REVISION' ? `${base}\nREASON: ${m.reason}` : base;
}

/** Verify an Ed25519 signature (base64) over a payload with a PEM public key. */
export function verifySignature(payload, signatureB64, publicKeyPem) {
  if (!signatureB64 || !publicKeyPem) return false;
  try {
    return cryptoVerify(
      null,
      Buffer.from(payload, 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Closing references in a PR body: Closes/Fixes/Resolves #N. */
export function parseClosingRefs(body) {
  const refs = new Set();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d{1,7})\b/gi;
  for (const m of normalizeBody(body).matchAll(re)) refs.add(Number(m[1]));
  return [...refs];
}

/**
 * Parse fixed-format approval marker blocks out of free text:
 *   <MARKER NAME>
 *   PR: <n> / ISSUE: <n> / HEAD_SHA: <40 hex> / CONTRACT_REVISION: <n>
 *   VERDICT: APPROVE|BLOCK
 *   SIGNATURE: <base64>          (required for Claude/Gemini provenance)
 * Anything that starts a block but does not parse completely is returned
 * with malformed: true — a malformed marker never counts as approval.
 */
export function parseMarkers(text, markerName) {
  const lines = normalizeBody(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== markerName) continue;
    const fields = {};
    let consumed = 0;
    for (let j = i + 1; j < lines.length && consumed < 10; j++, consumed++) {
      const line = lines[j].trim();
      if (line === markerName) break;
      const m = line.match(/^(PR|ISSUE|HEAD_SHA|CONTRACT_REVISION|VERDICT|SIGNATURE):\s*(.*)$/);
      if (m) fields[m[1]] = m[2].trim();
      if (m && m[1] === 'SIGNATURE') break;
    }
    const pr = /^\d{1,7}$/.test(fields.PR ?? '') ? Number(fields.PR) : null;
    const issue = /^\d{1,7}$/.test(fields.ISSUE ?? '') ? Number(fields.ISSUE) : null;
    const headSha = SHA40.test((fields.HEAD_SHA ?? '').toLowerCase())
      ? fields.HEAD_SHA.toLowerCase()
      : null;
    const contractRevision = /^\d{1,4}$/.test(fields.CONTRACT_REVISION ?? '')
      ? Number(fields.CONTRACT_REVISION)
      : null;
    const verdict =
      fields.VERDICT === 'APPROVE' || fields.VERDICT === 'BLOCK' ? fields.VERDICT : null;
    const malformed =
      pr === null ||
      issue === null ||
      headSha === null ||
      contractRevision === null ||
      verdict === null;
    out.push({
      name: markerName,
      pr,
      issue,
      headSha,
      contractRevision,
      verdict,
      signature: fields.SIGNATURE ?? null,
      malformed,
    });
  }
  return out;
}

/** Contract baseline/revision markers (docs/AUTONOMOUS-ENGINEERING.md §6). */
export function parseRevisionMarkers(text) {
  const lines = normalizeBody(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].trim();
    if (name !== 'REKODA_CONTRACT_BASELINE' && name !== 'REKODA_CONTRACT_REVISION') continue;
    const fields = {};
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const m = lines[j].trim().match(/^(ISSUE|REVISION|BODY_SHA256|REASON|SIGNATURE):\s*(.*)$/);
      if (m) fields[m[1]] = m[2].trim();
    }
    const issue = /^\d{1,7}$/.test(fields.ISSUE ?? '') ? Number(fields.ISSUE) : null;
    const revision = /^\d{1,4}$/.test(fields.REVISION ?? '') ? Number(fields.REVISION) : null;
    const bodySha256 = /^[0-9a-f]{64}$/.test((fields.BODY_SHA256 ?? '').toLowerCase())
      ? fields.BODY_SHA256.toLowerCase()
      : null;
    const reason = (fields.REASON ?? '').trim();
    const malformed =
      issue === null ||
      revision === null ||
      bodySha256 === null ||
      (name === 'REKODA_CONTRACT_REVISION' && reason === '');
    out.push({
      kind: name,
      issue,
      revision,
      bodySha256,
      reason,
      signature: fields.SIGNATURE ?? null,
      malformed,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contract revision history
// ---------------------------------------------------------------------------

/**
 * Compute the issue's current contract revision from its comments with
 * validated provenance and validated history. Provenance: a marker counts
 * only when its comment author is the owner's human account, or its
 * SIGNATURE verifies against the contract-authority public key. History
 * rules (all fail closed with `invalid` set):
 *   - a baseline must exist, and every baseline must be revision 1 with
 *     one identical hash (conflicting baselines are invalid);
 *   - revisions must be strictly monotonic 1..N with no gaps;
 *   - two markers for the same revision with different hashes conflict;
 *   - a revision marker requires a REASON (parse-level);
 *   - a replayed lower revision never lowers the current revision.
 */
export function computeContractRevision({
  issueNumber,
  issueBody,
  issueComments,
  ownerLogin,
  contractAuthorityKey,
}) {
  const markers = [];
  for (const c of issueComments ?? []) {
    for (const m of parseRevisionMarkers(c.body)) {
      if (m.malformed || m.issue !== issueNumber) continue;
      const authorized =
        c.author === ownerLogin ||
        verifySignature(canonicalContractPayload(m), m.signature, contractAuthorityKey);
      if (authorized) markers.push(m);
    }
  }
  if (markers.length === 0) {
    return { revision: null, baselineFound: false, amended: false, invalid: null };
  }

  const byRevision = new Map();
  for (const m of markers) {
    const list = byRevision.get(m.revision) ?? [];
    list.push(m);
    byRevision.set(m.revision, list);
  }
  // Baselines must be revision 1; any baseline at another number is invalid.
  if (markers.some((m) => m.kind === 'REKODA_CONTRACT_BASELINE' && m.revision !== 1)) {
    return {
      revision: null,
      baselineFound: true,
      amended: false,
      invalid: 'baseline revision must be 1',
    };
  }
  if (!byRevision.has(1) || !byRevision.get(1).some((m) => m.kind === 'REKODA_CONTRACT_BASELINE')) {
    return { revision: null, baselineFound: false, amended: false, invalid: null };
  }
  const max = Math.max(...byRevision.keys());
  for (let k = 1; k <= max; k++) {
    const list = byRevision.get(k);
    if (!list) {
      return {
        revision: null,
        baselineFound: true,
        amended: false,
        invalid: `revision ${k} is missing (history must be monotonic 1..${max})`,
      };
    }
    const hashes = new Set(list.map((m) => m.bodySha256));
    if (hashes.size > 1) {
      return {
        revision: null,
        baselineFound: true,
        amended: false,
        invalid: `conflicting markers for revision ${k}`,
      };
    }
  }
  const expectedHash = byRevision.get(max)[0].bodySha256;
  const currentHash = sha256Hex(normalizeBody(issueBody));
  return {
    revision: max,
    baselineFound: true,
    amended: currentHash !== expectedHash,
    invalid: null,
    expectedHash,
    currentHash,
  };
}

// ---------------------------------------------------------------------------
// Verdict resolution
// ---------------------------------------------------------------------------

function sortEvidence(candidates) {
  return [...(candidates ?? [])].sort((a, b) => {
    const t = String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
    if (t !== 0) return t;
    return Number(a.id ?? 0) - Number(b.id ?? 0); // stable GitHub id breaks timestamp ties
  });
}

/**
 * Pick the governing verdict for one reviewer. Ordering is deterministic:
 * (createdAt, GitHub id). The LATEST fully-valid, provenance-verified
 * marker for the exact (pr, issue, headSha, revision) governs — a later
 * valid verdict supersedes an earlier one either direction; anything
 * malformed, mistargeted, or unauthorized never counts and never erases
 * a previous valid verdict.
 *
 * provenance:
 *   { kind: 'signature', publicKey }  — Claude/Gemini workflow markers
 *   { kind: 'codex', login }          — Codex native review markers:
 *       must be a non-dismissed REVIEW by `login` whose commit_id equals
 *       the target HEAD, in addition to marker-field matching.
 */
export function resolveVerdict({ candidates, markerName, provenance, target }) {
  let governing = null;
  let diagnosis = 'missing'; // missing|stale|wrong_pr|wrong_issue|wrong_revision|malformed|unauthorized
  for (const c of sortEvidence(candidates)) {
    const found = parseMarkers(c.body, markerName);
    if (found.length === 0) continue;
    for (const m of found) {
      if (m.malformed) {
        if (diagnosis === 'missing') diagnosis = 'malformed';
        continue;
      }
      // Provenance first: unauthorized evidence never counts, whatever it claims.
      if (provenance.kind === 'signature') {
        if (!verifySignature(canonicalVerdictPayload(m), m.signature, provenance.publicKey)) {
          diagnosis = 'unauthorized';
          continue;
        }
      } else if (provenance.kind === 'codex') {
        const isLiveReview =
          c.author === provenance.login && c.kind === 'review' && c.reviewState !== 'DISMISSED';
        if (!isLiveReview) {
          diagnosis = 'unauthorized';
          continue;
        }
        if (String(c.commitId ?? '').toLowerCase() !== target.headSha) {
          // A marker claiming the current HEAD inside a review of an old
          // commit is stale evidence, not proof.
          diagnosis = 'stale';
          continue;
        }
      } else {
        diagnosis = 'unauthorized';
        continue;
      }
      if (m.headSha !== target.headSha) {
        diagnosis = 'stale';
        continue;
      }
      if (m.pr !== target.pr) {
        diagnosis = 'wrong_pr';
        continue;
      }
      if (m.issue !== target.issue) {
        diagnosis = 'wrong_issue';
        continue;
      }
      if (m.contractRevision !== target.contractRevision) {
        diagnosis = 'wrong_revision';
        continue;
      }
      governing = m.verdict; // sorted ascending → latest valid wins
    }
  }
  return { verdict: governing, diagnosis };
}

// ---------------------------------------------------------------------------
// Issue-form field extraction, governance, authorization
// ---------------------------------------------------------------------------

export function issueFormField(body, label) {
  const lines = normalizeBody(body).split('\n');
  const idx = lines.findIndex((l) =>
    l.trim().toLowerCase().startsWith(`### ${label.toLowerCase()}`),
  );
  if (idx === -1) return null;
  const content = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('### ')) break;
    content.push(lines[i]);
  }
  const value = content.join('\n').trim();
  return value === '' || value === '_No response_' ? null : value;
}

/**
 * STICKY governance. A PR is agent-governed when any of:
 *   - it currently carries risk or builder labels;
 *   - it closes an agent-task issue;
 *   - its immutable label-event history shows it EVER carried an agent
 *     label (normalize reads the timeline) — stripping labels and the
 *     closing reference can only make a PR more blocked, never neutral.
 */
export function isGoverned(state) {
  return (
    (state.pr?.riskLabels?.length ?? 0) > 0 ||
    (state.pr?.builderLabels?.length ?? 0) > 0 ||
    Boolean(state.issue?.agentTask) ||
    Boolean(state.pr?.everLabeledAgent)
  );
}

/** Repository permission levels that may start paid agent work. */
export function isActorAuthorized(permission) {
  return permission === 'admin' || permission === 'maintain' || permission === 'write';
}

// ---------------------------------------------------------------------------
// The evaluation
// ---------------------------------------------------------------------------

function one(labels, re) {
  const hits = (labels ?? []).filter((l) => re.test(l));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Evaluate the merge policy. Returns { pass, reasons: [{code, message}] }.
 * `mode` filters which reason families this gate is responsible for:
 *   'full' | 'policy' | 'technical' | 'acceptance'  (see filterByMode)
 */
export function evaluate(state, mode = 'full') {
  const reasons = [];
  const add = (code, message) => reasons.push({ code, message });
  const cfg = state.config ?? {};
  const keys = cfg.publicKeys ?? {};

  const prRisk = one(state.pr?.riskLabels, RISK_RE);
  const prBuilder = one(state.pr?.builderLabels, BUILDER_RE);
  if (!prRisk) add('RISK_LABEL_INVALID', 'The PR must carry exactly one risk:R0..R3 label.');
  if (!prBuilder)
    add(
      'BUILDER_LABEL_INVALID',
      'The PR must carry exactly one builder:claude|builder:codex label.',
    );

  // Authoritative linked issue.
  const refs = parseClosingRefs(state.prBody);
  let issue = null;
  if (refs.length === 0) {
    add('LINKED_ISSUE_MISSING', 'The PR body must close exactly one issue (e.g. "Closes #123").');
  } else if (refs.length > 1) {
    add(
      'LINKED_ISSUE_AMBIGUOUS',
      `The PR body closes ${refs.length} issues (${refs.join(', ')}); exactly one is required.`,
    );
  } else if (!state.issue || state.issue.number !== refs[0] || !state.issue.exists) {
    add('ISSUE_NOT_FOUND', `Linked issue #${refs[0]} could not be resolved.`);
  } else {
    issue = state.issue;
  }

  let revision = null;
  if (issue) {
    if (!issue.agentTask)
      add('ISSUE_NOT_AGENT_TASK', `Issue #${issue.number} is not labelled agent-task.`);
    const issueRisk = one(issue.riskLabels, RISK_RE);
    const issueBuilder = one(issue.builderLabels, BUILDER_RE);
    if (!issueRisk)
      add('ISSUE_RISK_INVALID', `Issue #${issue.number} must carry exactly one risk:R0..R3 label.`);
    if (!issueBuilder)
      add('ISSUE_BUILDER_INVALID', `Issue #${issue.number} must carry exactly one builder label.`);
    if (prRisk && issueRisk && prRisk !== issueRisk)
      add('RISK_MISMATCH', `PR risk ${prRisk} does not match issue risk ${issueRisk}.`);
    if (prBuilder && issueBuilder && prBuilder !== issueBuilder)
      add(
        'BUILDER_MISMATCH',
        `PR builder ${prBuilder} does not match issue builder ${issueBuilder}.`,
      );
    if (
      (issue.labels ?? []).some(
        (l) => l === 'needs-owner-decision' || l === 'status:blocked-decision',
      )
    )
      add('DECISION_STATE_INVALID', `Issue #${issue.number} has an unresolved owner decision.`);

    const rev = computeContractRevision({
      issueNumber: issue.number,
      issueBody: issue.body,
      issueComments: issue.comments,
      ownerLogin: cfg.ownerLogin,
      contractAuthorityKey: keys.contractAuthority ?? null,
    });
    if (rev.invalid) {
      add(
        'CONTRACT_HISTORY_INVALID',
        `Issue #${issue.number} contract history is invalid: ${rev.invalid}.`,
      );
    } else if (!rev.baselineFound) {
      add(
        'CONTRACT_BASELINE_MISSING',
        `Issue #${issue.number} has no authorized REKODA_CONTRACT_BASELINE marker (owner-posted or contract-authority-signed).`,
      );
    } else if (rev.amended) {
      add(
        'CONTRACT_AMENDED_UNAUTHORIZED',
        `Issue #${issue.number} body was changed without an authorized REKODA_CONTRACT_REVISION marker (expected ${rev.expectedHash}, found ${rev.currentHash}).`,
      );
    } else {
      revision = rev.revision;
    }
  }

  const target =
    revision !== null && issue
      ? {
          pr: state.pr.number,
          issue: issue.number,
          headSha: state.pr.headSha,
          contractRevision: revision,
        }
      : null;

  // Technical review — builder-aware; provenance makes self-satisfaction impossible.
  if (prBuilder && target) {
    const tech =
      prBuilder === 'builder:claude'
        ? resolveVerdict({
            candidates: state.techEvidence?.candidates,
            markerName: MARKERS.codex,
            provenance: { kind: 'codex', login: cfg.codexLogin },
            target,
          })
        : resolveVerdict({
            candidates: state.techEvidence?.candidates,
            markerName: MARKERS.claude,
            provenance: { kind: 'signature', publicKey: keys.claudeReviewer ?? null },
            target,
          });
    if (tech.verdict === 'BLOCK') {
      add('TECH_BLOCK', 'The technical reviewer BLOCKED this HEAD/revision.');
    } else if (tech.verdict !== 'APPROVE') {
      const map = {
        stale: [
          'TECH_APPROVAL_STALE',
          `No technical verdict for the current HEAD ${state.pr.headSha}; the latest evidence binds an older commit.`,
        ],
        wrong_pr: ['TECH_WRONG_PR', 'The technical marker names a different PR.'],
        wrong_issue: ['TECH_WRONG_ISSUE', 'The technical marker names a different issue.'],
        wrong_revision: [
          'TECH_WRONG_REVISION',
          `The technical marker names a different contract revision (current: ${revision}).`,
        ],
        malformed: [
          'TECH_MALFORMED',
          'The technical marker is malformed; a malformed approval never counts.',
        ],
        unauthorized: [
          'TECH_UNAUTHORIZED',
          'Technical-review evidence without valid reviewer provenance was rejected — nobody, including the builder, can substitute for the designated reviewer.',
        ],
        missing: ['TECH_APPROVAL_MISSING', 'No technical-review verdict exists for this PR.'],
      };
      add(...map[tech.diagnosis]);
    }
  }

  // Gemini system acceptance — always required, signature-proven.
  if (target) {
    const gem = resolveVerdict({
      candidates: state.geminiEvidence?.candidates,
      markerName: MARKERS.gemini,
      provenance: { kind: 'signature', publicKey: keys.geminiReviewer ?? null },
      target,
    });
    if (gem.verdict === 'BLOCK') {
      add('GEMINI_BLOCK', 'Gemini system acceptance BLOCKED this HEAD/revision.');
    } else if (gem.verdict !== 'APPROVE') {
      const map = {
        stale: [
          'GEMINI_APPROVAL_STALE',
          `No Gemini acceptance for the current HEAD ${state.pr.headSha}.`,
        ],
        wrong_pr: ['GEMINI_WRONG_PR', 'The Gemini marker names a different PR.'],
        wrong_issue: ['GEMINI_WRONG_ISSUE', 'The Gemini marker names a different issue.'],
        wrong_revision: [
          'GEMINI_WRONG_REVISION',
          `The Gemini marker names a different contract revision (current: ${revision}).`,
        ],
        malformed: [
          'GEMINI_MALFORMED',
          'The Gemini marker is malformed; a malformed approval never counts.',
        ],
        unauthorized: [
          'GEMINI_UNAUTHORIZED',
          'Gemini-acceptance evidence without valid reviewer provenance was rejected.',
        ],
        missing: [
          'GEMINI_APPROVAL_MISSING',
          'No Gemini system-acceptance verdict exists for this PR.',
        ],
      };
      add(...map[gem.diagnosis]);
    }
  }

  // Review threads.
  if ((state.unresolvedThreads ?? 0) > 0)
    add('THREADS_UNRESOLVED', `${state.unresolvedThreads} unresolved review thread(s).`);

  // Global WIP: one implementation lane, deterministically.
  const lanes = state.openLanes ?? null;
  if (lanes && lanes.length > 1)
    add(
      'WIP_VIOLATION',
      `${lanes.length} implementation lanes are active (issues ${lanes.map((l) => `#${l.issue}`).join(', ')}); the contract allows exactly one.`,
    );

  // R3: recorded owner decision + owner approval of the current HEAD.
  if (prRisk === 'risk:R3') {
    if (issue && !issueFormField(issue.body, 'Owner decision reference'))
      add(
        'R3_OWNER_DECISION_MISSING',
        `Issue #${issue.number} records no owner decision reference; R3 requires one before implementation.`,
      );
    const ownerApproved = (state.ownerReviews ?? []).some(
      (r) =>
        r.author === cfg.ownerLogin &&
        r.state === 'APPROVED' &&
        String(r.commitId ?? '').toLowerCase() === state.pr.headSha,
    );
    if (!ownerApproved)
      add(
        'R3_OWNER_APPROVAL_MISSING',
        `R3 requires @${cfg.ownerLogin}'s approving review of HEAD ${state.pr.headSha} (fresh after every push). This is additive — it never substitutes for the peer technical review.`,
      );
  }

  // Optional CI evidence (branch protection normally owns this).
  if (state.ci && state.ci.complete === false)
    add('CI_INCOMPLETE', 'Required CI evidence is missing or incomplete.');

  const filtered = filterByMode(reasons, mode);
  return { pass: filtered.length === 0, reasons: filtered };
}

const PREREQ_CODES = new Set([
  'RISK_LABEL_INVALID',
  'BUILDER_LABEL_INVALID',
  'LINKED_ISSUE_MISSING',
  'LINKED_ISSUE_AMBIGUOUS',
  'ISSUE_NOT_FOUND',
  'ISSUE_NOT_AGENT_TASK',
  'ISSUE_RISK_INVALID',
  'ISSUE_BUILDER_INVALID',
  'RISK_MISMATCH',
  'BUILDER_MISMATCH',
  'DECISION_STATE_INVALID',
  'CONTRACT_BASELINE_MISSING',
  'CONTRACT_AMENDED_UNAUTHORIZED',
  'CONTRACT_HISTORY_INVALID',
]);

function filterByMode(reasons, mode) {
  if (mode === 'full') return reasons;
  const isTech = (c) => c.startsWith('TECH_');
  const isGem = (c) => c.startsWith('GEMINI_');
  if (mode === 'policy') return reasons.filter((r) => !isTech(r.code) && !isGem(r.code));
  if (mode === 'technical')
    return reasons.filter((r) => isTech(r.code) || PREREQ_CODES.has(r.code));
  if (mode === 'acceptance')
    return reasons.filter((r) => isGem(r.code) || PREREQ_CODES.has(r.code));
  throw new Error(`Unknown mode: ${mode}`);
}
