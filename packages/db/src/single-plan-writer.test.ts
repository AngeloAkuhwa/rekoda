/**
 * One writer for the subscription (G-62).
 *
 * `businesses.plan` and `businesses.plan_expires_at` are the commercial truth
 * every entitlement, allowance and lapse check reads. G-62 was a second writer
 * that skipped the cycle bookkeeping, so the rule is pinned by a sweep over
 * every non-test source file: only the sites in `ALLOWED` may assign either
 * column (`writeSubscriptionState` for every change, `expireSubscription` for
 * the lapse, and the insert that starts a new business's trial). A second path
 * fails here, whatever it is called.
 *
 * This is a tripwire over source text, not a proof: it reads the Drizzle table
 * under its schema name `businesses` and raw SQL, and cannot follow a table
 * imported under another name or a statement assembled from fragments. Those
 * need review, and the database role grants remain the hard boundary.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
/**
 * The permitted write sites, as `file#function`. `expireSubscription` is the
 * deliberate lapse (`plan = 'expired'`); it clears the cycle bookkeeping in the
 * same statement. `createBusinessWithOwner` starts the 14-day trial: it inserts
 * the new row with its first plan and expiry and nothing else ever does.
 * Anything else, in these files or another, fails the sweep.
 */
const ALLOWED = [
  'packages/db/src/repos/identity.ts#createBusinessWithOwner',
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
    /* A keyword only ends the clause at a word boundary (not inside `effective_from`). */
    const insideWord = /\w/.test(ch) && /\w/.test(text[i - 1] ?? ' ');
    if (depth === 0 && !insideWord && end.test(text.slice(i))) return i;
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
  }
  return text.length;
}

/**
 * Replace every `${...}` interpolation with `$1`, so an apostrophe, bracket or
 * semicolon inside a TypeScript expression cannot be mistaken for SQL text. The
 * Drizzle table `${businesses}` stays readable as the table name.
 */
function maskInterpolations(code: string): string {
  let out = '';
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '$' && code[i + 1] === '{') {
      let depth = 1;
      let k = i + 2;
      while (k < code.length && depth > 0) {
        if (code[k] === '{') depth++;
        else if (code[k] === '}') depth--;
        k++;
      }
      out += code.slice(i + 2, k - 1).trim() === 'businesses' ? 'businesses' : '$1';
      i = k - 1;
    } else out += code[i];
  }
  return out;
}

/** End of the SQL statement starting at `from`: a `;` or the closing backtick outside single quotes. */
function statementEnd(code: string, from: number): number {
  let quoted = false;
  for (let i = from; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "'") quoted = !quoted;
    else if (!quoted && (ch === ';' || ch === '`')) return i;
  }
  return code.length;
}

/** End of a builder chain: the first `;` outside a quoted argument. */
function chainEnd(code: string, from: number): number {
  let quote = '';
  for (let i = from; i < code.length; i++) {
    const ch = code[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ';') return i;
  }
  return code.length;
}

/** Offsets in `code` (interpolations already masked) of every statement assigning the plan or its expiry on `businesses`. */
function planWriteOffsets(code: string): number[] {
  const hits: number[] = [];
  const table = String.raw`(?:ONLY\s+)?(?:"?public"?\.)?"?businesses"?`;
  const alias = String.raw`(?:\s+(?:AS\s+)?(?!(?:SET|VALUES|SELECT|DEFAULT|OVERRIDING|WITH|TABLE)\b)"?\w+"?)?`;
  const column = String.raw`"?(?:plan|plan_expires_at)"?`;
  const single = new RegExp(String.raw`^\s*(?:\w+\.)?${column}\s*=(?!=)`, 'i');
  const tuple = new RegExp(String.raw`^\s*\([^)]*\b${column}\b[^)]*\)\s*=`, 'i');
  const assignsPlan = (text: string, from: number) =>
    topLevelSplit(
      text.slice(from, topLevelEnd(text, from, /^(WHERE\b|RETURNING\b|FROM\b|`)/i)),
    ).some((a) => single.test(a) || tuple.test(a) || /^\s*\$1\s*$/.test(a));

  for (const m of code.matchAll(new RegExp(String.raw`UPDATE\s+${table}${alias}\s+SET\s`, 'gi'))) {
    if (assignsPlan(code, m.index! + m[0].length)) hits.push(m.index!);
  }
  for (const m of code.matchAll(new RegExp(String.raw`INSERT\s+INTO\s+${table}\b`, 'gi'))) {
    const end = statementEnd(code, m.index!);
    const stmt = code.slice(m.index!, end);
    const set = /\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\s+SET\s/i.exec(stmt);
    if (set && assignsPlan(stmt, set.index + set[0].length)) hits.push(m.index!);
    /* A plain insert naming the column: INSERT INTO businesses [AS b] (..., plan, ...) */
    const cols = new RegExp(String.raw`^INSERT\s+INTO\s+${table}${alias}\s*\(([^)]*)\)`, 'i').exec(
      stmt,
    );
    if (cols && new RegExp(String.raw`(^|,)\s*${column}\s*(,|$)`, 'i').test(cols[1]!)) {
      hits.push(m.index!);
    }
    /* No column list (INSERT ... VALUES / SELECT): the target columns are unknown. */
    if (!cols) hits.push(m.index!);
  }
  /* MERGE has several actions (matched update, not-matched insert); no code
   * uses it on `businesses`, so any use counts as a write and needs review. */
  for (const m of code.matchAll(new RegExp(String.raw`MERGE\s+INTO\s+${table}\b`, 'gi'))) {
    hits.push(m.index!);
  }

  /* A query-builder object is read property by property; anything else (a
   * patch variable) cannot be read here, so it counts as a write. */
  const writes = (text: string, from: number): boolean => {
    if (text[from] !== '{') return true;
    const props = topLevelSplit(text.slice(from + 1, topLevelEnd(text, from + 1, /^\}/)));
    return props.some((p) =>
      /^\s*(?:(?:plan|planExpiresAt)\s*(?::|$)|['"](?:plan|planExpiresAt)['"]\s*:|\[|\.\.\.)/.test(
        p,
      ),
    );
  };
  for (const m of code.matchAll(/\.update\(businesses\)\s*\.set\(\s*/g)) {
    if (writes(code, m.index! + m[0].length)) hits.push(m.index!);
  }
  for (const m of code.matchAll(/\.insert\(businesses\)\s*\.values\(\s*/g)) {
    if (writes(code, m.index! + m[0].length)) hits.push(m.index!);
  }
  for (const m of code.matchAll(/\.insert\(businesses\)/g)) {
    const chain = code.slice(m.index!, chainEnd(code, m.index!));
    const conflict = /\.onConflictDoUpdate\(\s*/.exec(chain);
    if (!conflict) continue;
    const at = conflict.index + conflict[0].length;
    /* A config passed as a variable cannot be read, so it counts as a write. */
    if (chain[at] !== '{') hits.push(m.index!);
    else {
      const set = /\bset:\s*/.exec(chain.slice(at));
      /* No literal `set:` (shorthand `set`, or none) cannot be read: count it. */
      if (!set || writes(chain, at + set.index + set[0].length)) hits.push(m.index!);
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
  /* Offsets and scopes are both read from the masked text, so they agree. */
  const code = maskInterpolations(strip(src));
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
        'function a(){ sql`INSERT INTO businesses (id, name) VALUES (${i}, ${n}) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name` }',
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

  it('does not stop a SET clause at a keyword inside an identifier', () => {
    expect(
      planWriters('function a(){ sql`UPDATE businesses SET effective_from = ${d}, plan = ${p}` }'),
    ).toEqual(['a']);
  });

  it('counts a SET clause or object built at run time as a write', () => {
    expect(
      planWriters(
        'function a(){ sql`UPDATE businesses SET ${sql.join(parts, sql`, `)} WHERE id = ${i}` }',
      ),
    ).toEqual(['a']);
    expect(
      planWriters('function a(){ tx.update(businesses).set({ ...patch, updatedAt }) }'),
    ).toEqual(['a']);
    expect(planWriters('function a(){ tx.insert(businesses).values({ ...row }) }')).toEqual(['a']);
  });

  it('reads unspaced shorthand, quoted and computed keys, config variables, MERGE and column lists', () => {
    const w = (src: string) => planWriters(src);
    expect(w('function a(){ tx.update(businesses).set({plan}) }')).toEqual(['a']);
    expect(w("function a(){ tx.update(businesses).set({ 'plan': next }) }")).toEqual(['a']);
    expect(w('function a(){ tx.update(businesses).set({ [col]: next }) }')).toEqual(['a']);
    expect(
      w(
        'function a(){ tx.insert(businesses).values({ name }).onConflictDoUpdate(conflictConfig) }',
      ),
    ).toEqual(['a']);
    expect(
      w(
        'function a(){ sql`MERGE INTO businesses b USING t ON b.id = t.id WHEN MATCHED THEN UPDATE SET plan = t.plan` }',
      ),
    ).toEqual(['a']);
    expect(
      w('function a(){ sql`INSERT INTO businesses AS b (id, plan) VALUES (${i}, ${p})` }'),
    ).toEqual(['a']);
    expect(w('function a(){ sql`INSERT INTO businesses (id, name) VALUES (${i}, ${n})` }')).toEqual(
      [],
    );
  });

  it('counts MERGE, columnless inserts and unreadable conflict sets as writes', () => {
    const w = (src: string) => planWriters(src);
    expect(
      w(
        'function a(){ sql`MERGE INTO businesses b USING t ON b.id = t.id WHEN NOT MATCHED THEN INSERT (plan) VALUES (t.plan)` }',
      ),
    ).toEqual(['a']);
    expect(w('function a(){ sql`INSERT INTO businesses VALUES (${i}, ${p})` }')).toEqual(['a']);
    expect(w('function a(){ sql`INSERT INTO businesses SELECT * FROM staged` }')).toEqual(['a']);
    expect(
      w(
        'function a(){ tx.insert(businesses).values({ name }).onConflictDoUpdate({ target: businesses.id, set }) }',
      ),
    ).toEqual(['a']);
    expect(
      w(
        'function a(){ tx.insert(businesses).values({ name }).onConflictDoUpdate({ target: businesses.id, set: { name } }) }',
      ),
    ).toEqual([]);
  });

  it('keeps a semicolon inside a quoted builder argument within the chain', () => {
    expect(
      planWriters(
        "function a(){ tx.insert(businesses).values({ name: 'a; b' }).onConflictDoUpdate({ target: businesses.id, set: { plan } }) }",
      ),
    ).toEqual(['a']);
  });

  it('reads interpolated table names and ignores apostrophes inside interpolations', () => {
    expect(planWriters('function a(){ sql`UPDATE ${businesses} SET plan = ${p}` }')).toEqual(['a']);
    expect(
      planWriters(
        'function a(){ sql`INSERT INTO businesses (name) VALUES (${b.name ?? "owner\'s shop"}) ON CONFLICT (id) DO UPDATE SET plan = ${p}` }',
      ),
    ).toEqual(['a']);
  });

  it('sees inserts that set the plan and upserts through a variable', () => {
    expect(
      planWriters('function a(){ tx.insert(businesses).values({ name, planExpiresAt: d }) }'),
    ).toEqual(['a']);
    expect(planWriters('function a(){ tx.insert(businesses).values(row) }')).toEqual(['a']);
    expect(planWriters('function a(){ tx.insert(businesses).values({ name }) }')).toEqual([]);
    expect(
      planWriters(
        'function a(){ tx.insert(businesses).values({ name }).onConflictDoUpdate({ target: businesses.id, set: patch }) }',
      ),
    ).toEqual(['a']);
  });

  it('scans a plain insert with many doubled apostrophes in linear time', () => {
    const src =
      "function a(){ sql`INSERT INTO businesses (note) VALUES ('" + "it''s ".repeat(5000) + "')` }";
    const started = Date.now();
    expect(planWriters(src)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps a semicolon inside a quoted SQL string within the upsert match', () => {
    expect(
      planWriters(
        "function a(){ sql`INSERT INTO businesses (id, note) VALUES (${i}, 'a; b') ON CONFLICT (id) DO UPDATE SET plan = ${p}` }",
      ),
    ).toEqual(['a']);
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
        'function good(){ tx.insert(businesses).values({ name }); }\n' +
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
