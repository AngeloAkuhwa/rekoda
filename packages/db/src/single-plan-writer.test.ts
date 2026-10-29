/**
 * One writer for the subscription (G-62).
 *
 * `businesses.plan` and `businesses.plan_expires_at` are the commercial truth
 * every entitlement, allowance and lapse check reads. G-62 was a second writer
 * that skipped the cycle bookkeeping, so the rule is pinned by a sweep over
 * every non-test source file: only `writeSubscriptionState` may assign either
 * column. A second path fails here, whatever it is called.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
/**
 * The permitted write sites, as `file#function`. `expireSubscription` is the
 * deliberate lapse (`plan = 'expired'`); it clears the cycle bookkeeping in the
 * same statement. Anything else, in this file or another, fails the sweep.
 */
const ALLOWED = [
  'packages/db/src/repos/subscriptions.ts#expireSubscription',
  'packages/db/src/repos/subscriptions.ts#writeSubscriptionState',
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.|\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');

/** Split on commas outside (), {}, [] and single-quoted SQL text (a doubled quote stays inside). */
function topLevelSplit(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of text) {
    if (ch === "'") quoted = !quoted;
    else if (!quoted) {
      if ('({['.includes(ch)) depth++;
      else if (')}]'.includes(ch)) depth--;
    }
    if (ch === ',' && depth === 0 && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Index of the first `end` match at bracket depth 0, outside single-quoted text, from `from`; else the end. */
function topLevelEnd(text: string, from: number, end: RegExp): number {
  let depth = 0;
  let quoted = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (depth === 0 && end.test(text.slice(i))) return i;
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
  }
  return text.length;
}

/** Offsets in `code` of every statement assigning the plan or its expiry on `businesses`. */
function planWriteOffsets(code: string): number[] {
  const hits: number[] = [];
  const table = String.raw`(?:ONLY\s+)?(?:"?public"?\.)?"?businesses"?`;
  const alias = String.raw`(?:\s+(?:AS\s+)?(?!SET\b)"?\w+"?)?`;
  const column = String.raw`"?(?:plan|plan_expires_at)"?`;
  const single = new RegExp(String.raw`^\s*(?:\w+\.)?${column}\s*=(?!=)`, 'i');
  const tuple = new RegExp(String.raw`^\s*\([^)]*\b${column}\b[^)]*\)\s*=`, 'i');
  for (const m of code.matchAll(new RegExp(String.raw`UPDATE\s+${table}${alias}\s+SET\s`, 'gi'))) {
    const from = m.index! + m[0].length;
    const stop = topLevelEnd(code, from, /^(WHERE\b|RETURNING\b|FROM\b|`)/i);
    const assigns = topLevelSplit(code.slice(from, stop));
    if (assigns.some((a) => single.test(a) || tuple.test(a))) hits.push(m.index!);
  }
  const upsert = String.raw`INSERT\s+INTO\s+${table}${alias}[^;\x60]*?ON\s+CONFLICT[^;\x60]*?DO\s+UPDATE\s+SET\s`;
  for (const m of code.matchAll(new RegExp(upsert, 'gi'))) {
    const from = m.index! + m[0].length;
    const stop = topLevelEnd(code, from, /^(WHERE\b|RETURNING\b|`)/i);
    const assigns = topLevelSplit(code.slice(from, stop));
    if (assigns.some((a) => single.test(a) || tuple.test(a))) hits.push(m.index!);
  }
  const builders = [
    /\.update\(businesses\)\s*\.set\(\s*\{/g,
    /\.insert\(businesses\)[^;]*?\.onConflictDoUpdate\(\s*\{[^;]*?\bset:\s*\{/g,
  ];
  /* A patch passed as a variable cannot be read here, so it counts as a write. */
  for (const m of code.matchAll(/\.update\(businesses\)\s*\.set\(\s*(?!\{)[\w.]/g))
    hits.push(m.index!);
  for (const re of builders) {
    for (const m of code.matchAll(re)) {
      const from = m.index! + m[0].length;
      const stop = topLevelEnd(code, from, /^\}/);
      const props = topLevelSplit(code.slice(from, stop));
      if (props.some((p) => /^\s*(plan|planExpiresAt)\s*(:|$)/.test(p))) hits.push(m.index!);
    }
  }
  return hits;
}

/**
 * The top-level declaration containing `offset`. Prettier keeps every top-level
 * declaration at column 0, so the nearest preceding unindented `function`,
 * `const` or `class` is the scope; an arrow assigned to a top-level `const` is
 * named by that const, so a second writer cannot hide behind the one before it.
 */
function enclosing(code: string, offset: number): string {
  let name = '<module>';
  const decl =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+)|class\s+(\w+))/gm;
  for (const m of code.matchAll(decl)) {
    if (m.index! > offset) break;
    name = m[1] ?? m[2] ?? m[3] ?? name;
  }
  return name;
}

/** `function` names (or `<module>`) that assign the plan or its expiry in `src`. */
export function planWriters(src: string): string[] {
  const code = strip(src);
  return [...new Set(planWriteOffsets(code).map((o) => enclosing(code, o)))].sort();
}

describe('only the subscription writer assigns the plan and its expiry (G-62)', () => {
  it('detects a write however it is spelled', () => {
    const w = (s: string) => planWriters(s);
    expect(w('function a(){ sql`UPDATE businesses SET plan = ${p} WHERE id = ${i}` }')).toEqual([
      'a',
    ]);
    expect(
      w('function a(){ sql`UPDATE businesses SET updated_at = now(), plan_expires_at = ${d}` }'),
    ).toEqual(['a']);
    expect(w('function a(){ sql`UPDATE public.businesses SET plan = ${p}` }')).toEqual(['a']);
    expect(w('function a(){ sql`UPDATE "businesses" SET plan = ${p}` }')).toEqual(['a']);
    expect(
      w(
        'function a(){ sql`UPDATE businesses SET plan_version_id = (SELECT id FROM plan_versions WHERE id = ${v}), plan = ${p} WHERE id = ${i}` }',
      ),
    ).toEqual(['a']);
    expect(
      w('function a(){ tx.update(businesses).set({ plan: next, updatedAt: new Date() }) }'),
    ).toEqual(['a']);
    expect(w('function a(){ tx.update(businesses).set({ plan }) }')).toEqual(['a']);
    expect(w('function a(){ tx.update(businesses).set(patch) }')).toEqual(['a']);
    expect(
      w(
        "function a(){ sql`INSERT INTO businesses (id) VALUES (${i}) ON CONFLICT (id) DO UPDATE SET name = 'where applicable', plan = EXCLUDED.plan` }",
      ),
    ).toEqual(['a']);
    expect(
      w("function a(){ sql`UPDATE businesses SET note = 'a (b', plan = ${p} WHERE id = ${i}` }"),
    ).toEqual(['a']);
    expect(
      w(
        'function a(){ sql`INSERT INTO businesses (id, plan) VALUES (${i}, ${p}) ON CONFLICT (id) DO UPDATE SET plan = EXCLUDED.plan` }',
      ),
    ).toEqual(['a']);
    expect(
      w(
        'function a(){ tx.insert(businesses).values(v).onConflictDoUpdate({ target: businesses.id, set: { planExpiresAt: d } }) }',
      ),
    ).toEqual(['a']);
    expect(
      w('function a(){ sql`UPDATE businesses AS b SET plan = ${p} WHERE b.id = ${i}` }'),
    ).toEqual(['a']);
    expect(w('function a(){ sql`UPDATE businesses b SET plan_expires_at = ${d}` }')).toEqual(['a']);
    expect(
      w('function a(){ sql`UPDATE businesses SET (plan, plan_expires_at) = (${p}, ${d})` }'),
    ).toEqual(['a']);
    expect(w('function a(){ tx.update(businesses).set({ updatedAt, planExpiresAt }) }')).toEqual([
      'a',
    ]);
  });

  it('ignores what is not a plan assignment', () => {
    const w = (s: string) => planWriters(s);
    expect(w('function a(){ tx.update(businesses).set({ name: next.name }) }')).toEqual([]);
    expect(
      w(
        'function a(){ sql`INSERT INTO businesses (id, plan) VALUES (${i}, ${p}) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name` }',
      ),
    ).toEqual([]);
    expect(
      w('function a(){ sql`UPDATE businesses SET pending_plan = ${p} WHERE plan = ${q}` }'),
    ).toEqual([]);
    expect(
      w(
        'function a(){ sql`UPDATE businesses SET plan_version_id = (SELECT id FROM t WHERE plan = ${q}) WHERE id = ${i}` }',
      ),
    ).toEqual([]);
    expect(w('// UPDATE businesses SET plan = 1\nconst x = 1;')).toEqual([]);
  });

  it('attributes an arrow-function writer to itself, not to the function before it', () => {
    const src =
      'export async function writeSubscriptionState(){ sql`UPDATE businesses SET plan = ${p}` }\n' +
      'export const rogue = async () => {\n  await tx.update(businesses).set({ plan });\n};';
    expect(planWriters(src)).toEqual(['rogue', 'writeSubscriptionState']);
  });

  it('does not let a plain insert in one function claim a later upsert in another', () => {
    const sql = 'function good(){ sql`INSERT INTO businesses (id) VALUES (${i})` }\n';
    expect(
      planWriters(
        sql +
          'function rogue(){ sql`INSERT INTO businesses (id) VALUES (${i}) ON CONFLICT (id) DO UPDATE SET plan = ${p}` }',
      ),
    ).toEqual(['rogue']);
    expect(
      planWriters(
        'function good(){ tx.insert(businesses).values(v); }\n' +
          'function rogue(){ tx.insert(businesses).values(v).onConflictDoUpdate({ target: businesses.id, set: { plan } }); }',
      ),
    ).toEqual(['rogue']);
  });

  it('names the function that wrote, so a second writer in the same file is caught', () => {
    const src =
      'function good(){ sql`UPDATE businesses SET plan = ${p}` }\n' +
      'function rogue(){ sql`UPDATE businesses SET plan_expires_at = ${d}` }';
    expect(planWriters(src)).toEqual(['good', 'rogue']);
  });

  it('finds the plan assigned only by the permitted writers', () => {
    const writers = ['packages', 'apps']
      .flatMap((top) => sources(join(root, top)))
      .flatMap((file) =>
        planWriters(readFileSync(file, 'utf8')).map((fn) => `${relative(root, file)}#${fn}`),
      )
      .sort();
    expect(writers).toEqual(ALLOWED);
  });
});
