#!/usr/bin/env node
/**
 * Retired factual claims must not reappear on a CURRENT surface.
 *
 * ADR 0032 replaced the self-hosted media plan with hosted OpenAI
 * transcription and Anthropic vision, and the launch remediation removed
 * every live claim built on the old plan. History keeps its words — the
 * superseded ADRs and the historical planning documents still quote them,
 * accurately, as the record of a decision that changed — but a CURRENT
 * surface repeating one of these claims would be telling the public
 * something the deployed code does not do.
 *
 * Scope is deliberately narrow to keep false positives near zero: only
 * the surfaces that must always describe the present are scanned. The
 * historical documents (docs/adr/00*.md, MASTER-PLAN, HANDOFF,
 * ai-model-strategy's on-the-record history section) are deliberately NOT
 * scanned — quoting a retired claim as history is legitimate there.
 * Every pattern below is a phrase with essentially one meaning, so a
 * match in scope is a regression, not a coincidence.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Surfaces that must always describe the CURRENT architecture.
 *
 * The source trees are here because a retired claim does not stop being one
 * when it moves from a page into a comment (remediation R12). The scanner
 * was built to keep the PUBLIC surfaces honest, and it did, while the
 * codebase kept a line describing a transcriber Rekoda does not run. The
 * next person to read it would have believed it.
 *
 * `packages/db/migrations` is deliberately NOT scanned, for the same reason
 * the historical ADRs are not. A migration is immutable once shipped, so a
 * match there could not be fixed without editing history. That makes it a
 * trap rather than a guard, and a guard nobody can satisfy gets deleted.
 */
const SCAN = [
  'apps/web/src',
  'apps/api/src',
  'packages/core/src',
  'packages/db/src',
  'packages/contracts/src',
  'README.md',
  'SECURITY.md',
  '.env.example',
  'docs/compliance',
  'docs/runbooks',
  'docs/ai-launch-readiness.md',
];

/**
 * Each entry: the retired claim, and why it must stay retired.
 *
 * `unless` is optional, and exists for a claim whose words are also the
 * words used to DENY it. A guard that flagged "narration is never stored"
 * would be flagging the sentence this repository now wants to be able to
 * write, and the author would word around the guard rather than fix
 * anything. Where a pattern has that shape, `unless` names the line that
 * says the opposite, and the line is left alone.
 */
const RETIRED = [
  {
    /* R7 (migrations 0125 to 0127). The bank's own description is read in
     * memory, the Rekoda references are pulled out of it, and the row keeps
     * only those. A surface saying the narration is stored, or shown to the
     * merchant, would be describing the model this replaced.
     *
     * Deliberately narrow: "narration" or "the bank's own words" within a
     * few words of stored/shown/displayed/retained, so a sentence about
     * anything else is out of reach. `unless` then spares every way of
     * saying the opposite, which is what the current surfaces say. */
    pattern:
      /\b(narration|bank(?:'|\u2019)?s own words)\b[^.\n]{0,40}\b(stored|shown to the merchant|displayed|retained|kept on the row)\b/i,
    unless: /\b(not|never|no longer|nothing|without|stops|stopped|instead of)\b/i,
    reason:
      'R7 stopped storing bank narration: the row keeps the extracted RKD-PAY references and nothing of the text (migrations 0125 to 0127)',
  },

  {
    /* ADR 0033. Multicurrency is under active development and DARK: the
     * launch is NGN-only. A current surface saying Rekoda supports, offers or
     * accepts multiple currencies would be describing a capability no
     * merchant can reach, on a page a merchant can.
     *
     * `unless` spares the sentences this repository needs to be able to
     * write, which are all of the form "not yet", "dark", "NGN-only". */
    pattern:
      /\b(multi[- ]?currency|foreign currency|multiple currencies)\b[^.\n]{0,50}\b(supported|available|enabled|offered|live)\b/i,
    unless: /\b(not|never|no longer|dark|nor|until|once|when|NGN-only|graduation)\b/i,
    reason:
      'multicurrency is a DARK capability under development (ADR 0033): the launch is NGN-only and no surface may describe FX as available',
  },

  {
    pattern: /audio never leaves/i,
    reason:
      'the "audio never leaves Rekoda" promise died with ADR 0032: voice notes are transcribed by hosted OpenAI',
  },
  {
    pattern: /afrispeech/i,
    reason:
      'the AfriSpeech-tuned sidecar (ADR 0008) is not part of the launch architecture (superseded by ADR 0032)',
  },
  {
    pattern: /our own transcri/i,
    reason: 'Rekoda runs no transcriber of its own; OpenAI is the named transcription processor',
  },
  {
    pattern: /\b(STT_URL|OCR_URL|STT_FALLBACK)\b/,
    reason: 'these sidecar configuration variables were removed with the sidecars (ADR 0032)',
  },
  {
    pattern: /self-hosted whisper|whisper sidecar/i,
    reason: 'no self-hosted Whisper exists in the launch architecture (ADR 0032)',
  },
];

function* walk(path) {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* walk(child);
    else yield child;
  }
}

const failures = [];
for (const root of SCAN) {
  for (const file of walk(root)) {
    // This script names its own patterns; nothing else in scope is a script.
    if (file.endsWith('check-retired-claims.mjs')) continue;
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const { pattern, unless, reason } of RETIRED) {
        if (!pattern.test(line)) continue;
        if (unless?.test(line)) continue;
        failures.push({ file, line: index + 1, reason });
      }
    });
  }
}

if (failures.length > 0) {
  console.error('Retired claims found on CURRENT surfaces (docs must follow deployed code):');
  for (const f of failures) console.error(`  ${f.file}:${f.line} — ${f.reason}`);
  process.exit(1);
}
console.log(`Retired-claims check OK — ${RETIRED.length} patterns, ${SCAN.length} surfaces clean.`);
