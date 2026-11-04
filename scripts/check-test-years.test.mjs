import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedLines, annotated, findings, inScope } from './check-test-years.mjs';

const IT = 'apps/api/src/x/y.integration.test.ts';
const text = (...lines) => lines.join('\n');

test('reads integration tests and fixtures only', () => {
  assert.equal(inScope(IT), true);
  assert.equal(inScope('apps/api/src/channels/meta-webhook.fixtures.ts'), true);
  assert.equal(inScope('packages/core/src/replies.test.ts'), false);
  assert.equal(inScope('apps/web/e2e/billing.spec.ts'), false);
  assert.deepEqual(
    findings('packages/core/src/replies.test.ts', "expect(x).toBe('INV-2026-000001');"),
    [],
  );
});

test('flags a literal document year with no annotation', () => {
  const r = findings(IT, text('it("x", () => {', "  expect(n).toBe('INV-2026-000001');", '});'));
  assert.equal(r.length, 1);
  assert.equal(r[0].line, 2);
});

test('flags every prefix, not just invoices', () => {
  for (const n of ['RCT-2027-000001', 'PO-2026-000099', 'JNL-2026-000002', 'CRN-2031-000001']) {
    assert.equal(findings(IT, `expect(a).toBe('${n}');`).length, 1, n);
  }
});

test('accepts a literal in an annotated block, either annotation', () => {
  assert.deepEqual(
    findings(
      IT,
      text('// fixed date: issued at 2026-06-01T10:00Z', "expect(a).toBe('ORD-2026-000001');"),
    ),
    [],
  );
  assert.deepEqual(
    findings(IT, "voidIt({ invoiceNumber: 'INV-2026-999999' }); // not issued: a probe"),
    [],
  );
  // The annotation covers the rest of its block, down to the next blank line.
  const block = text(
    '// fixed date: both issued at the instants above',
    "expect(a).toBe('INV-2026-000001');",
    "expect(b).toBe('RCT-2026-000001');",
  );
  assert.deepEqual(findings(IT, block), []);
});

test('an annotation does not reach past a blank line', () => {
  const lines = [
    '// fixed date: the first block',
    "expect(a).toBe('INV-2026-000001');",
    '',
    "expect(b).toBe('INV-2026-000002');",
  ];
  assert.equal(annotated(lines, 1), true);
  assert.equal(annotated(lines, 3), false);
  assert.equal(findings(IT, text(...lines)).length, 1);
});

test('ignores comments, format patterns, dates and references that are not document numbers', () => {
  const r = findings(
    IT,
    text(
      ' * Read-then-write here produces two invoices numbered INV-2026-000041',
      '// INV-2026-000001 is a first sale',
      'expect(n).toMatch(/^INV-\\d{4}-000001$/);',
      "await post({ occurredOn: '2026-08-03' });",
      "reference: 'RKD-SUB-20261101-BBBBBB',",
    ),
  );
  assert.deepEqual(r, []);
});

test('looks only at the added lines when given them', () => {
  const t = text("expect(a).toBe('INV-2026-000001');", "expect(b).toBe('INV-2026-000002');");
  assert.equal(findings(IT, t, new Set([2])).length, 1);
  assert.equal(findings(IT, t, new Set([2]))[0].line, 2);
  assert.deepEqual(findings(IT, t, new Set()), []);
});

test('reads added line numbers from a unified=0 diff', () => {
  const diff = [
    'diff --git a/a.integration.test.ts b/a.integration.test.ts',
    '--- a/a.integration.test.ts',
    '+++ b/a.integration.test.ts',
    '@@ -10,0 +11,2 @@',
    "+expect(a).toBe('INV-2026-000001');",
    "+expect(b).toBe('INV-2026-000002');",
    '@@ -20 +22 @@',
    '-old',
    '+new',
    '@@ -30,2 +33,0 @@',
    'diff --git a/gone.fixtures.ts b/gone.fixtures.ts',
    '--- a/gone.fixtures.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
  ].join('\n');
  const added = addedLines(diff);
  assert.deepEqual([...added.get('a.integration.test.ts')], [11, 12, 22]);
  assert.equal(added.has('gone.fixtures.ts'), false);
});
