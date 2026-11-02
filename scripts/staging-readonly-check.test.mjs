/**
 * Behaviour of scripts/staging-readonly-check.sh (REM-01). The real script is
 * piped into `bash -s`, as the runbook runs it over ssh, in a throwaway
 * checkout with a fake `docker` and `curl` on PATH; only the host directory is
 * substituted in a copy. Run with
 * `node --test scripts/staging-readonly-check.test.mjs` (CI does).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = readFileSync(new URL('./staging-readonly-check.sh', import.meta.url), 'utf8');

/**
 * A host checkout plus fakes. The fake `docker compose` reads all of stdin, as
 * a real `compose exec` can, and logs what it saw. `failKey` makes the
 * per-slot query for that one variable fail, as an exec that dies would.
 */
function host({ failKey = '', env = { META_TRIAL_TEMPLATE: 'rekoda_trial_ending' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'staging-check-'));
  const dir = join(root, 'rekoda');
  const fake = join(root, 'fake');
  mkdirSync(dir);
  mkdirSync(fake);
  const run = (cmd) => {
    const r = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  run('git init -q -b main . && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m c');
  writeFileSync(join(dir, '.env'), 'REKODA_RELEASE=staging-test\n');
  const bin = (name, body) => {
    writeFileSync(join(fake, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(fake, name), 0o755);
  };
  bin(
    'docker',
    `
if [ "$1" = compose ]; then
  n="$(cat | wc -c)"
  echo "compose $* stdin=$n" >> "${join(fake, 'calls.log')}"
  case " $* " in
    *" exec -T api true "*) exit 0 ;;
    *" exec -T -e K=${failKey || '__none__'} "*) exit 1 ;;
    *" exec -T -e K="*)
      # Run the container-side snippet for real, against the fixture environment.
      # argv: compose -f FILE exec -T -e K=NAME api sh -c SNIPPET
      k="$7"; shift 10
      env -i ${Object.entries(env)
        .map(([key, value]) => `${key}='${value}'`)
        .join(' ')} "$k" sh -c "$1"
      exit $? ;;
  esac
  exit 0
fi
echo image:test`,
  );
  bin('curl', 'echo ok');
  const script = SCRIPT.replaceAll('/opt/rekoda', dir);
  const go = (body = script) => {
    const r = spawnSync('bash', ['-s'], {
      cwd: dir,
      input: body,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, API_URL: 'https://x.invalid' },
    });
    return r.stdout;
  };
  return { go, script, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a compose call cannot swallow the rest of the piped script', () => {
  const h = host();
  try {
    const out = h.go();
    assert.match(out, /== Meta template slots in the running api/);
    assert.match(out, /META_TRIAL_TEMPLATE\s+SET/);
    // The same script without the stdin guard stops at the first compose call.
    const unguarded = h.script.replace('"$@" </dev/null; }', '"$@"; }');
    assert.notEqual(unguarded, h.script, 'the guard is where the test expects it');
    assert.doesNotMatch(h.go(unguarded), /== Meta template slots/);
  } finally {
    h.done();
  }
});

test('a failed per-slot query reads unknown, never UNSET', () => {
  const h = host({
    failKey: 'META_TRIAL_TEMPLATE',
    env: { META_OTP_TEMPLATE: 'rekoda_otp', META_TRIAL_TEMPLATE: 'rekoda_trial_ending' },
  });
  try {
    const out = h.go();
    assert.match(out, /META_TRIAL_TEMPLATE\s+unknown \(api query failed\)/);
    assert.doesNotMatch(out, /META_TRIAL_TEMPLATE\s+UNSET/);
    assert.match(out, /META_OTP_TEMPLATE\s+SET/);
  } finally {
    h.done();
  }
});

test('prints presence only, never a template value', () => {
  const h = host();
  try {
    const out = h.go();
    for (const k of [
      'META_OTP_TEMPLATE',
      'META_BILLING_TEMPLATE',
      'META_RETENTION_TEMPLATE',
      'META_DOCUMENT_TEMPLATE',
      'META_TRIAL_TEMPLATE',
    ]) {
      assert.match(out, new RegExp(`${k}\\s+(SET|UNSET|unknown \\(api query failed\\))\\n`));
    }
  } finally {
    h.done();
  }
});

test('reads set, empty and unset template variables as the API would', () => {
  const h = host({
    env: {
      META_OTP_TEMPLATE: 'rekoda_otp',
      META_BILLING_TEMPLATE: '',
      META_TRIAL_TEMPLATE: 'x y $z',
    },
  });
  try {
    const out = h.go();
    assert.match(out, /META_OTP_TEMPLATE\s+SET\n/);
    assert.match(out, /META_BILLING_TEMPLATE\s+UNSET\n/);
    assert.match(out, /META_RETENTION_TEMPLATE\s+UNSET\n/);
    assert.match(out, /META_TRIAL_TEMPLATE\s+SET\n/);
    assert.doesNotMatch(out, /rekoda_otp|x y/);
  } finally {
    h.done();
  }
});
