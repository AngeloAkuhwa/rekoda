/**
 * I1 (OWN-70): staging's settings come from /opt/rekoda/.env and nowhere else. Compose reads an
 * exported COMPOSE_ENV_FILES ahead of the project's .env unless it is given --env-file, so a deploy
 * shell that exported it (pointing at a file with a live Paystack key, say) would have Compose hand
 * settlement a key the script's .env checks never saw. The deploy names `--env-file .env` on every
 * compose call; these tests run the real script and, where docker compose is installed (CI's
 * runners have it), let real Compose resolve the file the way the script asks it to. Only the class
 * of the resolved key is ever recorded. Run with `node --test scripts/deploy-staging-envfile.test.mjs`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { host, LIVE_KEY, PRINCIPAL_ENV } from './deploy-staging.fixtures.mjs';

/* A real docker with the compose plugin, or null. `docker compose config` needs no daemon. */
const REAL_DOCKER = (() => {
  const which = spawnSync('bash', ['-c', 'command -v docker'], { encoding: 'utf8' });
  const path = which.stdout.trim();
  if (which.status !== 0 || !path) return null;
  return spawnSync(path, ['compose', 'version'], { encoding: 'utf8' }).status === 0 ? path : null;
})();
/* On CI the real resolution is the point of the test, so a runner without compose fails it. */
const skipReal = REAL_DOCKER || process.env.CI ? false : 'docker compose is not installed here';

/** A file outside the checkout, of the kind COMPOSE_ENV_FILES would name, holding a live-shaped key. */
function foreignEnvFile() {
  const file = join(mkdtempSync(join(tmpdir(), 'deploy-envfile-')), 'elsewhere.env');
  writeFileSync(file, `PAYSTACK_SECRET_KEY=${LIVE_KEY}\n`);
  return file;
}

test('every compose call the deploy makes names .env explicitly, ahead of the compose file', () => {
  const h = host(['0198_something_additive']);
  const r = h.run({ COMPOSE_ENV_FILES: foreignEnvFile() });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const compose = h.calls().filter((c) => c.startsWith('compose ') && c !== 'compose version');
  assert.ok(compose.length > 0, 'compose was called');
  for (const call of compose) {
    assert.ok(call.startsWith('compose --env-file .env -f docker-compose.prod.yml '), call);
  }
});

test(
  'with COMPOSE_ENV_FILES exported at a live key, real Compose still resolves the TEST key from .env',
  { skip: skipReal },
  () => {
    assert.ok(REAL_DOCKER, 'docker compose must be installed on CI');
    const h = host(['0198_something_additive'], PRINCIPAL_ENV, undefined, {
      realDocker: REAL_DOCKER,
    });
    const elsewhere = foreignEnvFile();

    /* Control: the same checkout and variable, without --env-file, does resolve the foreign file's
     * key. Without this the test could pass on a Compose that ignores COMPOSE_ENV_FILES altogether. */
    const bare = spawnSync(REAL_DOCKER, ['compose', '-f', 'docker-compose.prod.yml', 'config'], {
      cwd: h.dir,
      encoding: 'utf8',
      env: { ...process.env, COMPOSE_ENV_FILES: elsewhere },
    });
    assert.equal(bare.status, 0, 'compose config ran');
    assert.ok(
      bare.stdout.includes('sk_live_'),
      'COMPOSE_ENV_FILES wins over .env when not overridden',
    );

    const r = h.run({ COMPOSE_ENV_FILES: elsewhere });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const resolved = h.resolvedKeys();
    assert.ok(resolved.length > 0, 'real Compose resolved the file the script used');
    assert.deepEqual(
      [...new Set(resolved)],
      ['test'],
      'every call resolves the TEST key from .env',
    );
    assert.doesNotMatch(r.stderr + r.stdout, /placeholderkey/, 'a key is never printed');
  },
);

test(
  'a COMPOSE_PROJECT_NAME hidden after the closing quote of a multi-line value is refused: real Compose decides',
  { skip: skipReal },
  () => {
    assert.ok(REAL_DOCKER, 'docker compose must be installed on CI');
    /* The continuation line starts with '#', so a line-based check reads it as a comment, while
     * Compose reads a new statement after the closing quote. */
    const hidden = 'NOTE="x\n#"COMPOSE_PROJECT_NAME=elsewhere\n';
    const h = host(['0198_something_additive'], PRINCIPAL_ENV + hidden, undefined, {
      realDocker: REAL_DOCKER,
    });
    const control = spawnSync(
      REAL_DOCKER,
      ['compose', '--env-file', '.env', '-f', 'docker-compose.prod.yml', 'config'],
      { cwd: h.dir, encoding: 'utf8' },
    );
    assert.match(control.stdout, /^name: elsewhere$/m, 'Compose reads the hidden statement');
    const r = h.run();
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr,
      /Compose resolves this deployment to project 'elsewhere', not rekoda-prod/,
    );
    assert.equal(h.at(' build '), -1, 'nothing may be built');
    assert.doesNotMatch(r.stderr + r.stdout, /placeholderkey/, 'a key is never printed');
  },
);

test(
  'OWN-70: a live key hidden after the closing quote of a multi-line value is refused: real Compose decides',
  { skip: skipReal },
  () => {
    assert.ok(REAL_DOCKER, 'docker compose must be installed on CI');
    const hidden = `NOTE="x\n#"PAYSTACK_SECRET_KEY=${LIVE_KEY}\n`;
    const h = host(['0198_something_additive'], PRINCIPAL_ENV + hidden, undefined, {
      realDocker: REAL_DOCKER,
    });
    const control = spawnSync(
      REAL_DOCKER,
      ['compose', '--env-file', '.env', '-f', 'docker-compose.prod.yml', 'config', 'settlement'],
      { cwd: h.dir, encoding: 'utf8' },
    );
    assert.match(control.stdout, /PAYSTACK_SECRET_KEY: sk_live_/, 'Compose reads the hidden key');
    const r = h.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Compose does not resolve a Paystack TEST key/);
    assert.equal(h.at(' build '), -1, 'nothing may be built');
    assert.doesNotMatch(r.stderr + r.stdout, /placeholderkey/, 'a key is never printed');
  },
);
