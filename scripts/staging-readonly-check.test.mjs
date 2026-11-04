/**
 * Behaviour of scripts/staging-readonly-check.sh (REM-01). The real script is
 * piped into `bash -s`, as the runbook runs it over ssh, in a throwaway
 * checkout with a fake `docker` and `curl` on PATH; only the host directory is
 * substituted in a copy. Run with
 * `node --test scripts/staging-readonly-check.test.mjs` (CI does).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SCRIPT,
  SLOTS,
  TAGS,
  attention,
  healthy,
  host,
} from './staging-readonly-check.fixtures.mjs';

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

test('objects without a ledger tag read INCOMPLETE, a tag without objects reads INCONSISTENT', () => {
  const noLedger = host({ migrations: 'noledger' });
  const ledgerOnly = host({ migrations: 'ledgeronly' });
  try {
    const out = noLedger.go();
    assert.match(
      out,
      /0171 billing_interval\s+INCOMPLETE \(objects exist, migration not recorded\)\n/,
    );
    assert.doesNotMatch(out, /0171 billing_interval\s+APPLIED/);
    const q = noLedger.calls().find((l) => l.includes('rekoda_migrations')) ?? '';
    assert.match(q, /tag = '0171_billing_interval'/);
    assert.match(
      ledgerOnly.go(),
      /0171 billing_interval\s+INCONSISTENT \(recorded, objects missing\)\n/,
    );
  } finally {
    noLedger.done();
    ledgerOnly.done();
  }
});

/* ── the post-deploy checks: commit, image parity, migration ledger, reminders ── */

test('a healthy host at EXPECT_SHA: every check passes and attention reads none', () => {
  const h = healthy();
  try {
    const out = h.go(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(out, /checkout matches EXPECT_SHA\s+yes\n/);
    assert.match(out, /api and worker image\s+SAME\n/);
    assert.match(out, /api image is the \.env release\s+yes\n/);
    assert.match(out, /served commit matches EXPECT_SHA\s+yes\n/);
    assert.match(out, /served release is staging-<commit>\s+yes\n/);
    for (const l of [
      '0187 payment instruction columns',
      '0188 payment check validated',
      '0189 reminder batch tables',
    ]) {
      assert.match(out, new RegExp(`${l}\\s+APPLIED\\n`));
    }
    assert.match(
      out,
      new RegExp(`expected migrations\\s+${TAGS.length} \\(last 0189_reminder_batches\\)\\n`),
    );
    assert.match(
      out,
      new RegExp(`applied migrations\\s+${TAGS.length} \\(last 0189_reminder_batches\\)\\n`),
    );
    assert.match(out, /not applied\s+none\n/);
    assert.match(out, new RegExp(`/health migrations = expected\\s+yes \\(${TAGS.length}\\)\\n`));
    assert.match(out, /REKODA_CUSTOMER_REMINDERS \(api\)\s+ON \(1\)\n/);
    assert.match(out, /REKODA_CUSTOMER_REMINDERS \(worker\)\s+ON \(1\)\n/);
    assert.match(out, /PAYSTACK_SECRET_KEY\s+SET \(TEST-KEY\)\n/);
    assert.match(attention(out), /== attention[^\n]*\nnone\nRESULT: OK [^\n]*\n$/);
  } finally {
    h.done();
  }
});

test('a full EXPECT_SHA matches too, and a different one is NO for checkout and served commit', () => {
  const h = healthy();
  try {
    assert.match(
      h.go(undefined, { EXPECT_SHA: h.sha }),
      /served commit matches EXPECT_SHA\s+yes\n/,
    );
    const out = h.go(undefined, { EXPECT_SHA: 'deadbee' });
    assert.match(out, /checkout matches EXPECT_SHA\s+NO\n/);
    assert.match(out, /served commit matches EXPECT_SHA\s+NO\n/);
    assert.match(attention(out), /checkout matches EXPECT_SHA\s+NO/);
  } finally {
    h.done();
  }
});

test('a missing migration is named, its object check reads MISSING, and /health disagrees', () => {
  const h = healthy({
    ledger: TAGS.filter((t) => t !== '0189_reminder_batches'),
    migrations: 'no0189',
    health: `{"status":"degraded","database":"up","migrations":${TAGS.length - 1},"release":"staging-{sha7}","commit":"{sha7}"}`,
  });
  try {
    const out = h.go(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(out, /0189 reminder batch tables\s+MISSING\n/);
    assert.match(out, /0187 payment instruction columns\s+APPLIED\n/);
    assert.match(
      out,
      new RegExp(
        `applied migrations\\s+${TAGS.length - 1} \\(last 0188_validate_payment_instruction_check\\)\\n`,
      ),
    );
    assert.match(out, /not applied\s+0189_reminder_batches\n/);
    assert.match(
      out,
      new RegExp(
        `/health migrations = expected\\s+NO \\(${TAGS.length - 1} served, ${TAGS.length} expected\\)\\n`,
      ),
    );
    const a = attention(out);
    for (const l of [
      'served status',
      '0189 reminder batch tables',
      'not applied',
      '/health migrations = expected',
    ])
      assert.ok(a.includes(l), `${l} is under attention`);
  } finally {
    h.done();
  }
});

test('an applied tag this checkout does not carry is listed, not ignored', () => {
  const h = healthy({ ledger: [...TAGS, '0190_from_a_newer_build'] });
  try {
    const out = h.go(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(out, /applied but not in this checkout\s+0190_from_a_newer_build\n/);
    assert.match(attention(out), /applied but not in this checkout/);
  } finally {
    h.done();
  }
});

test('missing configuration is flagged: no EXPECT_SHA, live or absent key, platform flag set, slot unset, invalid reminders', () => {
  const h = healthy({
    dotenv: 'REKODA_RELEASE=staging-{sha7}\n',
    env: { META_OTP_TEMPLATE: 'a', REKODA_PAYSTACK_PLATFORM_CONFIRMED: '1' },
    workerEnv: { REKODA_CUSTOMER_REMINDERS: '' },
    images: { api: 'rekoda-app:staging-{sha7}', web: 'rekoda-web:staging-{sha7}' },
  });
  try {
    const out = h.go();
    const a = attention(out);
    assert.match(out, /EXPECT_SHA\s+not given/);
    assert.match(out, /image of worker\s+MISSING\n/);
    assert.match(out, /api and worker image\s+unknown \(a container is missing\)\n/);
    assert.match(
      out,
      /PAYSTACK_SECRET_KEY\s+UNSET \(staging test payments need an sk_test_ key\)\n/,
    );
    assert.match(
      out,
      /REKODA_PAYSTACK_PLATFORM_CONFIRMED\s+SET \(OWN-70: it stays UNSET on staging\)\n/,
    );
    assert.match(out, /META_TRIAL_TEMPLATE\s+UNSET\n/);
    assert.match(out, /REKODA_CUSTOMER_REMINDERS \(api\)\s+OFF \(unset; the default is off\)\n/);
    assert.match(out, /REKODA_CUSTOMER_REMINDERS \(worker\)\s+INVALID/);
    for (const l of [
      'EXPECT_SHA',
      'image of worker',
      'PAYSTACK_SECRET_KEY',
      'REKODA_PAYSTACK_PLATFORM_CONFIRMED',
      'META_TRIAL_TEMPLATE',
      'REKODA_CUSTOMER_REMINDERS (worker)',
    ])
      assert.ok(a.includes(l), `${l} is under attention`);
    // Off by default is the expected state before the reminder journeys, so it is not flagged.
    assert.ok(!a.includes('REKODA_CUSTOMER_REMINDERS (api)'));
  } finally {
    h.done();
  }
});

test('a live Paystack key on staging is flagged without printing it', () => {
  const h = healthy({
    env: { ...SLOTS, PAYSTACK_SECRET_KEY: 'sk_live_zzzzzzzzzzzzzzzz' },
  });
  try {
    const out = h.go(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(
      out,
      /PAYSTACK_SECRET_KEY\s+SET \(NOT-A-TEST-KEY: a live key; staging must run an sk_test_ key\)\n/,
    );
    assert.doesNotMatch(out, /zzzzzzzz|sk_live_/);
  } finally {
    h.done();
  }
});

test('different api and worker images read DIFFERENT; an image that is not the release reads NO', () => {
  const h = healthy({
    images: { api: 'rekoda-app:staging-0000000', worker: 'rekoda-app:staging-{sha7}', web: 'w' },
  });
  try {
    const out = h.go(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(out, /api and worker image\s+DIFFERENT\n/);
    assert.match(out, /api image is the \.env release\s+NO \(expected rekoda-app:staging-/);
  } finally {
    h.done();
  }
});

test('checks that cannot be made read unknown, never pass: /health down, ledger query failed, no journal, no exec', () => {
  const h = healthy({
    health: 'fail',
    ledger: 'fail',
    journal: null,
    migrations: 'fail',
    failKey: 'REKODA_CUSTOMER_REMINDERS',
  });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    const out = r.stdout;
    assert.equal(r.status, 1, out);
    assert.match(out, /RESULT: ATTENTION \(\d+ item\(s\) above need a look\)\n$/);
    assert.match(out, /\/health\s+FAIL \(no answer\)\n/);
    assert.match(out, /expected migrations\s+unknown \(cannot read/);
    assert.match(out, /applied migrations\s+unknown \(query failed/);
    assert.doesNotMatch(out, /not applied\s+none/);
    assert.match(out, /REKODA_CUSTOMER_REMINDERS \(api\)\s+unknown \(cannot exec/);
    assert.doesNotMatch(out, /leakyuser|password authentication/);
    assert.doesNotMatch(attention(out), /\nnone\n/);
  } finally {
    h.done();
  }
});

test('no secret value reaches the output: keys, connection strings and .env values stay hidden', () => {
  const h = healthy();
  try {
    const out = h.go(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.doesNotMatch(out, /qqqqqqqq|rrrrrrrr|wwwwwwww|vvvvvvvv|whsec_|postgres:\/\//);
    assert.match(out, /RESEND_API_KEY\s+SET\n/);
    assert.match(out, /WORKER_DATABASE_URL\s+SET\n/);
  } finally {
    h.done();
  }
});

test('the script never runs a writing command against the host', () => {
  // Static: no migrate, restart, up, down, pull, rm, or write SQL anywhere in the script.
  assert.doesNotMatch(
    SCRIPT,
    /migrate:apply|dist\/migrate|compose[^\n]*\b(up|down|restart|stop|rm|pull|build|run)\b/,
  );
  assert.doesNotMatch(
    SCRIPT.toLowerCase(),
    /\b(insert into|update [a-z_]+ set|delete from|alter table|drop |truncate )/,
  );
  assert.doesNotMatch(SCRIPT, /(^|[^<])>\s*\.env|sed -i/);
});

test('the verdict line and exit status: OK and 0 only when nothing needs attention', () => {
  const ok = healthy();
  const bad = healthy({ ledger: TAGS.filter((x) => x !== '0189_reminder_batches') });
  try {
    const good = ok.run2(undefined, { EXPECT_SHA: ok.sha.slice(0, 7) });
    assert.equal(good.status, 0, good.stdout);
    assert.match(good.stdout, /RESULT: OK \(every check above is as expected\)\n$/);
    const r = bad.run2(undefined, { EXPECT_SHA: bad.sha.slice(0, 7) });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /RESULT: ATTENTION \(\d+ item\(s\) above need a look\)\n$/);
    assert.doesNotMatch(r.stdout, /RESULT: OK/);
  } finally {
    ok.done();
    bad.done();
  }
});

test('a migration whose tag is recorded but whose objects are gone reads INCONSISTENT, never APPLIED', () => {
  // The disposable-database case: 0187's constraint dropped, its ledger tag kept. The ledger
  // still lists 0187 as applied by tag, so only the objects check can catch it.
  const h = healthy({ migrations: 'broken0187' });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(
      r.stdout,
      /0187 payment instruction columns\s+INCONSISTENT \(recorded, objects missing\)\n/,
    );
    assert.doesNotMatch(r.stdout, /0187 payment instruction columns\s+APPLIED/);
    assert.match(attention(r.stdout), /0187 payment instruction columns\s+INCONSISTENT/);
    assert.equal(r.status, 1);
  } finally {
    h.done();
  }
});

test('reminders set to 0 read OFF (0) and, like the default, are not flagged', () => {
  const h = healthy({
    env: {
      ...SLOTS,
      PAYSTACK_SECRET_KEY: 'sk_test_qqqqqqqqqqqqqqqq',
      REKODA_CUSTOMER_REMINDERS: '0',
    },
    workerEnv: { REKODA_CUSTOMER_REMINDERS: '0' },
  });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(r.stdout, /REKODA_CUSTOMER_REMINDERS \(api\)\s+OFF \(0\)\n/);
    assert.match(r.stdout, /REKODA_CUSTOMER_REMINDERS \(worker\)\s+OFF \(0\)\n/);
    assert.equal(r.status, 0, r.stdout);
  } finally {
    h.done();
  }
});
