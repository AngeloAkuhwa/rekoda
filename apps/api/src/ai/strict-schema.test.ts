import { describe, expect, it } from 'vitest';
import { businessCommandToolSchema, parseBusinessCommand } from '@rekoda/contracts';
import { CLASSIFIER_TOOL_SCHEMA } from './classifier.js';
import { STRICT_LIMITS, strictToolSchema } from './strict-schema.js';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

describe('which tool schemas are sent strict', () => {
  it('sends the document classifier strict, exactly as written', () => {
    const result = strictToolSchema(CLASSIFIER_TOOL_SCHEMA);
    expect(result).toEqual({ ok: true, schema: CLASSIFIER_TOOL_SCHEMA });
  });

  /* The business command is a union of eight intents with many nullable
   * fields. That is more union-typed parameters than strict mode compiles,
   * and the API refuses such a request outright, so the interpreter's tool
   * goes out non-strict, as it always has. Restructuring the contract to fit
   * would change what every command looks like; it is not done here. */
  it('does NOT send the business command strict: it exceeds the union limit, which would be a 400', () => {
    const result = strictToolSchema(businessCommandToolSchema());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/union-typed parameters \(strict limit 16\)/);
    const counted = Number(/^(\d+)/.exec(result.reason)?.[1]);
    expect(counted).toBeGreaterThan(STRICT_LIMITS.unionParameters);
  });

  it('keeps business validation where it was: the parser still refuses what the wire copy loses', () => {
    /* The ₦10bn ceiling and the name length are value constraints strict mode
     * cannot carry. Whatever the wire form, parseBusinessCommand refuses them. */
    expect(
      parseBusinessCommand({
        intent: 'RecordExpense',
        description: 'fuel',
        amount: 900_000_000_000,
        category: null,
        paymentMethod: 'cash',
      }).ok,
    ).toBe(false);
  });
});

describe('the strict wire form', () => {
  it('drops the value constraints strict mode refuses, and only those', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      ...object({
        name: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Z]+$' },
        amount: { type: 'number', minimum: 0, maximum: 10_000_000_000, exclusiveMinimum: 0 },
        items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
        when: { type: 'string', format: 'date' },
        kind: { type: 'string', enum: ['a', 'b'], description: 'which' },
      }),
    };

    const result = strictToolSchema(schema);

    expect(result).toEqual({
      ok: true,
      schema: object({
        name: { type: 'string' },
        amount: { type: 'number' },
        items: { type: 'array', items: { type: 'string' }, minItems: 1 },
        when: { type: 'string', format: 'date' },
        kind: { type: 'string', enum: ['a', 'b'], description: 'which' },
      }),
    });
  });

  it('never changes the schema it was given', () => {
    const schema = object({ name: { type: 'string', maxLength: 5 } });
    const before = structuredClone(schema);
    strictToolSchema(schema);
    expect(schema).toEqual(before);
  });

  it('gives the same answer every time, so the cached tool prefix never moves', () => {
    const schema = object({ name: { anyOf: [{ type: 'string' }, { type: 'null' }] } });
    expect(JSON.stringify(strictToolSchema(schema))).toBe(JSON.stringify(strictToolSchema(schema)));
  });
});

describe('what keeps a schema non-strict', () => {
  const refused = (schema: Record<string, unknown>) => {
    const result = strictToolSchema(schema);
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('an object that allows additional properties', () => {
    expect(
      refused({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }),
    ).toMatch(/additional properties/);
  });

  it('a nested object that allows additional properties', () => {
    expect(refused(object({ inner: { type: 'object', properties: {} } }))).toMatch(
      /additional properties/,
    );
  });

  it('oneOf, not, $ref and any keyword it does not recognise', () => {
    expect(refused(object({ a: { oneOf: [{ type: 'string' }] } }))).toMatch(/"oneOf"/);
    expect(refused(object({ a: { not: { type: 'string' } } }))).toMatch(/"not"/);
    expect(refused(object({ a: { $ref: '#/$defs/x' } }))).toMatch(/"\$ref"/);
    expect(refused(object({ a: { type: 'string', contentEncoding: 'base64' } }))).toMatch(
      /"contentEncoding"/,
    );
  });

  it('anyOf beside type or properties', () => {
    expect(refused(object({ a: { type: 'string', anyOf: [{ type: 'string' }] } }))).toMatch(
      /anyOf beside/,
    );
  });

  it('a format strict mode does not know, and minItems above 1', () => {
    expect(refused(object({ a: { type: 'string', format: 'regex' } }))).toMatch(/format "regex"/);
    expect(
      refused(object({ a: { type: 'array', items: { type: 'string' }, minItems: 2 } })),
    ).toMatch(/minItems 2/);
  });

  it('a root that is not an object', () => {
    expect(refused({ type: 'string' })).toMatch(/root is not an object/);
  });

  it('one union-typed parameter more than the limit, but not exactly the limit', () => {
    const unions = (n: number) =>
      object(
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            `f${i}`,
            { anyOf: [{ type: 'number' }, { type: 'null' }] },
          ]),
        ),
      );
    expect(strictToolSchema(unions(STRICT_LIMITS.unionParameters)).ok).toBe(true);
    expect(refused(unions(STRICT_LIMITS.unionParameters + 1))).toMatch(/17 union-typed/);
  });

  it('type arrays count as unions too', () => {
    const schema = object(
      Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`f${i}`, { type: ['string', 'null'] }]),
      ),
    );
    expect(refused(schema)).toMatch(/17 union-typed/);
  });

  it('one optional parameter more than the limit, but not exactly the limit', () => {
    const optional = (n: number) =>
      object(
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: 'string' }])),
        [],
      );
    expect(strictToolSchema(optional(STRICT_LIMITS.optionalParameters)).ok).toBe(true);
    expect(refused(optional(STRICT_LIMITS.optionalParameters + 1))).toMatch(/25 optional/);
  });
});
