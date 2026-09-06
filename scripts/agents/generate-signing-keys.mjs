#!/usr/bin/env node
/**
 * OWNER-RUN ONLY, locally. Generates the three Ed25519 signing
 * authorities of the control plane and:
 *   - writes the PUBLIC halves to scripts/agents/keys/*.pub.pem
 *     (commit these — the evaluator verifies with them);
 *   - prints the PRIVATE halves to stdout ONCE, for pasting into the
 *     matching GitHub environment secrets (never committed, never
 *     written to disk by this script):
 *       agents-claude-reviewer  → CLAUDE_REVIEWER_SIGNING_KEY
 *       agents-gemini-reviewer  → GEMINI_REVIEWER_SIGNING_KEY
 *       agents-contract-authority → CONTRACT_AUTHORITY_SIGNING_KEY
 * Rotation = re-run, replace the secrets, commit the new public keys.
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'keys');
mkdirSync(KEYS_DIR, { recursive: true });

const roles = [
  ['claude-reviewer', 'CLAUDE_REVIEWER_SIGNING_KEY', 'agents-claude-reviewer'],
  ['gemini-reviewer', 'GEMINI_REVIEWER_SIGNING_KEY', 'agents-gemini-reviewer'],
  ['contract-authority', 'CONTRACT_AUTHORITY_SIGNING_KEY', 'agents-contract-authority'],
];

for (const [name, secretName, envName] of roles) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  writeFileSync(join(KEYS_DIR, `${name}.pub.pem`), pub);
  console.log(`\n=== ${name} ===`);
  console.log(`Public key written to scripts/agents/keys/${name}.pub.pem (commit it).`);
  console.log(`Paste the following into environment '${envName}' as secret ${secretName}:`);
  console.log(priv);
}
console.log('Done. Commit the .pub.pem files; the private keys above exist nowhere else.');
