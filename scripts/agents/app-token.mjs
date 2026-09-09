#!/usr/bin/env node
/**
 * Mints a short-lived installation token for the dedicated
 * **Rekoda Gate Publisher** GitHub App (X6) — the ONLY identity whose
 * check runs the ruleset accepts for the three merge-authorization
 * gates. Deliberately implemented in ~60 lines of trusted repository
 * code instead of a third-party action: the App private key never
 * leaves this process, and the token is scoped to this repository with
 * checks:write only.
 *
 * The credential pair lives ONLY in the `agents-gate-publisher`
 * environment (main-only deployment restriction), so ordinary
 * GITHUB_TOKEN workflows — and any PR-defined job — can never mint it.
 *
 *   env: REKODA_GATE_PUBLISHER_APP_ID, REKODA_GATE_PUBLISHER_APP_PRIVATE_KEY
 *   node scripts/agents/app-token.mjs --repo owner/name
 *   → masks the token and writes token=… to GITHUB_OUTPUT
 */
import { createSign } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const repo = args.repo;
const appId = process.env.REKODA_GATE_PUBLISHER_APP_ID;
const appKey = process.env.REKODA_GATE_PUBLISHER_APP_PRIVATE_KEY;
const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};
if (!repo || !repo.includes('/')) fail('Usage: app-token.mjs --repo owner/name');
if (!appId || !appKey)
  fail(
    'The Rekoda Gate Publisher App credential is not configured (agents-gate-publisher environment) — no gate check can be published. The control plane fails closed.',
  );

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
const signer = createSign('RSA-SHA256');
signer.update(`${header}.${claims}`);
const jwt = `${header}.${claims}.${signer.sign(appKey, 'base64url')}`;

const api = async (path, opts = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) fail(`GitHub App API ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
};

const installation = await api(`/repos/${repo}/installation`);
const [, name] = repo.split('/');
const tokenRes = await api(`/app/installations/${installation.id}/access_tokens`, {
  method: 'POST',
  body: JSON.stringify({ repositories: [name], permissions: { checks: 'write' } }),
});
const token = tokenRes.token;
if (!token) fail('No installation token was returned.');
console.log(`::add-mask::${token}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `token=${token}\n`);
console.log(
  `Minted a repository-scoped checks:write token for App installation ${installation.id}.`,
);
