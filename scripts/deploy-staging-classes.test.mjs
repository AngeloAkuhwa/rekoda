/**
 * E-F8 (final closeout review of PR #432): every migration after main's 0192 is classified, once, as
 * compatibility-breaking (the deploy stops the api, worker, operator and settlement before applying
 * it, and never restarts the previous release against it) or additive (applied with everything
 * running). Until now a new migration missing from COMPAT_BREAKING_MIGRATIONS was silently treated as
 * additive. Run with `node --test scripts/deploy-staging-classes.test.mjs` (CI does).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(join(ROOT, 'scripts/deploy-staging.sh'), 'utf8');
const list = (name) => {
  const m = new RegExp(`^${name}='([^']*)'$`, 'm').exec(script);
  assert.ok(m, `${name} is not a single-quoted list in deploy-staging.sh`);
  return m[1].split(/\s+/).filter(Boolean);
};
const migrations = readdirSync(join(ROOT, 'packages/db/migrations'))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f.slice(0, 4) >= '0193')
  .map((f) => f.slice(0, -4))
  .sort();

test('every migration after 0192 is classified breaking or additive, exactly once', () => {
  const breaking = list('COMPAT_BREAKING_MIGRATIONS');
  const additive = list('ADDITIVE_MIGRATIONS');
  assert.ok(migrations.length >= 50, `expected PR B's migrations, found ${migrations.length}`);
  for (const tag of migrations) {
    const inBreaking = breaking.includes(tag);
    const inAdditive = additive.includes(tag);
    assert.ok(
      inBreaking !== inAdditive,
      `${tag} must be in exactly one of COMPAT_BREAKING_MIGRATIONS and ADDITIVE_MIGRATIONS (breaking: ${inBreaking}, additive: ${inAdditive})`,
    );
  }
  for (const tag of [...breaking, ...additive]) {
    assert.ok(migrations.includes(tag), `${tag} is listed but no such migration exists`);
  }
  assert.equal(new Set(breaking).size, breaking.length, 'a breaking migration is listed twice');
  assert.equal(new Set(additive).size, additive.length, 'an additive migration is listed twice');
});

test('the breaking set is the one the reviews classified; additions to it are deliberate', () => {
  assert.deepEqual(list('COMPAT_BREAKING_MIGRATIONS'), [
    '0196_plan_fields_guard',
    '0200_plan_writer_boundary',
    '0202_settlement_and_operator_principals',
    '0203_plan_duration_rules',
    '0204_external_events_worker_least_privilege',
    '0205_charge_terms_belong_to_settlement',
    '0206_paid_charge_bound_to_its_cycle',
    '0207_operator_standard_periods',
    '0209_settlement_verifies_the_price',
    '0210_worker_least_privilege',
    '0211_operator_principal_least_privilege',
    '0212_closeout_review_fixes',
    '0216_usage_meter_boundary',
    '0217_settlement_isolation',
    '0218_usage_reservation_closure',
    '0220_job_row_and_grace_review_fixes',
    '0221_operator_writes_only_through_its_functions',
    '0228_worker_reads_no_payload_across_tenants',
    '0230_refund_through_the_operator',
    '0235_refund_records_and_pack_eligibility',
  ]);
});
