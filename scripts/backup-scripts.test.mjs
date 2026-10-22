/**
 * Fixtures for the backup scripts (G-02). They use a stand-in dump command, so
 * they need only bash and openssl; the real pg_dump -> pg_restore round trip is
 * proven by packages/db/src/recovery-drill.integration.test.ts.
 * Run with `node --test scripts/backup-scripts.test.mjs`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;
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

test('the service has a start timeout', () => {
  assert.match(readFileSync(join(ROOT, 'deploy/systemd/rekoda-backup.service'), 'utf8'), /^TimeoutStartSec=/m);
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
