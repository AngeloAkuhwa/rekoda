/**
 * Technical enforcement of the owner security direction on vendored design skills
 * (PR #317, .claude/skills/SOURCES.md "Patches to vendored files"):
 *   - Taste's inspect.mjs / scenes.mjs may never serve the repository;
 *   - Impeccable's launcher may never download or execute a binary.
 * Run with `node --test scripts/vendored-skills-hardening.test.mjs`.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASTE = join(ROOT, '.claude/skills/design-taste-frontend/scripts');
const IMP = join(ROOT, '.claude/skills/impeccable/scripts');

function scratch() {
  return mkdtempSync(join(tmpdir(), 'skills-harden-'));
}
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
const loadServe = () => import(join(TASTE, 'lib/rekoda-safe-serve.mjs'));

// --- Taste: the CLIs refuse before any browser or server starts -----------------------------

for (const script of ['inspect.mjs', 'scenes.mjs']) {
  test(`${script} refuses a page inside the git repository, with or without a marker`, () => {
    const dir = scratch();
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, 'index.html'), '<h1>x</h1>');
      writeFileSync(join(dir, '.env'), 'SECRET=1');
      for (const marker of [false, true]) {
        if (marker) writeFileSync(join(dir, '.taste-serve-root'), '');
        const r = spawnSync('node', [join(TASTE, script), join(dir, 'index.html')], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 20000,
        });
        assert.equal(r.status, 2, `marker=${marker}: ${r.stderr}`);
        assert.match(r.stderr, /refusing to serve/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${script} refuses a directory without the opt-in marker even outside any repo`, () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'index.html'), '<h1>x</h1>');
      const r = spawnSync('node', [join(TASTE, script), join(dir, 'index.html')], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 20000,
      });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /marker/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('safeServeRoot refuses a marked directory that contains .git or sits above the repo', async () => {
  const { safeServeRoot } = await loadServe();
  const top = scratch();
  try {
    execFileSync('git', ['init', '-q'], { cwd: top });
    writeFileSync(join(top, '.taste-serve-root'), '');
    writeFileSync(join(top, 'index.html'), 'x');
    assert.throws(() => safeServeRoot(join(top, 'index.html'), top), /git repository|\.git/);
    // a marked parent of the repo (cwd inside the repo) is refused too
    const sub = join(top, 'pkg');
    mkdirSync(sub);
    assert.throws(() => safeServeRoot(join(top, 'index.html'), sub), /git repository|\.git/);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

// --- Taste: the server itself ------------------------------------------------------------------

test('a marked, isolated directory is served; traversal, dotfiles, symlinks and foreign hosts are not', async () => {
  const { safeServeRoot, startSafeServer } = await loadServe();
  const base = scratch();
  const site = join(base, 'site');
  mkdirSync(site);
  writeFileSync(join(base, 'outside.txt'), 'OUTSIDE');
  writeFileSync(join(site, 'index.html'), '<h1>ok</h1>');
  writeFileSync(join(site, '.taste-serve-root'), '');
  writeFileSync(join(site, '.env'), 'SECRET=1');
  symlinkSync(join(base, 'outside.txt'), join(site, 'link.txt'));
  const root = safeServeRoot(join(site, 'index.html'), base);
  const { server, port } = await startSafeServer(root);
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const ok = await get(port, '/index.html');
    assert.equal(ok.status, 200);
    assert.match(ok.body, /ok/);
    assert.equal((await get(port, '/')).status, 200);
    for (const p of [
      '/../outside.txt',
      '/%2e%2e/outside.txt',
      '/..%2foutside.txt',
      '/.env',
      '/.taste-serve-root',
      '/link.txt',
    ]) {
      const r = await get(port, p);
      assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.doesNotMatch(r.body, /OUTSIDE|SECRET/);
    }
    assert.equal((await get(port, '/index.html', { host: 'evil.example' })).status, 403);
  } finally {
    server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Impeccable: the launcher cannot download or execute ---------------------------------------

test('the Impeccable launchers contain no download or exec path', () => {
  for (const f of ['impeccable', 'impeccable.cmd']) {
    const text = readFileSync(join(IMP, f), 'utf8');
    assert.doesNotMatch(
      text,
      /curl|wget|Invoke-WebRequest|certutil|releases\/download|\bexec\b|IMPECCABLE_BIN|bitsadmin/i,
      f,
    );
  }
});

test('the Impeccable launcher exits non-zero and ignores IMPECCABLE_BIN, PATH and the home cache', () => {
  const dir = scratch();
  try {
    const marker = join(dir, 'ran');
    const fake = join(dir, 'fake-engine');
    writeFileSync(fake, `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(fake, 0o755);
    const home = join(dir, 'home');
    mkdirSync(join(home, '.impeccable/bin'), { recursive: true });
    writeFileSync(join(home, '.impeccable/bin/impeccable'), `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(join(home, '.impeccable/bin/impeccable'), 0o755);
    for (const verb of ['context', 'engine-probe', 'doctor']) {
      const r = spawnSync('sh', [join(IMP, 'impeccable'), verb], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 20000,
        env: {
          PATH: `${dir}:/usr/bin:/bin`,
          HOME: home,
          IMPECCABLE_BIN: fake,
          IMPECCABLE_DOWNLOAD_BASE: 'http://127.0.0.1:9/',
        },
      });
      assert.notEqual(r.status, 0, verb);
      assert.match(r.stderr, /disabled/);
    }
    assert.equal(existsSync(marker), false, 'a binary was executed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
