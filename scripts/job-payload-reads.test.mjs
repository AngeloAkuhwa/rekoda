import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { jobPayloadReadViolations } from './lib/job-payload-reads.mjs';

const REL = 'packages/db/src/repos/jobs.ts';

/* The enrolment as it was before the final review of PR #432: one unpinned cross-tenant read. */
const BEFORE = `
export async function enrolUnrecordedDeaths(db: Db, limit = 100): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<DyingRow>(sql\`
      SELECT j.id, j.business_id, j.kind, j.payload, j.attempts, j.state, j.failure_category
      FROM jobs j
      WHERE j.state = 'dead' AND j.kind IN ('payment.process', 'billing.process')
      LIMIT \${limit}
      FOR UPDATE OF j SKIP LOCKED
    \`);
    return rows.length;
  });
}
`;

test('flags the original unpinned enrolment read', () => {
  const found = jobPayloadReadViolations(REL, BEFORE);
  assert.equal(found.length, 1);
  assert.equal(found[0].spec, 'enrolUnrecordedDeaths');
  assert.equal(found[0].rule.name, 'cross-tenant job payload read');
});

test('flags a cross-tenant RETURNING of the payload', () => {
  const body = `
export async function reclaimStalled(db: Db): Promise<number> {
  await db.execute(sql\`UPDATE jobs SET state = 'pending' WHERE state = 'running'
    RETURNING id, business_id, payload\`);
}`;
  assert.equal(jobPayloadReadViolations(REL, body).length, 1);
});

test('accepts a read bounded to the pinned tenant, and the claim', () => {
  const pinned = `
export async function enrolDeath(db: Db, jobId: string, businessId: string) {
  return withBusiness(db, businessId, (tx) => tx.execute(sql\`
    SELECT j.payload FROM jobs j
    WHERE j.id = \${jobId}::uuid
      AND j.business_id = nullif(current_setting('app.business_id', true), '')::uuid\`));
}
export async function claimNext(db: Db) {
  return db.execute(sql\`UPDATE jobs SET state = 'running' RETURNING id, payload\`);
}`;
  assert.deepEqual(jobPayloadReadViolations(REL, pinned), []);
});

test('accepts a read in a TenantDb function that names its business; not on an unpinned Db', () => {
  const tenant = (param) => `
export async function reconcileDeadReceipts(${param}, businessId: string) {
  return tx.execute(sql\`SELECT j.payload->>'eventId' FROM jobs j
    WHERE j.business_id = \${businessId}::uuid\`);
}`;
  assert.deepEqual(jobPayloadReadViolations(REL, tenant('tx: TenantDb')), []);
  assert.equal(jobPayloadReadViolations(REL, tenant('tx: Db')).length, 1);
});

test('a comment that names the payload is not a read; other directories are out of scope', () => {
  const commented = `
export async function reclaimStalled(db: Db) {
  await db.execute(sql\`UPDATE jobs SET state = 'pending'
    -- what a job carries (its payload) is read later, pinned
    RETURNING id\`);
}`;
  assert.deepEqual(jobPayloadReadViolations(REL, commented), []);
  assert.deepEqual(jobPayloadReadViolations('apps/api/src/x.ts', BEFORE), []);
});

test('the repository as it stands has no violation, and the boundary check runs the rule', () => {
  for (const file of [
    'jobs.ts',
    'dead-jobs.ts',
    'outbox.ts',
    'events.ts',
    'conversations.ts',
    'reminders.ts',
  ]) {
    const rel = `packages/db/src/repos/${file}`;
    assert.deepEqual(jobPayloadReadViolations(rel, readFileSync(rel, 'utf8')), [], rel);
  }
  const out = execFileSync('node', ['scripts/check-boundaries.mjs'], { encoding: 'utf8' });
  assert.match(out, /Boundaries OK/);
  assert.match(
    readFileSync('scripts/check-boundaries.mjs', 'utf8'),
    /jobPayloadReadViolations\(rel, body\)/,
  );
});

test('catches the ways round a name match: *, to_jsonb, an arrow function, a block comment', () => {
  const cases = {
    star: `
export async function reclaimAll(db: Db) {
  return db.execute(sql\`UPDATE jobs SET state = 'pending' RETURNING *\`);
}`,
    alias: `
export async function listDead(db: Db) {
  return db.execute(sql\`SELECT j.* FROM jobs j WHERE j.state = 'dead'\`);
}`,
    jsonb: `
export async function dumpDead(db: Db) {
  return db.execute(sql\`SELECT to_jsonb(j) FROM jobs j\`);
}`,
    arrow: `
export async function claimNext(db: Db) {
  return db.execute(sql\`UPDATE jobs SET state = 'running' RETURNING id, payload\`);
}
export const sneaky = async (db: Db) =>
  db.execute(sql\`SELECT payload FROM jobs\`);`,
    comment: `
export async function hidden(db: Db) {
  return db.execute(sql\`SELECT payload FROM jobs
    /* business_id = nullif(current_setting('app.business_id', true), '')::uuid */\`);
}`,
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.equal(jobPayloadReadViolations(REL, body).length, 1, name);
  }
});
