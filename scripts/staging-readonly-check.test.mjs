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
function host({
  failKey = '',
  env = { META_TRIAL_TEMPLATE: 'rekoda_trial_ending' },
  migrations = 'applied',
} = {}) {
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
    *" -e Q="*)
      # A migration query: answer from the fixture. "fail" writes a client error that names a
      # database user, as psql does, to prove it never reaches the output.
      case "${migrations}" in
        applied) echo t ;;
        missing) echo f ;;
        noaddr) case "$*" in *billing_email_address_requests*) echo f ;; *) echo t ;; esac ;;
        partial) case "$*" in *billing_interval*) echo f ;; *) echo t ;; esac ;;
        fail) echo "psql: FATAL: password authentication failed for user leakyuser" >&2; exit 2 ;;
      esac
      exit 0 ;;
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
  return {
    go,
    script,
    calls: () => readFileSync(join(fake, 'calls.log'), 'utf8').split('\n'),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
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

test('reports migration 0171 APPLIED when its columns exist', () => {
  const h = host({ migrations: 'applied' });
  try {
    const out = h.go();
    assert.match(out, /== annual-billing migrations/);
    assert.match(out, /0171 billing_interval\s+APPLIED\n/);
    for (const l of ['0172', '0173', '0174', '0175', '0182', '0185']) {
      assert.match(out, new RegExp(`${l} .*APPLIED\\n`));
    }
  } finally {
    h.done();
  }
});

test('reports migration 0171 MISSING when a column is absent, others unaffected', () => {
  const h = host({ migrations: 'partial' });
  try {
    const out = h.go();
    assert.match(out, /0171 billing_interval\s+MISSING\n/);
    assert.match(out, /0172 billing checkout columns\s+APPLIED\n/);
  } finally {
    h.done();
  }
});

test('a failed migration query reads unknown, never MISSING, and leaks no client error text', () => {
  const h = host({ migrations: 'fail' });
  try {
    const out = h.go();
    assert.match(out, /0171 billing_interval\s+unknown \(query failed/);
    assert.doesNotMatch(out, /0171 billing_interval\s+MISSING/);
    assert.doesNotMatch(out, /leakyuser|password authentication|FATAL: /);
  } finally {
    h.done();
  }
});

test('migration queries are read-only: read-only session, select-only SQL', () => {
  const h = host();
  try {
    h.go();
    const qs = h.calls().filter((l) => l.includes(' -e Q='));
    assert.ok(qs.length >= 8, 'every migration is asked');
    for (const l of qs) {
      assert.match(l, /PGOPTIONS=-c default_transaction_read_only=on/);
      const q = l.slice(l.indexOf(' -e Q=') + 6).toLowerCase();
      assert.match(q, /^select /);
      assert.doesNotMatch(q, /\b(insert|update|delete|alter|create|drop|truncate|grant)\b/);
    }
  } finally {
    h.done();
  }
});

test('0185 is APPLIED only when its table and all three functions are asked for, MISSING when the table is absent', () => {
  const h = host({ migrations: 'noaddr' });
  try {
    const out = h.go();
    assert.match(out, /0185 address limit objects\s+MISSING\n/);
    const q = h.calls().find((l) => l.includes('billing_email_address_claim')) ?? '';
    for (const fn of ['claim', 'wait', 'release'])
      assert.match(q, new RegExp(`billing_email_address_${fn}`));
    assert.match(q, /billing_email_address_requests/);
  } finally {
    h.done();
  }
});
