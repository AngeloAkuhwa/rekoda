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

/** Runnable TypeScript or JavaScript source: not a test, not a declaration file. */
export function isSwept(name: string): boolean {
  return (
    /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(name) && !/\.(test|spec)\.|\.d\.(m|c)?ts$/.test(name)
  );
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (isSwept(name)) out.push(path);
  }
  return out;
}

/**
 * End (exclusive) of the quoted span starting at `i`, or -1 when `text[i]` does
 * not open one. Covers SQL/JS single and double quotes, PostgreSQL dollar
 * quotes with or without a tag (`$$..$$`, `$body$..$body$`) and, when `js` is
 * set, JavaScript template literals. An unterminated span runs to the end.
 */
function quotedEnd(text: string, i: number, js = false): number {
  const ch = text[i];
  if (ch === "'" || ch === '"' || (js && ch === '`')) {
    for (let k = i + 1; k < text.length; k++) {
      if (text[k] === '\\') k++;
      else if (text[k] === ch) return k + 1;
    }
    return text.length;
  }
  if (ch === '$' && !/\w/.test(text[i - 1] ?? ' ')) {
    const tagRe = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/uy;
    tagRe.lastIndex = i;
    const tag = tagRe.exec(text);
    if (tag) {
      const close = text.indexOf(tag[0], i + tag[0].length);
      return close === -1 ? text.length : close + tag[0].length;
    }
  }
  return -1;
}

/** A `/` at `k` starts a regex literal after an operator or opening bracket, not after an operand. */
function regexAllowed(code: string, k: number): boolean {
  let j = k - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  return (
    j < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(code[j]!) || /\breturn$/.test(code.slice(0, j + 1))
  );
}

/** End (exclusive) of the regex literal starting at `k`: the next unescaped `/` outside a class. */
function regexEnd(code: string, k: number): number {
  let inClass = false;
  for (k++; k < code.length; k++) {
    const c = code[k];
    if (c === '\\') k++;
    else if (c === '\n') return k;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return k + 1;
  }
  return code.length;
}

/** Remove comments, leaving the contents of JavaScript strings and templates alone. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (src.startsWith('/*', i)) {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
    } else if (src.startsWith('//', i)) {
      /* A line comment runs to the newline; an apostrophe in it opens no string. */
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const end = quotedEnd(src, i, true);
      out += src.slice(i, end);
      i = end;
    } else if (ch === '/' && src[i + 1] !== '/' && regexAllowed(src, i)) {
      /* A regex literal may contain `/*`; it is code, not a comment opener. */
      const end = regexEnd(src, i);
      out += src.slice(i, end);
      i = end;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const strip = (src: string) => stripComments(src).replace(/^\s*(\/\/|--).*$/gm, '');

/** Replace SQL comments (`/* .. *\/`, `-- ..`) with a space, leaving quoted text alone. */
function stripSqlComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    const q = quotedEnd(text, i);
    if (q !== -1) {
      out += text.slice(i, q);
      i = q;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      out += ' ';
    } else if (text.startsWith('--', i)) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
    } else out += text[i++];
  }
  return out;
}

/** Split on commas outside (), {}, [] and single-quoted SQL text (a doubled quote stays inside). */
function topLevelSplit(text: string, js = false): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const q = quotedEnd(text, i, js);
    if (q !== -1) {
      cur += text.slice(i, q);
      i = q - 1;
      continue;
    }
    const ch = text[i]!;
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

/** Index of the first `end` match at bracket depth 0, outside single-quoted text, from `from`; else the end. */
function topLevelEnd(text: string, from: number, end: RegExp, js = false): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const q = quotedEnd(text, i, js);
    if (q !== -1) {
      i = q - 1;
      continue;
    }
    const ch = text[i]!;
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
  const n = code.length;
  /* End of a JavaScript string starting at `k` (they cannot span lines). */
  const stringEnd = (k: number): number => {
    const q = code[k];
    for (k++; k < n; k++) {
      if (code[k] === '\\') k++;
      else if (code[k] === q) return k + 1;
      else if (code[k] === '\n') return k;
    }
    return n;
  };
  /* End (exclusive) of the expression whose `${` ended just before `k`. */
  const exprEnd = (k: number): number => {
    let depth = 1;
    while (k < n && depth > 0) {
      const ch = code[k];
      if (ch === "'" || ch === '"') k = stringEnd(k);
      else if (ch === '`') k = templateEnd(k);
      else if (ch === '/' && code[k + 1] !== '/' && code[k + 1] !== '*' && regexAllowed(code, k)) {
        k = regexEnd(code, k);
      } else {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        k++;
      }
    }
    return k;
  };
  /* End (exclusive) of the template literal starting at `k`, skipping nested ones. */
  const templateEnd = (k: number): number => {
    for (k++; k < n;) {
      if (code[k] === '\\') k += 2;
      else if (code[k] === '`') return k + 1;
      else if (code[k] === '$' && code[k + 1] === '{') k = exprEnd(k + 2);
      else k++;
    }
    return n;
  };
  let out = '';
  let i = 0;
  while (i < n) {
    const ch = code[i]!;
    if (ch === "'" || ch === '"') {
      /* An ordinary string is text: a `${` inside it is not an interpolation. */
      const end = stringEnd(i);
      out += code.slice(i, end);
      i = end;
    } else if (ch === '`') {
      out += '`';
      i++;
      while (i < n && code[i] !== '`') {
        if (code[i] === '\\') {
          out += code.slice(i, i + 2);
          i += 2;
        } else if (code[i] === '$' && code[i + 1] === '{') {
          const end = exprEnd(i + 2);
          out += code.slice(i + 2, end - 1).trim() === 'businesses' ? 'businesses' : '$1';
          i = end;
        } else out += code[i++];
      }
      if (i < n) {
        out += '`';
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** End of the SQL statement starting at `from`: a `;` or the closing backtick outside single quotes. */
function statementEnd(code: string, from: number): number {
  for (let i = from; i < code.length; i++) {
    /* Quoted text (including `$$..$$` and `$tag$..$tag$`) is text, whatever it contains. */
    const q = quotedEnd(code, i);
    if (q !== -1) {
      i = q - 1;
      continue;
    }
    if (code[i] === ';' || code[i] === '`') return i;
  }
  return code.length;
}

/** End of a builder chain: the first `;` outside a quoted argument. */
function chainEnd(code: string, from: number): number {
  for (let i = from; i < code.length; i++) {
    const q = quotedEnd(code, i, true);
    if (q !== -1) {
      i = q - 1;
      continue;
    }
    if (code[i] === ';') return i;
  }
  return code.length;
}

/** Offsets in `code` (interpolations already masked) of every statement assigning the plan or its expiry on `businesses`. */
function planWriteOffsets(code: string): number[] {
  const hits: number[] = [];
  /* PostgreSQL reads a comment as whitespace, so one may sit at any token gap. */
  const sqlWs = String.raw`(?:\s|/\*[\s\S]*?\*/|--[^\n]*\n)+`;
  const table = String.raw`(?:ONLY${sqlWs})?(?:"?public"?\.)?"?businesses"?(?:\s*\*)?`;
  const alias = String.raw`(?:${sqlWs}(?:AS${sqlWs})?(?!(?:SET|VALUES|SELECT|DEFAULT|OVERRIDING|WITH|TABLE)\b)"?\w+"?)?`;
  const column = String.raw`"?(?:plan|plan_expires_at)"?`;
  const single = new RegExp(String.raw`^\s*(?:\w+\.)?${column}\s*=(?!=)`, 'i');
  const tuple = new RegExp(String.raw`^\s*\([^)]*\b${column}\b[^)]*\)\s*=`, 'i');
  const assignsPlan = (raw: string, from: number) => {
    /* Comments go first: one holding a keyword or an apostrophe must not move the clause end. */
    const text = stripSqlComments(raw.slice(from));
    const clause = text.slice(0, topLevelEnd(text, 0, /^(WHERE\b|RETURNING\b|FROM\b|`)/i));
    return topLevelSplit(clause).some(
      (a) => single.test(a) || tuple.test(a) || /^\s*\$1\s*$/.test(a),
    );
  };

  for (const m of code.matchAll(
    new RegExp(String.raw`UPDATE${sqlWs}${table}${alias}${sqlWs}SET\s`, 'gi'),
  )) {
    if (assignsPlan(code, m.index! + m[0].length)) hits.push(m.index!);
  }
  for (const m of code.matchAll(
    new RegExp(String.raw`INSERT${sqlWs}INTO${sqlWs}${table}\b`, 'gi'),
  )) {
    const end = statementEnd(code, m.index!);
    const stmt = code.slice(m.index!, end);
    const set = new RegExp(
      String.raw`\bON${sqlWs}CONFLICT\b[\s\S]*?\bDO${sqlWs}UPDATE${sqlWs}SET${sqlWs}`,
      'i',
    ).exec(stmt);
    if (set && assignsPlan(stmt, set.index + set[0].length)) hits.push(m.index!);
    /* A plain insert naming the column: INSERT INTO businesses [AS b] (..., plan, ...) */
    const cols = new RegExp(
      String.raw`^INSERT${sqlWs}INTO${sqlWs}${table}${alias}\s*\(([^)]*)\)`,
      'i',
    ).exec(stmt);
    if (cols && new RegExp(String.raw`(^|,)\s*${column}\s*(,|$)`, 'i').test(cols[1]!)) {
      hits.push(m.index!);
    }
    /* No column list (INSERT ... VALUES / SELECT): the target columns are unknown. */
    if (!cols) hits.push(m.index!);
  }
  /* MERGE has several actions (matched update, not-matched insert); no code
   * uses it on `businesses`, so any use counts as a write and needs review. */
  for (const m of code.matchAll(
    new RegExp(String.raw`MERGE${sqlWs}INTO${sqlWs}${table}\b`, 'gi'),
  )) {
    hits.push(m.index!);
  }

  /* A query-builder object is read property by property; anything else (a
   * patch variable) cannot be read here, so it counts as a write. */
  const writes = (text: string, from: number): boolean => {
    if (text[from] !== '{') return true;
    const props = topLevelSplit(
      text.slice(from + 1, topLevelEnd(text, from + 1, /^\}/, true)),
      true,
    );
    return props.some((p) =>
      /^\s*(?:(?:get\s+)?(?:plan|planExpiresAt)\s*(?::|\(|$)|['"](?:plan|planExpiresAt)['"]\s*:|\[|\.\.\.)/.test(
        p,
      ),
    );
  };
  /* A builder stored and finished in a later statement cannot be read: count it. */
  for (const re of [
    /\.update\(\s*businesses\s*\)(?!\s*\.set\()/g,
    /\.insert\(\s*businesses\s*\)(?!\s*\.values\()/g,
  ]) {
    for (const m of code.matchAll(re)) hits.push(m.index!);
  }
  for (const m of code.matchAll(/\.update\(\s*businesses\s*\)\s*\.set\(\s*/g)) {
    if (writes(code, m.index! + m[0].length)) hits.push(m.index!);
  }
  for (const m of code.matchAll(/\.insert\(\s*businesses\s*\)\s*\.values\(\s*/g)) {
    if (writes(code, m.index! + m[0].length)) hits.push(m.index!);
  }
  for (const m of code.matchAll(/\.insert\(\s*businesses\s*\)/g)) {
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
  let end = -1;
  let start = -1;
  const decl =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+)|class\s+(\w+))/gm;
  for (const m of code.matchAll(decl)) {
    if (m.index! > offset) break;
    name = m[1] ?? m[2] ?? m[3] ?? name;
    start = m.index!;
    /* An expression-bodied arrow ends at its `;`; any other declaration at the next `}` at column 0. */
    const expr =
      /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]+)?|\w+)\s*=>\s*(\{)?/.exec(
        code.slice(m.index!),
      );
    if (expr && !expr[1]) {
      end = chainEnd(code, m.index! + expr[0].length);
    } else {
      const close = /^\}/m.exec(code.slice(m.index! + 1));
      end = close ? m.index! + 1 + close.index : code.length;
    }
  }
  /* Past the end of the last declaration: module-level code, never inherited. */
  if (offset > end) return '<module>';
  /* A named function-valued helper nested in the declaration owns its own writes. */
  const nested =
    /^([ \t]+)(?:(?:async\s+)?function\*?\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)\s*(?::[^=]+)?|\w+)\s*=>\s*(\{)?))/gm;
  let inner = '';
  for (const m of code.matchAll(nested)) {
    if (m.index! > offset) break;
    /* A block body ends at its closing brace; an expression body at its `;`. */
    const arrowExpr = m[0].includes('=>') && !m[4];
    const close = new RegExp(`^${m[1]}\\}`, 'm').exec(code.slice(m.index! + 1));
    const nestedEnd = arrowExpr
      ? chainEnd(code, m.index! + m[0].length)
      : close
        ? m.index! + 1 + close.index
        : code.length;
    if (offset <= nestedEnd && m.index! > start) inner = m[2] ?? m[3] ?? '';
  }
  return inner ? `${name}>${inner}` : name;
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

  it('reads a comment before SET, a getter and a regex literal (review findings)', () => {
    const w = (s: string) => planWriters(s);
    expect(w('function a(){ sql`UPDATE businesses /* note */ SET plan = ${p}` }')).toEqual(['a']);
    expect(w('function a(){ sql`UPDATE businesses -- note\n SET plan = ${p}` }')).toEqual(['a']);
    expect(w('function a(){ tx.update(businesses).set({ get plan() { return next; } }) }')).toEqual(
      ['a'],
    );
    expect(
      w('const re = /[/*]/;\nfunction a(){ tx.update(businesses).set({ plan: next }) }'),
    ).toEqual(['a']);
  });

  it('a SQL comment holding a keyword or apostrophe does not hide the plan assignment', () => {
    const w = (s: string) => planWriters(s);
    expect(
      w("function a(){ sql`UPDATE businesses SET note = 1 -- it's from here\n, plan = ${p}` }"),
    ).toEqual(['a']);
    expect(
      w('function a(){ sql`UPDATE businesses SET note = 1 /* where */, plan = ${p}` }'),
    ).toEqual(['a']);
  });

  it('an expression-bodied helper does not own the writes after it', () => {
    expect(
      planWriters(
        'function a() {\n  const iso = (d) => d.toISOString();\n  tx.update(businesses).set({ plan: n });\n}\n',
      ),
    ).toEqual(['a']);
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

  it('reads the optional table star, dollar-quoted text and template literals in a chain', () => {
    const w = (src: string) => planWriters(src);
    expect(w('function a(){ sql`UPDATE businesses* SET plan = ${p}` }')).toEqual(['a']);
    expect(
      w(
        'function a(){ sql`INSERT INTO businesses (id, name) VALUES (${i}, $$merchant; name$$) ON CONFLICT (id) DO UPDATE SET plan = ${p}` }',
      ),
    ).toEqual(['a']);
    expect(
      w(
        'function a(){ tx.insert(businesses).values({ name: `a; b` }).onConflictDoUpdate({ target: businesses.id, set: { plan } }); }',
      ),
    ).toEqual(['a']);
  });

  it('does not credit module-level code to the declaration before it', () => {
    const src =
      'export async function writeSubscriptionState() {\n  await tx.update(businesses).set({ name });\n}\n\n' +
      'await db.update(businesses).set({ plan: next });\n';
    expect(planWriters(src)).toEqual(['<module>']);
  });

  it('counts a builder split across statements as a write', () => {
    expect(
      planWriters('function a(){ const q = tx.update(businesses); await q.set({ plan: next }); }'),
    ).toEqual(['a']);
    expect(
      planWriters('function a(){ const q = tx.insert(businesses); await q.values({ name }); }'),
    ).toEqual(['a']);
  });

  it('reads whitespace inside the table argument', () => {
    expect(planWriters('function a(){ tx.update( businesses ).set({ plan }) }')).toEqual(['a']);
    expect(planWriters('function a(){ tx.insert(\n  businesses\n).values({ plan }) }')).toEqual([
      'a',
    ]);
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

  it('reads tagged dollar quotes, spaced table stars, quoted braces and comment openers in strings', () => {
    const w = (s: string) => planWriters(s);
    expect(
      w(
        'function a(){ sql`INSERT INTO businesses (id, name) VALUES (${i}, $body$merchant; name$body$) ON CONFLICT (id) DO UPDATE SET plan = EXCLUDED.plan` }',
      ),
    ).toEqual(['a']);
    expect(
      w(
        'function a(){ sql`UPDATE businesses SET name = $$WHERE hidden$$, plan = ${p} WHERE id = ${i}` }',
      ),
    ).toEqual(['a']);
    expect(w('function a(){ sql`UPDATE businesses * SET plan = ${p}` }')).toEqual(['a']);
    expect(w('function a(){ tx.update(businesses).set({ note: "}", plan: next }) }')).toEqual([
      'a',
    ]);
    expect(w('function a(){ tx.update(businesses).set({ note: `}`, plan: next }) }')).toEqual([
      'a',
    ]);
    expect(
      w("function a(){ sql`UPDATE businesses SET note = '/*', plan = 'chat' /* end */` }"),
    ).toEqual(['a']);
    /* Comments outside strings still do not count, and a harmless update stays harmless. */
    expect(
      w('function a(){ /* UPDATE businesses SET plan = 1 */ tx.update(users).set({}) }'),
    ).toEqual([]);
    expect(w('function a(){ tx.update(businesses).set({ note: "}", name: next }) }')).toEqual([]);
  });

  it('reads a maximum-length dollar-quote tag and ignores `${` inside ordinary strings', () => {
    const w = (s: string) => planWriters(s);
    /* A 63-character tag makes a 65-character delimiter; the `;` inside it is text. */
    const tag = 'a'.repeat(63);
    expect(
      w(
        'function a(){ sql`INSERT INTO businesses (id, note) VALUES (${i}, $' +
          tag +
          '$x; y$' +
          tag +
          '$) ON CONFLICT (id) DO UPDATE SET plan = EXCLUDED.plan` }',
      ),
    ).toEqual(['a']);
    /* An unclosed `${` in a plain string is not an interpolation. */
    expect(
      w(
        'function a(){ const hint = "${value"; }\nfunction b(){ tx.update(businesses).set({ plan }) }',
      ),
    ).toEqual(['b']);
    expect(
      w(
        "function a(){ const hint = '${value'; }\nfunction b(){ tx.update(businesses).set({ plan }) }",
      ),
    ).toEqual(['b']);
    /* A real interpolation inside a template, even inside SQL quotes, is still masked. */
    expect(w("function a(){ sql`UPDATE businesses SET note = '${x}', plan = ${p}` }")).toEqual([
      'a',
    ]);
  });

  it('reads a dollar-quote tag longer than 63 characters and non-ASCII tags', () => {
    const w = (s: string) => planWriters(s);
    const tag = `$${'t'.repeat(80)}$`;
    expect(
      w(
        `function a(){ sql\`INSERT INTO businesses (id) VALUES (\${i}) ON CONFLICT (id) DO UPDATE SET note = ${tag}x;y${tag}, plan = EXCLUDED.plan\` }`,
      ),
    ).toEqual(['a']);
    expect(
      w('function a(){ sql`UPDATE businesses SET note = $é$x;y$é$, plan = ${p} WHERE id = ${i}` }'),
    ).toEqual(['a']);
  });

  it('reads SQL comments between SET and the column as whitespace', () => {
    const w = (s: string) => planWriters(s);
    expect(w('function a(){ sql`UPDATE businesses SET /* c */ plan = ${p}` }')).toEqual(['a']);
    expect(
      w('function a(){ sql`UPDATE businesses SET name = 1, /* c */ plan_expires_at = ${d}` }'),
    ).toEqual(['a']);
    expect(w("function a(){ sql`UPDATE businesses SET note = '/*', plan = ${p} /* */` }")).toEqual([
      'a',
    ]);
    expect(w('function a(){ sql`UPDATE businesses SET /* plan = 1 */ name = ${n}` }')).toEqual([]);
  });

  it('does not credit a write in a nested helper to the allowlisted function around it', () => {
    const src = [
      'export function outer() {',
      '  const helper = async (tx) => {',
      '    await tx.update(businesses).set({ plan: next });',
      '  };',
      '}',
    ].join('\n');
    expect(planWriters(src)).toEqual(['outer>helper']);
    const fn = [
      'export function outer() {',
      '  function helper(tx) {',
      '    return tx.update(businesses).set({ plan: next });',
      '  }',
      '}',
    ].join('\n');
    expect(planWriters(fn)).toEqual(['outer>helper']);
    const cb = [
      'export function outer() {',
      '  return withBusiness(async (tx) => {',
      '    await tx.update(businesses).set({ plan: next });',
      '  });',
      '}',
    ].join('\n');
    expect(planWriters(cb)).toEqual(['outer']);
  });

  it('skips a regex literal holding a brace inside an interpolation', () => {
    const w = (s: string) => planWriters(s);
    expect(
      w(
        'function a(){ sql`UPDATE businesses SET note = ${x.replace(/}/g, `y`)}, plan = ${p} WHERE id = ${i}` }',
      ),
    ).toEqual(['a']);
  });

  it('reads a SQL comment at every token gap (CodeRabbit, 1 Nov)', () => {
    const w = (s: string) => planWriters(s);
    expect(w('function a(){ sql`UPDATE /* x */ businesses SET plan = ${p}` }')).toEqual(['a']);
    expect(w('function a(){ sql`UPDATE businesses /* x */ AS b SET plan = ${p}` }')).toEqual(['a']);
    expect(w('function a(){ sql`UPDATE businesses AS /* x */ b SET plan = ${p}` }')).toEqual(['a']);
    expect(w('function a(){ sql`INSERT INTO /* x */ businesses (plan) VALUES (${p})` }')).toEqual([
      'a',
    ]);
    expect(
      w('function a(){ sql`UPDATE /* x */ ONLY /* y */ businesses SET plan = ${p}` }'),
    ).toEqual(['a']);
    expect(w('function a(){ sql`UPDATE /* plan */ businesses SET name = ${n}` }')).toEqual([]);
  });

  it('a trailing JavaScript comment, even with an apostrophe, hides nothing', () => {
    const w = (s: string) => planWriters(s);
    expect(
      w("function a(){\n  const x = 1; // it's fine\n  tx.update(businesses).set({ plan: n });\n}"),
    ).toEqual(['a']);
    expect(
      w('function a(){\n  const x = 1; // plain\n  tx.update(businesses).set({ plan: n });\n}'),
    ).toEqual(['a']);
    expect(
      w(
        "function a(){\n  const u = 'http://x'; // it's\n  tx.update(businesses).set({ plan: n });\n}",
      ),
    ).toEqual(['a']);
    expect(
      w('function a(){\n  const x = 1; // tx.update(businesses).set({ plan: n });\n}'),
    ).toEqual([]);
  });

  it('a named expression-bodied helper owns the write inside it', () => {
    const one = [
      'export function outer() {',
      '  const helper = (tx) => tx.update(businesses).set({ plan: next });',
      '}',
    ].join('\n');
    expect(planWriters(one)).toEqual(['outer>helper']);
    const bare = [
      'export function outer() {',
      '  const helper = tx => tx.update(businesses).set({ plan: next });',
      '  return helper;',
      '}',
    ].join('\n');
    expect(planWriters(bare)).toEqual(['outer>helper']);
    const multi = [
      'export function outer() {',
      '  const helper = (tx) =>',
      '    tx.update(businesses).set({ plan: next });',
      '  tx.update(businesses).set({ plan: other });',
      '}',
    ].join('\n');
    expect(planWriters(multi)).toEqual(['outer', 'outer>helper']);
  });

  it('sweeps .mts and .cts sources but not their declaration files (Codex, 1 Nov)', () => {
    expect(isSwept('writer.cts')).toBe(true);
    expect(isSwept('types.d.mts')).toBe(false);
    expect(isSwept('types.d.cts')).toBe(false);
    expect(isSwept('writer.test.mts')).toBe(false);
  });

  it('reads comments inside ON CONFLICT ... DO UPDATE SET (Codex, 1 Nov)', () => {
    const w = (s: string) => planWriters(s);
    expect(
      w(
        'function a(){ sql`INSERT INTO businesses (name) VALUES (${n}) ON /* r */ CONFLICT (id) DO UPDATE SET plan = ${p}` }',
      ),
    ).toEqual(['a']);
    expect(
      w(
        'function a(){ sql`INSERT INTO businesses (name) VALUES (${n}) ON CONFLICT (id) DO /* r */ UPDATE /* r */ SET /* r */ plan = ${p}` }',
      ),
    ).toEqual(['a']);
  });

  it('a top-level expression-bodied const does not own the module code after it (Codex, 1 Nov)', () => {
    const src = [
      'export const allowed = (tx) => tx.update(businesses).set({ name: n });',
      '',
      'tx.update(businesses).set({ plan: next });',
    ].join('\n');
    expect(planWriters(src)).toEqual(['<module>']);
    const own = [
      'export const allowed = (tx) => tx.update(businesses).set({ plan: n });',
      'const z = 1;',
    ].join('\n');
    expect(planWriters(own)).toEqual(['allowed']);
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
