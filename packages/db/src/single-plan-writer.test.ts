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

/** Split on commas that are not inside (), {} or []. */
function topLevelSplit(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Index of the first `needle` match at bracket depth 0 from `from`, else the end. */
function topLevelEnd(text: string, from: number, end: RegExp): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (depth === 0 && end.test(text.slice(i))) return i;
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
  }
  return text.length;
}

/** Offsets in `code` of every statement assigning the plan or its expiry on `businesses`. */
function planWriteOffsets(code: string): number[] {
  const hits: number[] = [];
  const table = String.raw`(?:"?public"?\.)?"?businesses"?`;
  for (const m of code.matchAll(new RegExp(String.raw`UPDATE\s+${table}\s+SET\s`, 'gi'))) {
    const from = m.index! + m[0].length;
    const stop = topLevelEnd(code, from, /^(WHERE\b|RETURNING\b|FROM\b|`)/i);
    const assigns = topLevelSplit(code.slice(from, stop));
    if (assigns.some((a) => /^\s*"?(plan|plan_expires_at)"?\s*=(?!=)/i.test(a))) {
      hits.push(m.index!);
    }
  }
  for (const m of code.matchAll(/\.update\(businesses\)\s*\.set\(\s*\{/g)) {
    const from = m.index! + m[0].length;
    const stop = topLevelEnd(code, from, /^\}/);
    const props = topLevelSplit(code.slice(from, stop));
    if (props.some((p) => /^\s*(plan|planExpiresAt)\s*(:|$)/.test(p))) hits.push(m.index!);
  }
  return hits;
}

/** Name of the function enclosing `offset`: the nearest declaration before it. */
function enclosing(code: string, offset: number): string {
  let name = '<module>';
  for (const m of code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)) {
    if (m.index! > offset) break;
    name = m[1]!;
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
    expect(w('function a(){ tx.update(businesses).set({ updatedAt, planExpiresAt }) }')).toEqual([
      'a',
    ]);
  });

  it('ignores what is not a plan assignment', () => {
    const w = (s: string) => planWriters(s);
    expect(w('function a(){ tx.update(businesses).set({ name: next.name }) }')).toEqual([]);
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
