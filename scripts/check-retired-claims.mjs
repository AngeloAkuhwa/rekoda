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

/** Surfaces that must always describe the CURRENT architecture. */
const SCAN = [
  'apps/web/src',
  'README.md',
  'SECURITY.md',
  '.env.example',
  'docs/compliance',
  'docs/runbooks',
  'docs/ai-launch-readiness.md',
];

/** Each entry: the retired claim, and why it must stay retired. */
const RETIRED = [
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
      for (const { pattern, reason } of RETIRED) {
        if (pattern.test(line)) failures.push({ file, line: index + 1, reason });
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
