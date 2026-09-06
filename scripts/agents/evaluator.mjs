#!/usr/bin/env node
/**
 * The deterministic merge-policy evaluator for the autonomous engineering
 * control plane (docs/AUTONOMOUS-ENGINEERING.md §6, AGENTS.md §8–§9).
 *
 * PURE: no network, no filesystem, no environment. It takes normalized
 * GitHub state (scripts/agents/normalize.mjs produces it) and returns
 * PASS or BLOCK with machine-readable reasons. Every gate calls this
 * module instead of reimplementing policy in shell, and
 * evaluator.test.mjs proves the negative cases fail CLOSED.
 *
 * PROVENANCE MODEL:
 *   - Every piece of signed evidence carries the protocol domain/version
 *     SCHEME: REKODA_AGENT_EVIDENCE_V2 inside its signed payload; an
 *     unknown, missing, or future scheme is rejected.
 *   - Claude/Gemini verdict markers count ONLY with a valid Ed25519
 *     signature over the canonical payload, verified against the
 *     committed public key for that reviewer. The private keys are
 *     reachable only inside the trusted privileged gates workflow, whose
 *     definition GitHub executes from the DEFAULT BRANCH (workflow_run /
 *     workflow_dispatch) — PR-controlled YAML never receives them.
 *     Author identity alone NEVER suffices.
 *   - Codex markers count ONLY inside a non-dismissed GitHub REVIEW
 *     authored by the Codex connector whose review commit_id equals the
 *     current PR HEAD, in addition to every marker field matching.
 *   - Contract baseline/revision markers count ONLY when authored by the
 *     owner's human account or signed by the contract-authority key, with
 *     the whole revision history validated, not just the highest number.
 *   - Missing/invalid provenance, unprovable enrollment history, and
 *     contemporaneous contradictory verdicts all fail CLOSED.
 *
 * Untrusted text (PR bodies, issue bodies, comments, review bodies) is
 * parsed here as data with anchored line grammars — never interpolated
 * into a shell.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

// V2: verdict evidence additionally binds CONTRACT_BODY_SHA256 — the
// hash of the exact authorized contract snapshot the reviewer assessed —
// so a mutable-body A→B→A window can never smuggle an unreviewed
// contract past the publisher. Bumped cleanly while no signing key is
// live; V1 evidence is rejected as an unknown scheme.
export const SCHEME = 'REKODA_AGENT_EVIDENCE_V2';

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
  return `${m.name}\nSCHEME: ${SCHEME}\nPR: ${m.pr}\nISSUE: ${m.issue}\nHEAD_SHA: ${m.headSha}\nCONTRACT_REVISION: ${m.contractRevision}\nCONTRACT_BODY_SHA256: ${m.contractBodySha256}\nVERDICT: ${m.verdict}`;
}

/**
 * THE single source of marker text: every production generator renders
 * through these, and the parsers below consume exactly this shape — the
 * end-to-end tests feed real generator output through the real parser,
 * so the two can never silently drift again.
 */
export function buildVerdictMarkerLines(m, signature) {
  const lines = [
    m.name,
    `SCHEME: ${SCHEME}`,
    `PR: ${m.pr}`,
    `ISSUE: ${m.issue}`,
    `HEAD_SHA: ${m.headSha}`,
    `CONTRACT_REVISION: ${m.contractRevision}`,
    `CONTRACT_BODY_SHA256: ${m.contractBodySha256}`,
    `VERDICT: ${m.verdict}`,
  ];
  if (signature) lines.push(`SIGNATURE: ${signature}`);
  return lines;
}

export function buildContractMarkerLines(m, signature) {
  const lines = [
    m.kind,
    `SCHEME: ${SCHEME}`,
    `ISSUE: ${m.issue}`,
    `REVISION: ${m.revision}`,
    `BODY_SHA256: ${m.bodySha256}`,
  ];
  if (m.kind === 'REKODA_CONTRACT_REVISION') lines.push(`REASON: ${m.reason}`);
  if (signature) lines.push(`SIGNATURE: ${signature}`);
  return lines;
}

/** Canonical signed payload for a contract marker — field order is fixed. */
export function canonicalContractPayload(m) {
  const base = `${m.kind}\nSCHEME: ${SCHEME}\nISSUE: ${m.issue}\nREVISION: ${m.revision}\nBODY_SHA256: ${m.bodySha256}`;
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

/** Open PRs whose body closes exactly the given issue. */
export function linkedOpenPrs(openPrs, issueNumber) {
  return (openPrs ?? [])
    .filter((p) => parseClosingRefs(p.body ?? '').includes(Number(issueNumber)))
    .map((p) => Number(p.number));
}

/**
 * Linked-PR selection over an exhaustively paginated open-PR listing.
 * `complete: false` (pagination ceiling hit, or API failure) fails
 * closed — a linked PR must never be silently missed.
 */
export function selectLinkedPrs({ openPrs, complete, issueNumber }) {
  if (!complete)
    return { ok: false, prs: [], reason: 'open-PR listing could not be proven complete' };
  return { ok: true, prs: linkedOpenPrs(openPrs, issueNumber) };
}

/**
 * Resolve the target of a workflow_run request to exactly ONE valid PR —
 * anything less certain fails closed (docs/AUTONOMOUS-ENGINEERING.md §6):
 *   - 'none'      zero open same-base candidates → nothing to evaluate;
 *   - 'ambiguous' multiple open candidates share the commit → BLOCK, a
 *                 privileged evaluation must know exactly whom it judges;
 *   - 'stale'     the single candidate's CURRENT head no longer equals
 *                 the triggering SHA (force-push/new push) → do not
 *                 evaluate; the new head's own request owns it;
 *   - 'ok'        exactly one open candidate whose current head equals
 *                 the triggering SHA.
 * candidates: [{ number, state, headSha, baseRepo }] with baseRepo the
 * full name of the PR's base repository.
 */
export function resolveWorkflowRunTarget({ headSha, candidates, repo, complete = true }) {
  const sha = String(headSha ?? '').toLowerCase();
  if (!SHA40.test(sha)) return { pr: null, status: 'none' };
  if (complete === false) return { pr: null, status: 'unprovable' }; // partial candidate set → fail closed
  const open = (candidates ?? []).filter(
    (c) => c.state === 'open' && (!repo || c.baseRepo === repo),
  );
  if (open.length === 0) return { pr: null, status: 'none' };
  if (open.length > 1) return { pr: null, status: 'ambiguous' };
  const c = open[0];
  if (String(c.headSha ?? '').toLowerCase() !== sha)
    return { pr: Number(c.number), status: 'stale' };
  return { pr: Number(c.number), status: 'ok' };
}

/**
 * Parse fixed-format approval marker blocks out of free text:
 *   <MARKER NAME>
 *   SCHEME: REKODA_AGENT_EVIDENCE_V2
 *   PR / ISSUE / HEAD_SHA / CONTRACT_REVISION / CONTRACT_BODY_SHA256 / VERDICT / SIGNATURE
 * A block missing the scheme, carrying an unknown scheme, or failing any
 * field grammar is malformed — a malformed marker never counts.
 */
export function parseMarkers(text, markerName) {
  const lines = normalizeBody(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== markerName) continue;
    const fields = {};
    let consumed = 0;
    for (let j = i + 1; j < lines.length && consumed < 13; j++, consumed++) {
      const line = lines[j].trim();
      if (line === markerName) break;
      const m = line.match(
        /^(SCHEME|PR|ISSUE|HEAD_SHA|CONTRACT_REVISION|CONTRACT_BODY_SHA256|VERDICT|SIGNATURE):\s*(.*)$/,
      );
      if (m) fields[m[1]] = m[2].trim();
      if (m && m[1] === 'SIGNATURE') break;
    }
    const scheme = fields.SCHEME === SCHEME ? SCHEME : null;
    const pr = /^\d{1,7}$/.test(fields.PR ?? '') ? Number(fields.PR) : null;
    const issue = /^\d{1,7}$/.test(fields.ISSUE ?? '') ? Number(fields.ISSUE) : null;
    const headSha = SHA40.test((fields.HEAD_SHA ?? '').toLowerCase())
      ? fields.HEAD_SHA.toLowerCase()
      : null;
    const contractRevision = /^\d{1,4}$/.test(fields.CONTRACT_REVISION ?? '')
      ? Number(fields.CONTRACT_REVISION)
      : null;
    const contractBodySha256 = /^[0-9a-f]{64}$/.test(
      (fields.CONTRACT_BODY_SHA256 ?? '').toLowerCase(),
    )
      ? fields.CONTRACT_BODY_SHA256.toLowerCase()
      : null;
    const verdict =
      fields.VERDICT === 'APPROVE' || fields.VERDICT === 'BLOCK' ? fields.VERDICT : null;
    const malformed =
      scheme === null ||
      pr === null ||
      issue === null ||
      headSha === null ||
      contractRevision === null ||
      contractBodySha256 === null ||
      verdict === null;
    out.push({
      name: markerName,
      scheme,
      pr,
      issue,
      headSha,
      contractRevision,
      contractBodySha256,
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
    for (let j = i + 1; j < Math.min(i + 9, lines.length); j++) {
      const m = lines[j]
        .trim()
        .match(/^(SCHEME|ISSUE|REVISION|BODY_SHA256|REASON|SIGNATURE):\s*(.*)$/);
      if (m) fields[m[1]] = m[2].trim();
    }
    const scheme = fields.SCHEME === SCHEME ? SCHEME : null;
    const issue = /^\d{1,7}$/.test(fields.ISSUE ?? '') ? Number(fields.ISSUE) : null;
    const revision = /^\d{1,4}$/.test(fields.REVISION ?? '') ? Number(fields.REVISION) : null;
    const bodySha256 = /^[0-9a-f]{64}$/.test((fields.BODY_SHA256 ?? '').toLowerCase())
      ? fields.BODY_SHA256.toLowerCase()
      : null;
    const reason = (fields.REASON ?? '').trim();
    const malformed =
      scheme === null ||
      issue === null ||
      revision === null ||
      bodySha256 === null ||
      (name === 'REKODA_CONTRACT_REVISION' && reason === '');
    out.push({
      kind: name,
      scheme,
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
 * Compute the issue's ACTIVE contract revision from its comments with
 * validated provenance and validated history.
 *
 * Provenance (the D1 rule — mutable text can never silently change the
 * merge contract): a BASELINE counts when authored by the owner's human
 * account or signed by the contract-authority key; a REVISION counts
 * ONLY when contract-authority-SIGNED — an owner-authored unsigned
 * revision comment, like a direct issue-body edit, is a PROPOSAL: the
 * previous signed revision stays the active merge contract, and the
 * mismatched body simply blocks (CONTRACT_AMENDED_UNAUTHORIZED) until
 * the owner-only authority transaction freezes the linked PRs, signs
 * the new revision, and redispatches the gates.
 *
 * History rules (all fail closed with `invalid` set):
 *   - a baseline must exist, and every baseline must be revision 1 with
 *     one identical hash;
 *   - revisions must be strictly monotonic 1..N with no gaps;
 *   - two markers for the same revision with different hashes conflict;
 *   - a revision marker requires a REASON and the current scheme;
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
      const signed = verifySignature(
        canonicalContractPayload(m),
        m.signature,
        contractAuthorityKey,
      );
      const authorized =
        m.kind === 'REKODA_CONTRACT_BASELINE' ? c.author === ownerLogin || signed : signed;
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

/**
 * The FREEZE-BEFORE-MUTATE amendment transaction (D1), as a pure state
 * machine the authority workflow implements step for step:
 *   1. every linked open PR's current HEAD is frozen (required checks
 *      forced non-green) BEFORE anything else;
 *   2. only when EVERY freeze succeeded may the signed revision be
 *      published (become authoritative);
 *   3. gate redispatch follows; a failed dispatch leaves the PR frozen
 *      (blocked), never silently re-green.
 * Any partial failure keeps the previous revision active while the
 * already-frozen PRs stay safely blocked.
 */
export function amendmentTransaction({ linkedPrs, freezeResults, signOk, dispatchResults }) {
  const prs = (linkedPrs ?? []).map(Number);
  const frozen = prs.filter((pr) => freezeResults?.[pr] === true);
  const allFrozen = prs.every((pr) => freezeResults?.[pr] === true);
  if (!allFrozen) {
    return { published: false, frozen, dispatched: [], stillBlocked: frozen };
  }
  if (!signOk) {
    return { published: false, frozen, dispatched: [], stillBlocked: frozen };
  }
  const dispatched = prs.filter((pr) => dispatchResults?.[pr] === true);
  const stillBlocked = prs.filter((pr) => dispatchResults?.[pr] !== true);
  return { published: true, frozen, dispatched, stillBlocked };
}

// ---------------------------------------------------------------------------
// Verdict resolution
// ---------------------------------------------------------------------------

/**
 * Pick the governing verdict for one reviewer. Ordering is
 * timestamp-primary: the latest fully-valid, provenance-verified marker
 * for the exact (pr, issue, headSha, revision) governs; a later valid
 * verdict supersedes an earlier one either direction; anything
 * malformed, mistargeted, or unauthorized never counts and never erases
 * a previous valid verdict.
 *
 * Ties: GitHub review ids and comment ids live in different id domains,
 * so ids break ties only WITHIN one source kind (where they are truly
 * chronological). Two contradictory valid verdicts from different
 * source kinds at an indistinguishable timestamp FAIL CLOSED
 * (diagnosis 'ambiguous') — redispatch a fresh review rather than
 * invent a cross-domain chronology.
 *
 * provenance:
 *   { kind: 'signature', publicKey }  — Claude/Gemini workflow markers
 *   { kind: 'codex', login }          — Codex native review markers:
 *       must be a non-dismissed REVIEW by `login` whose commit_id equals
 *       the target HEAD, in addition to marker-field matching.
 */
export function resolveVerdict({ candidates, markerName, provenance, target }) {
  let diagnosis = 'missing';
  const valid = [];
  for (const c of candidates ?? []) {
    const found = parseMarkers(c.body, markerName);
    if (found.length === 0) continue;
    for (const m of found) {
      if (m.malformed) {
        if (diagnosis === 'missing') diagnosis = 'malformed';
        continue;
      }
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
      if (m.contractBodySha256 !== target.contractBodySha256) {
        diagnosis = 'wrong_contract';
        continue;
      }
      valid.push({
        verdict: m.verdict,
        createdAt: String(c.createdAt ?? ''),
        sourceKind: c.kind ?? 'comment',
        id: Number(c.id ?? 0),
      });
    }
  }
  if (valid.length === 0) return { verdict: null, diagnosis };

  const maxTime = valid.map((v) => v.createdAt).sort()[valid.length - 1];
  const latest = valid.filter((v) => v.createdAt === maxTime);
  const kinds = new Set(latest.map((v) => v.sourceKind));
  if (kinds.size === 1) {
    // Same id domain → ids are chronological; the highest id governs.
    latest.sort((a, b) => a.id - b.id);
    return { verdict: latest[latest.length - 1].verdict, diagnosis };
  }
  const verdicts = new Set(latest.map((v) => v.verdict));
  if (verdicts.size === 1) return { verdict: [...verdicts][0], diagnosis };
  // Contradictory contemporaneous evidence across id domains: fail closed.
  return { verdict: null, diagnosis: 'ambiguous' };
}

// ---------------------------------------------------------------------------
// Issue-form fields, governance, authorization, build admission
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
 *   - its label-event history shows it EVER carried an agent label.
 * Enrollment can only tighten governance, never loosen it: when the
 * event history could not be retrieved COMPLETELY (API failure,
 * pagination not exhausted), governance cannot be disproven — the PR is
 * treated as governed and the evaluator blocks it as unprovable.
 */
export function isGoverned(state) {
  const enrollment = state.pr?.enrollment ?? { everLabeledAgent: false, complete: true };
  return (
    (state.pr?.riskLabels?.length ?? 0) > 0 ||
    (state.pr?.builderLabels?.length ?? 0) > 0 ||
    Boolean(state.issue?.agentTask) ||
    Boolean(enrollment.everLabeledAgent) ||
    !enrollment.complete
  );
}

/**
 * Fail-closed decision for publishing a check run (post-check.mjs): a
 * transient lookup failure is NOT proof that no check exists — abort
 * rather than risk a duplicate same-name check; and only a check run
 * from the expected app may be updated in place.
 */
export function chooseCheckAction({ lookupOk, runs, name, appSlug = 'github-actions' }) {
  if (!lookupOk)
    return { action: 'abort', reason: 'existing-check lookup failed — cannot prove absence' };
  const ours = (runs ?? []).find((r) => r.name === name && r.appSlug === appSlug);
  if (ours) return { action: 'patch', id: ours.id };
  return { action: 'post' };
}

/**
 * READY-promotion decision for the contract authority, evaluated against
 * the RE-FETCHED current issue labels so both label orderings work
 * (builder first then status:ready, or the reverse) and duplicate label
 * events stay idempotent.
 */
export function readyPromotionAction({ labels }) {
  const l = labels ?? [];
  const builders = l.filter((x) => BUILDER_RE.test(x));
  const proceed = l.includes('agent-task') && l.includes('status:ready') && builders.length === 1;
  return { proceed, dispatchClaude: proceed && builders[0] === 'builder:claude' };
}

/** Repository permission levels that may start paid agent work. */
export function isActorAuthorized(permission) {
  return permission === 'admin' || permission === 'maintain' || permission === 'write';
}

/** Contract AMENDMENTS after implementation begins are owner-only. */
export function isContractAmendmentAuthorized(actor, ownerLogin) {
  return Boolean(actor) && actor === ownerLogin;
}

/**
 * Deterministic admission for starting a builder on an issue — evaluated
 * by the no-secret preflight BEFORE any secret-bearing job, under the
 * repository-wide implementation-lane concurrency lock. Fail closed.
 * `contract` is the computeContractRevision() result for the issue: a
 * valid current baseline is REQUIRED before the lane may be claimed —
 * no baseline, no admission, no status:building, no secret-bearing job.
 */
export function evaluateBuildAdmission({ issue, requiredBuilder, openLanes, contract }) {
  const reasons = [];
  const add = (code, message) => reasons.push({ code, message });
  if (!issue || !issue.exists) add('ADMIT_ISSUE_NOT_FOUND', 'The target issue does not exist.');
  else {
    const c = contract ?? { baselineFound: false, invalid: null, amended: false };
    if (c.invalid) {
      add(
        'ADMIT_CONTRACT_INVALID',
        `Issue #${issue.number} contract history is invalid: ${c.invalid}.`,
      );
    } else if (!c.baselineFound) {
      add(
        'ADMIT_BASELINE_MISSING',
        `Issue #${issue.number} has no authorized contract baseline yet; admission is refused until the contract-authority workflow (or the owner) records it.`,
      );
    } else if (c.amended) {
      add(
        'ADMIT_CONTRACT_INVALID',
        `Issue #${issue.number} body no longer matches its authorized contract baseline/revision.`,
      );
    }
    if (issue.state !== 'open') add('ADMIT_ISSUE_NOT_OPEN', `Issue #${issue.number} is not open.`);
    if (!issue.agentTask)
      add('ADMIT_NOT_AGENT_TASK', `Issue #${issue.number} is not an agent-task.`);
    const risk = (issue.riskLabels ?? []).filter((l) => RISK_RE.test(l));
    if (risk.length !== 1)
      add('ADMIT_RISK_INVALID', `Issue #${issue.number} must carry exactly one risk label.`);
    const builder = (issue.builderLabels ?? []).filter((l) => BUILDER_RE.test(l));
    if (builder.length !== 1 || builder[0] !== requiredBuilder)
      add('ADMIT_WRONG_BUILDER', `Issue #${issue.number} is not labelled ${requiredBuilder}.`);
    if (!(issue.labels ?? []).includes('status:ready'))
      add('ADMIT_NOT_READY', `Issue #${issue.number} is not status:ready.`);
    if (
      (issue.labels ?? []).some(
        (l) => l === 'needs-owner-decision' || l === 'status:blocked-decision',
      )
    )
      add('ADMIT_BLOCKED_DECISION', `Issue #${issue.number} has an unresolved owner decision.`);
    const otherLanes = (openLanes ?? []).filter((l) => l.issue !== issue.number);
    if (otherLanes.length > 0)
      add(
        'ADMIT_LANE_OCCUPIED',
        `The implementation lane is occupied (${otherLanes.map((l) => `#${l.issue}`).join(', ')}).`,
      );
  }
  return { admit: reasons.length === 0, reasons };
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

  const enrollment = state.pr?.enrollment ?? { everLabeledAgent: false, complete: true };
  if (!enrollment.complete)
    add(
      'ENROLLMENT_HISTORY_INCOMPLETE',
      'The PR label-event history could not be retrieved completely; governance cannot be proven and the gate fails closed.',
    );

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

    if (issue.commentsComplete === false) {
      add(
        'CONTRACT_HISTORY_INVALID',
        `Issue #${issue.number} comment history could not be proven complete; the contract state is unprovable and the gate fails closed.`,
      );
    }
    const rev = computeContractRevision({
      issueNumber: issue.number,
      issueBody: issue.body,
      issueComments: issue.comments,
      ownerLogin: cfg.ownerLogin,
      contractAuthorityKey: keys.contractAuthority ?? null,
    });
    if (issue.commentsComplete === false) {
      // fall through with no revision — unprovable history never yields one
    } else if (rev.invalid) {
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
    if (revision !== null) issue._activeContractHash = rev.expectedHash;
  }

  const target =
    revision !== null && issue
      ? {
          pr: state.pr.number,
          issue: issue.number,
          headSha: state.pr.headSha,
          contractRevision: revision,
          contractBodySha256: issue._activeContractHash,
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
        wrong_contract: [
          'TECH_WRONG_CONTRACT',
          'The technical marker binds a different contract snapshot hash than the active authorized contract.',
        ],
        malformed: [
          'TECH_MALFORMED',
          'The technical marker is malformed or carries an unsupported scheme; it never counts.',
        ],
        unauthorized: [
          'TECH_UNAUTHORIZED',
          'Technical-review evidence without valid reviewer provenance was rejected — nobody, including the builder, can substitute for the designated reviewer.',
        ],
        ambiguous: [
          'TECH_AMBIGUOUS_ORDER',
          'Contradictory contemporaneous technical verdicts with no provable order — fail closed; redispatch a fresh review.',
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
        wrong_contract: [
          'GEMINI_WRONG_CONTRACT',
          'The Gemini marker binds a different contract snapshot hash than the active authorized contract.',
        ],
        malformed: [
          'GEMINI_MALFORMED',
          'The Gemini marker is malformed or carries an unsupported scheme; it never counts.',
        ],
        unauthorized: [
          'GEMINI_UNAUTHORIZED',
          'Gemini-acceptance evidence without valid reviewer provenance was rejected.',
        ],
        ambiguous: [
          'GEMINI_AMBIGUOUS_ORDER',
          'Contradictory contemporaneous Gemini verdicts with no provable order — fail closed; redispatch a fresh review.',
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
  'ENROLLMENT_HISTORY_INCOMPLETE',
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
