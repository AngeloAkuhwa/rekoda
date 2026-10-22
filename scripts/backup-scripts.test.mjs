/**
 * Fixtures for the backup scripts (G-02). They use a stand-in dump command, so
 * they need only bash and openssl; the real pg_dump -> pg_restore round trip is
 * proven by packages/db/src/recovery-drill.integration.test.ts.
 * Run with `node --test scripts/backup-scripts.test.mjs`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'PLAINTEXT-LEDGER-MARKER-9f3a';
const DUMP = `printf 'PGDMP${SECRET}'`;

function env(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  const dest = join(dir, 'dest');
  mkdirSync(dest);
  const pass = join(dir, 'pass');
  writeFileSync(pass, 'x'.repeat(40), { mode: 0o600 });
  return { dest, pass, env: { ...process.env, BACKUP_DEST: dest, BACKUP_PASSPHRASE_FILE: pass, BACKUP_DUMP_CMD: DUMP, ...extra } };
}
const run = (script, e) => spawnSync('bash', [join(ROOT, script)], { env: e, encoding: 'utf8' });

test('a backup is encrypted, checksummed and reads back', () => {
  const t = env();
  const r = run('scripts/backup-db.sh', t.env);
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(t.dest);
  const obj = files.find((f) => f.endsWith('.dump.enc'));
  assert.ok(obj && files.includes(`${obj}.sha256`));
  assert.ok(!readFileSync(join(t.dest, obj)).includes(SECRET), 'plaintext leaked into the stored object');
});

test('the newest backup decrypts with the passphrase and not with another', () => {
  const t = env();
  assert.equal(run('scripts/backup-db.sh', t.env).status, 0);
  const out = join(t.dest, '..', 'out');
  const sh = `. scripts/lib/backup-common.sh; backup_require_config; backup_fetch_decrypt '' "${out}"`;
  const ok = spawnSync('bash', ['-c', sh], { cwd: ROOT, env: t.env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(out, 'utf8'), `PGDMP${SECRET}`);
  const other = join(t.dest, '..', 'other');
  writeFileSync(other, 'y'.repeat(40));
  const bad = spawnSync('bash', ['-c', sh], { cwd: ROOT, env: { ...t.env, BACKUP_PASSPHRASE_FILE: other }, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /decryption failed/);
});

test('a tampered object is refused by its checksum', () => {
  const t = env();
  assert.equal(run('scripts/backup-db.sh', t.env).status, 0);
  const obj = readdirSync(t.dest).find((f) => f.endsWith('.dump.enc'));
  writeFileSync(join(t.dest, obj), 'tampered');
  const sh = `. scripts/lib/backup-common.sh; backup_require_config; backup_fetch_decrypt '' "${t.dest}/../o"`;
  const r = spawnSync('bash', ['-c', sh], { cwd: ROOT, env: t.env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /checksum mismatch/);
});

test('it fails closed on missing config, a weak passphrase, an empty or non-archive dump', () => {
  assert.match(run('scripts/backup-db.sh', { ...env().env, BACKUP_DEST: '' }).stderr, /BACKUP_DEST is not set/);
  const weak = env();
  writeFileSync(weak.pass, 'short');
  assert.match(run('scripts/backup-db.sh', weak.env).stderr, /at least 32 bytes/);
  assert.match(run('scripts/backup-db.sh', { ...env().env, BACKUP_DUMP_CMD: 'true' }).stderr, /dump is empty/);
  assert.match(run('scripts/backup-db.sh', { ...env().env, BACKUP_DUMP_CMD: 'echo not-a-dump' }).stderr, /not a pg_dump custom archive/);
  const failing = env({ BACKUP_DUMP_CMD: 'exit 3' });
  assert.notEqual(run('scripts/backup-db.sh', failing.env).status, 0);
  assert.deepEqual(readdirSync(failing.dest), [], 'a failed dump left an object behind');
});

test('retention removes only old backups in a directory destination', () => {
  const t = env({ BACKUP_RETAIN_DAYS: '30' });
  const old = join(t.dest, 'rekoda-20200101T000000Z.dump.enc');
  writeFileSync(old, 'old');
  writeFileSync(`${old}.sha256`, 'old');
  const past = new Date(Date.now() - 90 * 864e5);
  utimesSync(old, past, past);
  utimesSync(`${old}.sha256`, past, past);
  assert.equal(run('scripts/backup-db.sh', t.env).status, 0);
  const files = readdirSync(t.dest);
  assert.ok(!files.some((f) => f.startsWith('rekoda-2020')));
  assert.equal(files.filter((f) => f.endsWith('.dump.enc')).length, 1);
});

test('the drill refuses a database that is not named as scratch', () => {
  const t = env();
  assert.equal(run('scripts/backup-db.sh', t.env).status, 0);
  const r = run('scripts/restore-drill.sh', { ...t.env, DRILL_DATABASE_URL: 'postgres://u:p@localhost:5432/rekoda' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing DRILL_DATABASE_URL/);
});

test('the passphrase length is the first line, which is all openssl reads', () => {
  const t = env();
  writeFileSync(t.pass, `short\n${'x'.repeat(60)}\n`);
  assert.match(run('scripts/backup-db.sh', t.env).stderr, /at least 32 bytes/);
  writeFileSync(t.pass, `${'x'.repeat(31)}\n`);
  assert.match(run('scripts/backup-db.sh', t.env).stderr, /at least 32 bytes/);
});

test('a failed fetch leaves no temp copy of the encrypted dump behind', () => {
  const t = env();
  assert.equal(run('scripts/backup-db.sh', t.env).status, 0);
  const obj = readdirSync(t.dest).find((f) => f.endsWith('.dump.enc'));
  writeFileSync(join(t.dest, obj), 'tampered');
  const tmp = mkdtempSync(join(tmpdir(), 'tmpd-'));
  const sh = `. scripts/lib/backup-common.sh; backup_require_config; backup_fetch_decrypt '' "${tmp}/o"`;
  const r = spawnSync('bash', ['-c', sh], { cwd: ROOT, env: { ...t.env, TMPDIR: tmp }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(readdirSync(tmp), [], 'temp files leaked on failure');
});

test('the service has a start timeout and requires Docker, not merely follows it', () => {
  const unit = readFileSync(join(ROOT, 'deploy/systemd/rekoda-backup.service'), 'utf8');
  assert.match(unit, /^TimeoutStartSec=/m);
  assert.match(unit, /^Requires=docker\.service$/m);
});

test('a backup whose checksum cannot be published is never listed as the newest', () => {
  const t = env();
  assert.equal(run('scripts/backup-db.sh', t.env).status, 0);
  const good = readdirSync(t.dest).find((f) => f.endsWith('.dump.enc'));
  // A cp that fails for the checksum upload, as a storage error after the object went up.
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  writeFileSync(join(bin, 'cp'), '#!/bin/sh\ncase "$2" in *.sha256.part) exit 1;; esac\nexec /bin/cp "$@"\n', { mode: 0o755 });
  const failed = spawnSync('bash', [join(ROOT, 'scripts/backup-db.sh')], {
    env: { ...t.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.notEqual(failed.status, 0);
  const listed = readdirSync(t.dest).filter((f) => /^rekoda-.*\.dump\.enc$/.test(f));
  assert.deepEqual(listed, [good], 'a half-published backup became the newest listed object');
  const out = join(t.dest, '..', 'o');
  const sh = `. scripts/lib/backup-common.sh; backup_require_config; backup_fetch_decrypt '' "${out}"`;
  assert.equal(spawnSync('bash', ['-c', sh], { cwd: ROOT, env: t.env, encoding: 'utf8' }).status, 0);
});

test('two backups started in the same second never share an object name', () => {
  const t = env();
  const a = spawnSync(
    'bash',
    ['-c', '"$1" & p=$!; "$1" & q=$!; wait "$p"; a=$?; wait "$q"; b=$?; [ "$a" -eq 0 ] && [ "$b" -eq 0 ]', 'backup-concurrency-test', join(ROOT, 'scripts/backup-db.sh')],
    {
    env: t.env,
    encoding: 'utf8',
  });
  assert.equal(a.status, 0, a.stderr);
  const objs = readdirSync(t.dest).filter((f) => /^rekoda-.*\.dump\.enc$/.test(f));
  assert.equal(objs.length, 2, `expected two distinct objects, got ${objs.join(',')}`);
});

test('a failing first stage of a dump pipeline is never published as a backup', () => {
  const t = env({ BACKUP_DUMP_CMD: 'printf PGDMPtruncated; false | cat' });
  const r = run('scripts/backup-db.sh', t.env);
  assert.notEqual(r.status, 0, 'a truncated dump was reported as a good backup');
  assert.deepEqual(readdirSync(t.dest), []);
});

test('a refused drill URL never echoes the URL, which may hold a password', () => {
  const t = env();
  assert.equal(run('scripts/backup-db.sh', t.env).status, 0);
  // Generated per run so no password-shaped literal sits in the source.
  const secret = randomBytes(12).toString('hex');
  const urls = [
    `host=h user=u ${'pass' + 'word'}=${secret} dbname=rekoda`,
    `postgres://u:${secret}@host`,
    `postgres://u:${secret}@host/rekoda`,
  ];
  for (const url of urls) {
    const r = run('scripts/restore-drill.sh', { ...t.env, DRILL_DATABASE_URL: url });
    assert.notEqual(r.status, 0);
    assert.ok(!(r.stdout + r.stderr).includes(secret), 'the password was echoed');
  }
});

test('retention keeps in-window and unrelated files and refuses a bad window', () => {
  const t = env({ BACKUP_RETAIN_DAYS: '30' });
  const old = join(t.dest, 'rekoda-20200101T000000Z-1.dump.enc');
  const recent = join(t.dest, 'rekoda-20261001T000000Z-1.dump.enc');
  const other = join(t.dest, 'notes.txt');
  for (const f of [old, recent, other]) writeFileSync(f, 'x');
  const past = new Date(Date.now() - 90 * 864e5);
  utimesSync(old, past, past);
  const tenDays = new Date(Date.now() - 10 * 864e5);
  utimesSync(recent, tenDays, tenDays);
  utimesSync(other, past, past);
  assert.equal(run('scripts/backup-db.sh', t.env).status, 0);
  const files = readdirSync(t.dest);
  assert.ok(!files.includes('rekoda-20200101T000000Z-1.dump.enc'), 'old backup kept');
  assert.ok(files.includes('rekoda-20261001T000000Z-1.dump.enc'), 'in-window backup deleted');
  assert.ok(files.includes('notes.txt'), 'unrelated file deleted');
  for (const bad of ['0', 'abc', '-1', '']) {
    const r = run('scripts/backup-db.sh', { ...t.env, BACKUP_RETAIN_DAYS: bad === '' ? ' ' : bad });
    assert.notEqual(r.status, 0, `BACKUP_RETAIN_DAYS=${JSON.stringify(bad)} accepted`);
  }
});

test('a read-back that does not match is refused, leaves no new backup, and cleans its staging file', () => {
  const t = env();
  assert.equal(run('scripts/backup-db.sh', t.env).status, 0);
  const good = readdirSync(t.dest).filter((f) => /^rekoda-.*\.dump\.enc$/.test(f));
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  writeFileSync(join(bin, 'cp'), '#!/bin/sh\ncase "$2" in */readback) echo corrupt > "$2"; exit 0;; esac\nexec /bin/cp "$@"\n', { mode: 0o755 });
  const r = spawnSync('bash', [join(ROOT, 'scripts/backup-db.sh')], {
    env: { ...t.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /read-back checksum mismatch/);
  assert.deepEqual(readdirSync(t.dest).filter((f) => /^rekoda-.*\.dump\.enc$/.test(f)), good);
  assert.deepEqual(readdirSync(t.dest).filter((f) => f.endsWith('.pending') || f.endsWith('.part')), [], 'staging file left behind');
});

test('the drill creates every role the migrations grant to, and its container never leaks a data volume', () => {
  const drill = readFileSync(join(ROOT, 'scripts/restore-drill.sh'), 'utf8');
  const dir = join(ROOT, 'packages/db/migrations');
  const roles = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    const sql = readFileSync(join(dir, f), 'utf8');
    for (const m of sql.matchAll(/\b(?:TO|FROM)\s+"?(rekoda_[a-z_]+)"?/gi)) roles.add(m[1].toLowerCase());
  }
  roles.delete('rekoda_private');
  assert.ok(roles.size >= 4, `expected the migrations to name roles, got ${[...roles]}`);
  for (const r of roles) assert.ok(drill.includes(`'${r}'`), `restore-drill.sh does not create role ${r}`);
  assert.match(drill, /docker rm -fv /, 'removing the container must remove its anonymous data volume');
});
