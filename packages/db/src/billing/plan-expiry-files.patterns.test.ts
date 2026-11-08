/**
 * Self-tests of the G-62 / OD-37 plan-expiry checker's assignment patterns (split out of
 * plan-expiry-files.test.ts, which keeps the reviewed lists and the repository checks).
 */
import { describe, expect, it } from 'vitest';
import {
  checkAssignmentPins,
  checkPlanExpiryFiles,
  countAssignments,
  isTestFile,
  type Entry,
  type Pin,
  type ScannedFile,
} from './plan-expiry-files.checker.js';

describe('assignment patterns stay linear on large files', () => {
  it('scans a 300 KB file with many block comments in well under a second', () => {
    // Consecutive block comments after a comma: with a lazy comment pattern this hung (50 repeats never finished).
    const chunk = ', /* a */ /* b */ /* c */ /* d */ z;\n';
    const text = chunk.repeat(6_000);
    const started = Date.now();
    const got = countAssignments(text);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(got.plan).toBe(0);
  });
});

describe('builder assignments and comment patterns (review of 073f828)', () => {
  const hit = (text: string) => countAssignments(text).plan;

  it('catches shorthand, spread, quoted and nested-object forms of a plan assignment', () => {
    expect(hit('tx.update(b).set({ updatedAt: d, plan })')).toBe(1);
    expect(hit('tx.update(b).set({ ...rest, plan })')).toBe(1);
    expect(hit('tx.update(b).set({ "plan": x })')).toBe(1);
    expect(hit('tx.update(b).set({ meta: { a: 1 }, plan: x })')).toBe(1);
    expect(hit('tx.update(b).set({ u: sql`${a}`, plan: x })')).toBe(1);
  });

  it('does not read pending_plan, plan_decided_at or a later statement as a plan assignment', () => {
    expect(hit('tx.update(b).set({ pendingPlan: x, planDecidedAt: d })')).toBe(0);
    expect(hit('tx.update(b).set({ a: 1 });\nfoo(plan, y);')).toBe(0);
    expect(hit('tx.update(b).set({ a: obj.plan })')).toBe(0);
  });

  it('stays linear on adjacent block comments in a builder call and on many later comments', () => {
    const adjacent = `x.set({ ${'/* a */ '.repeat(60)}y: 1 }); plan_expires_at`;
    const many = `${'.set({ /* note */ y: 1 });\n'.repeat(300)}${'/* z */\n'.repeat(300)}`;
    const started = Date.now();
    const reader: ScannedFile = { path: 'src/r.ts', text: adjacent };
    const allowed = { 'src/r.ts': { role: 'reader' as const, why: 'reads the date for display' } };
    checkPlanExpiryFiles([reader], allowed);
    checkPlanExpiryFiles([{ path: 'src/r.ts', text: `${many}plan_expires_at` }], allowed);
    countAssignments(adjacent + many);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('shared assignment patterns (review of 073f828)', () => {
  const counts = (text: string) => countAssignments(text);

  it('sees SQL comments between the column and the equals sign, for both columns', () => {
    expect(counts('UPDATE businesses SET plan /* why */ = $1').plan).toBe(1);
    expect(counts('UPDATE businesses SET plan_expires_at -- why\n = $1').expiry).toBe(1);
  });

  it('sees quoted, shorthand and commented keys for both columns', () => {
    expect(counts("tx.update(b).set({ 'plan_expires_at': x })").expiry).toBe(1);
    expect(counts('tx.update(b).set({ plan_expires_at })').expiry).toBe(1);
    expect(counts('tx.update(b).set({ /* why */ plan_expires_at: x })').expiry).toBe(1);
    expect(counts('tx.update(b).set({ /* why */ plan: x })').plan).toBe(1);
  });

  it('does not read a VALUE named plan or plan_expires_at as a key', () => {
    expect(counts('tx.update(b).set({ x: plan })')).toMatchObject({ plan: 0 });
    expect(counts('tx.update(b).set({ x: plan, y: z })')).toMatchObject({ plan: 0 });
    expect(counts('tx.update(b).set({ x: plan_expires_at })')).toMatchObject({ expiry: 0 });
  });
});

describe('long builder objects and qualified table names (review of 81f18b1)', () => {
  it('sees a plan key after a long run of other keys in one .set() object', () => {
    const others = Array.from({ length: 60 }, (_, i) => `field${i}: value${i}`).join(', ');
    expect(others.length).toBeGreaterThan(400);
    expect(countAssignments(`tx.update(b).set({ ${others}, plan: x })`).plan).toBe(1);
  });

  it('counts a businesses insert or update through a qualified table name', () => {
    const idPins = { 'src/id.ts': { plan: 0, expiry: 0, businessInserts: 1, why: 'trial insert' } };
    const two = {
      path: 'src/id.ts',
      text: 'tx.insert(businesses).values(x); tx.insert(schema.businesses).values(y)',
    };
    expect(checkAssignmentPins([two], idPins).join('\n')).toContain('inserts into businesses 2');
    const allowed = { 'src/r.ts': { role: 'reader' as const, why: 'reads the date for display' } };
    const reader = {
      path: 'src/r.ts',
      text: 'row.planExpiresAt; tx.update(schema.businesses).set(x)',
    };
    expect(checkPlanExpiryFiles([reader], allowed).join('\n')).toContain(
      'writes the businesses table',
    );
  });
});

describe('arrow functions are not assignments (review of 92d55de)', () => {
  it('does not count `plan => ...` or `(plan_expires_at) => ...` after a comma', () => {
    expect(countAssignments('run(x, plan => y)').plan).toBe(0);
    expect(countAssignments('run(x, (plan) => y)').plan).toBe(0);
    expect(countAssignments('run(x, (plan_expires_at) => y)').expiry).toBe(0);
    expect(countAssignments('UPDATE businesses SET plan = $1').plan).toBe(1);
  });
});

describe('multi-dot test file names (review of 550bd19)', () => {
  it('treats foo.test.d.ts and foo.spec.d.ts as test files, not product source', () => {
    expect(isTestFile('src/a.test.d.ts')).toBe(true);
    expect(isTestFile('src/a.spec.d.ts')).toBe(true);
    expect(isTestFile('src/a.ts')).toBe(false);
    expect(isTestFile('src/contest.d.ts')).toBe(false);
  });
});

describe('plan written by a businesses insert (review of e00c46b)', () => {
  it('counts a SQL or builder insert into businesses that names plan', () => {
    expect(countAssignments('INSERT INTO businesses (name, plan) VALUES ($1, $2)').plan).toBe(1);
    expect(countAssignments("tx.insert(businesses).values({ name: n, plan: 'chat' })").plan).toBe(
      1,
    );
    expect(countAssignments('tx.insert(schema.businesses).values({ plan })').plan).toBe(1);
  });

  it('does not count an insert that leaves plan to the column default, or names pending_plan', () => {
    expect(
      countAssignments('INSERT INTO businesses (name, owner_user_id) VALUES ($1, $2)').plan,
    ).toBe(0);
    expect(countAssignments('tx.insert(businesses).values({ id, name, planExpiresAt })').plan).toBe(
      0,
    );
    expect(countAssignments('INSERT INTO businesses (pending_plan) VALUES ($1)').plan).toBe(0);
  });
});

describe('quoted schema-qualified businesses inserts (review of 248402c)', () => {
  it('counts plan in INSERT INTO "public"."businesses", and an unpinned file with it fails', () => {
    const text = 'INSERT INTO "public"."businesses" ("plan") VALUES ($1)';
    expect(countAssignments(text).plan).toBe(1);
    expect(countAssignments('INSERT INTO public . businesses (plan) VALUES ($1)').plan).toBe(1);
    expect(checkAssignmentPins([{ path: 'src/unpinned.ts', text }], {}).join('\n')).toContain(
      'src/unpinned.ts',
    );
  });

  it('counts the same quoted and spaced table forms as businesses inserts for the insert pin', () => {
    expect(countAssignments('INSERT INTO "public"."businesses" (name) VALUES ($1)').inserts).toBe(
      1,
    );
    expect(countAssignments('INSERT INTO public . businesses (name) VALUES ($1)').inserts).toBe(1);
    expect(countAssignments('INSERT INTO "businesses" (name) VALUES ($1)').inserts).toBe(1);
    expect(countAssignments('INSERT INTO businesses_archive (name) VALUES ($1)').inserts).toBe(0);
  });
});

describe('array-form builder inserts (review of a1eeef8)', () => {
  it('counts plan named in any row of an array insert, and still counts the object form', () => {
    expect(countAssignments("tx.insert(businesses).values([{ plan: 'chat' }])").plan).toBe(1);
    expect(
      countAssignments("tx.insert(businesses).values([{ name: a }, { name: b, plan: 'chat' }])")
        .plan,
    ).toBe(1);
    expect(countAssignments('tx.insert(businesses).values([{ name: a }, { plan }])').plan).toBe(1);
    expect(countAssignments("tx.insert(businesses).values({ plan: 'chat' })").plan).toBe(1);
    expect(countAssignments('tx.insert(businesses).values([{ name: a }, { name: b }])').plan).toBe(
      0,
    );
  });

  it('counts plan when a comment sits before the array or its first row', () => {
    expect(
      countAssignments("tx.insert(businesses).values([/* trial row */ { plan: 'chat' }])").plan,
    ).toBe(1);
    expect(
      countAssignments(
        "tx.insert(businesses).values(/* rows */ [\n  // first\n  { plan: 'chat' }])",
      ).plan,
    ).toBe(1);
    expect(countAssignments("tx.insert(businesses).values(/* row */ { plan: 'chat' })").plan).toBe(
      1,
    );
  });
});
