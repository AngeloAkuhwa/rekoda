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
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url).pathname;
const ALLOWED = ['packages/db/src/repos/subscriptions.ts'];

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

/** True when the source assigns the plan or its expiry on `businesses`. */
export function writesPlan(src: string): boolean {
  const code = strip(src);
  const raw = [...code.matchAll(/UPDATE\s+businesses\b[\s\S]*?`/gi)].some((m) =>
    /(^|[\s,])(plan|plan_expires_at)\s*=(?!=)/i.test(m[0].replace(/\bWHERE\b[\s\S]*$/i, '')),
  );
  const builder = [...code.matchAll(/\.update\(businesses\)\s*\.set\(\{[\s\S]*?\}\)/g)].some((m) =>
    /\b(plan|planExpiresAt)\s*:/.test(m[0]),
  );
  return raw || builder;
}

describe('only one writer assigns the plan and its expiry (G-62)', () => {
  it('detects a second writer, in raw SQL and in the query builder', () => {
    expect(
      writesPlan('await tx.execute(sql`UPDATE businesses SET plan = ${p} WHERE id = ${i}`)'),
    ).toBe(true);
    expect(
      writesPlan('sql`UPDATE businesses SET updated_at = now(), plan_expires_at = ${d}`'),
    ).toBe(true);
    expect(writesPlan('tx.update(businesses).set({ plan: next, updatedAt: new Date() })')).toBe(
      true,
    );
    expect(writesPlan('tx.update(businesses).set({ name: next.name })')).toBe(false);
    expect(writesPlan('sql`UPDATE businesses SET pending_plan = ${p} WHERE plan = ${q}`')).toBe(
      false,
    );
    expect(writesPlan('// UPDATE businesses SET plan = 1\nconst x = 1;')).toBe(false);
  });

  it('finds the plan assigned in exactly one place: the subscription writer', () => {
    const writers = ['packages', 'apps']
      .flatMap((top) => sources(join(root, top)))
      .filter((file) => writesPlan(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(writers).toEqual(ALLOWED);
  });
});
