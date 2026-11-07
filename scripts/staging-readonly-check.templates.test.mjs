/**
 * The WhatsApp template section of scripts/staging-readonly-check.sh (OD-41(b)): the five slots in
 * the running api and worker, required against optional, the agreed names and trial language, and
 * the billing link origin. The script is run as in staging-readonly-check.test.mjs (a throwaway
 * checkout with a fake `docker` and `curl`). Run with
 * `node --test scripts/staging-readonly-check.templates.test.mjs` (CI does).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SCRIPT, SLOTS, attention, healthy } from './staging-readonly-check.fixtures.mjs';

/* OD-41(b): the five slots, required against optional, in both containers. */

test('the bash slot list is the same as apps/api/src/channels/template-slots.ts', () => {
  const ts = readFileSync(
    new URL('../apps/api/src/channels/template-slots.ts', import.meta.url),
    'utf8',
  );
  const fromTs = [
    ...ts.matchAll(
      /env: '(META_\w+)',[\s\S]*?agreedName: '(\w+)',\s*agreedLocale: (null|'(\w+)'),[\s\S]*?required: (true|false),/g,
    ),
  ].map((m) => [m[1], m[5] === 'true' ? 'required' : 'optional', m[2], m[4] ?? '-'].join(' '));
  const block = SCRIPT.match(/TEMPLATE_SLOTS="([^"]*)"/);
  assert.ok(block, 'the script declares TEMPLATE_SLOTS');
  assert.equal(fromTs.length, 5);
  assert.deepEqual(block[1].split('\n'), fromTs);
});

test('a healthy host reads every slot as the agreed name in api and worker, and the billing link', () => {
  const h = healthy();
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    for (const c of ['api', 'worker']) {
      for (const k of Object.keys(SLOTS).filter((k) => k.endsWith('_TEMPLATE')))
        assert.match(r.stdout, new RegExp(`${k} \\(${c}\\)\\s+SET, the agreed name\\n`));
      assert.match(
        r.stdout,
        new RegExp(`META_TRIAL_TEMPLATE_LOCALE \\(${c}\\)\\s+en, the agreed language\\n`),
      );
      assert.match(
        r.stdout,
        new RegExp(
          `billing link in templates \\(${c}\\)\\s+https origin/app/billing \\(pass EXPECT_WEB_URL to compare\\)\\n`,
        ),
      );
    }
    assert.match(r.stdout, /configuration only, not Meta approval/);
    // The origin is classified, never printed.
    assert.doesNotMatch(r.stdout, /staging\.invalid/);
    assert.equal(r.status, 0, r.stdout);
  } finally {
    h.done();
  }
});

test('EXPECT_WEB_URL is compared inside each container: the agreed origin passes, another is ATTENTION', () => {
  const h = healthy({
    workerEnv: {
      ...SLOTS,
      REKODA_WEB_URL: 'https://other.invalid/',
      REKODA_CUSTOMER_REMINDERS: '1',
      REKODA_EMAIL_PROVIDER: 'resend',
    },
  });
  try {
    const r = h.run2(undefined, {
      EXPECT_SHA: h.sha.slice(0, 7),
      EXPECT_WEB_URL: 'https://staging.invalid',
    });
    assert.match(r.stdout, /billing link in templates \(api\)\s+EXPECT_WEB_URL\/app\/billing\n/);
    assert.match(
      r.stdout,
      /billing link in templates \(worker\)\s+REKODA_WEB_URL is not EXPECT_WEB_URL\n/,
    );
    assert.ok(attention(r.stdout).includes('billing link in templates (worker)'));
    assert.doesNotMatch(r.stdout, /other\.invalid/);
    // A malformed EXPECT_WEB_URL is refused, never placed in the container command.
    const bad = h.run2(undefined, { EXPECT_WEB_URL: 'https://x.invalid/"; rm -rf /' });
    // A value whose FIRST line is a valid origin is refused too, never spliced into the command.
    const multi = h.run2(undefined, { EXPECT_WEB_URL: 'https://x.invalid\n"; touch /tmp/pwned' });
    assert.match(
      multi.stdout,
      /EXPECT_WEB_URL\s+not an https origin with no path; comparison skipped/,
    );
    assert.match(
      bad.stdout,
      /EXPECT_WEB_URL\s+not an https origin with no path; comparison skipped/,
    );
    assert.doesNotMatch(h.calls().join('\n'), /rm -rf|pwned/);
  } finally {
    h.done();
  }
});

test('EXPECT_WEB_URL may be an internationalised or underscore host, and is still compared', () => {
  const h = healthy({
    env: { ...SLOTS, REKODA_WEB_URL: 'https://bücher_shop.invalid' },
    workerEnv: { ...SLOTS, REKODA_WEB_URL: 'https://bücher_shop.invalid' },
  });
  try {
    const r = h.run2(undefined, {
      EXPECT_SHA: h.sha.slice(0, 7),
      EXPECT_WEB_URL: 'https://bücher_shop.invalid',
    });
    assert.match(r.stdout, /billing link in templates \(api\)\s+EXPECT_WEB_URL\/app\/billing\n/);
    assert.match(r.stdout, /billing link in templates \(worker\)\s+EXPECT_WEB_URL\/app\/billing\n/);
    assert.doesNotMatch(r.stdout, /comparison skipped/);
  } finally {
    h.done();
  }
});

test('an unset required slot is ATTENTION; an unset optional slot is information and keeps RESULT: OK', () => {
  const noRetention = { ...SLOTS };
  delete noRetention.META_RETENTION_TEMPLATE;
  const optional = healthy({
    env: {
      ...noRetention,
      REKODA_CUSTOMER_REMINDERS: '1',
      REKODA_EMAIL_PROVIDER: 'resend',
      PAYSTACK_SECRET_KEY: 'sk_test_qqqqqqqqqqqqqqqq',
    },
    workerEnv: { ...noRetention, REKODA_CUSTOMER_REMINDERS: '1', REKODA_EMAIL_PROVIDER: 'resend' },
  });
  try {
    const r = optional.run2(undefined, { EXPECT_SHA: optional.sha.slice(0, 7) });
    assert.match(
      r.stdout,
      /META_RETENTION_TEMPLATE \(worker\)\s+UNSET \(optional; information only\)\n/,
    );
    assert.ok(!attention(r.stdout).includes('META_RETENTION_TEMPLATE'));
    assert.match(r.stdout, /RESULT: OK/);
    assert.equal(r.status, 0, r.stdout);
  } finally {
    optional.done();
  }

  const noTrial = { ...SLOTS };
  delete noTrial.META_TRIAL_TEMPLATE;
  const required = healthy({
    env: {
      ...noTrial,
      REKODA_CUSTOMER_REMINDERS: '1',
      REKODA_EMAIL_PROVIDER: 'resend',
      PAYSTACK_SECRET_KEY: 'sk_test_qqqqqqqqqqqqqqqq',
    },
    // The worker alone has it: the api's copy still reads ATTENTION.
    workerEnv: { ...SLOTS, REKODA_CUSTOMER_REMINDERS: '1', REKODA_EMAIL_PROVIDER: 'resend' },
  });
  try {
    const r = required.run2(undefined, { EXPECT_SHA: required.sha.slice(0, 7) });
    const a = attention(r.stdout);
    assert.ok(a.includes('META_TRIAL_TEMPLATE (api)'));
    assert.ok(!a.includes('META_TRIAL_TEMPLATE (worker)'));
    assert.match(r.stdout, /RESULT: ATTENTION/);
    assert.equal(r.status, 1);
  } finally {
    required.done();
  }
});

test('a wrong trial language, a non-https or missing REKODA_WEB_URL are ATTENTION in the container that has them', () => {
  const h = healthy({
    workerEnv: {
      ...SLOTS,
      META_TRIAL_TEMPLATE_LOCALE: 'en_US',
      REKODA_WEB_URL: 'http://staging.invalid',
      REKODA_CUSTOMER_REMINDERS: '1',
      REKODA_EMAIL_PROVIDER: 'resend',
    },
  });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    const a = attention(r.stdout);
    assert.ok(a.includes('META_TRIAL_TEMPLATE_LOCALE (worker)'));
    assert.ok(a.includes('billing link in templates (worker)'));
    assert.match(
      r.stdout,
      /billing link in templates \(worker\)\s+REKODA_WEB_URL is not https:\/\/\n/,
    );
    assert.ok(!a.includes('(api)'), a);
    // The non-agreed language value is never printed.
    assert.doesNotMatch(r.stdout, /en_US/);
  } finally {
    h.done();
  }
  const none = healthy({
    workerEnv: {
      ...SLOTS,
      REKODA_WEB_URL: '',
      REKODA_CUSTOMER_REMINDERS: '1',
      REKODA_EMAIL_PROVIDER: 'resend',
    },
  });
  try {
    const out = none.go();
    assert.match(out, /billing link in templates \(worker\)\s+UNSET \(REKODA_WEB_URL/);
  } finally {
    none.done();
  }
});

test('a container that cannot be queried reads unknown for its slots, never UNSET', () => {
  const h = healthy({ failKey: 'META_DOCUMENT_TEMPLATE' });
  try {
    const out = h.go();
    for (const c of ['api', 'worker']) {
      assert.match(
        out,
        new RegExp(`META_DOCUMENT_TEMPLATE \\(${c}\\)\\s+unknown \\(${c} query failed\\)`),
      );
      assert.ok(attention(out).includes(`META_DOCUMENT_TEMPLATE (${c})`));
    }
  } finally {
    h.done();
  }
});
