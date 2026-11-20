/**
 * Whether a tool's JSON Schema can be sent with `strict: true`, and in what form.
 *
 * Strict tool use compiles the schema into a grammar, so the model can only
 * emit input that matches it. The API accepts only a subset of JSON Schema
 * for that, and refuses the WHOLE request with a 400 when a schema steps
 * outside it. So this is a check, not a transformation that always succeeds:
 *
 * - a schema inside the documented limits is sent strict, with the
 *   value constraints strict mode does not take (lengths, numeric bounds,
 *   patterns, `maxItems`) removed from the copy on the wire;
 * - anything else is sent exactly as before, without `strict`, rather than
 *   turning a working call into a refused one.
 *
 * Removing a constraint from the wire copy weakens nothing the application
 * relies on. The model's answer is still parsed by the caller's own schema
 * (`parseBusinessCommand`, `parseDocumentClass`), which enforces every bound,
 * as it did when no tool was strict. Strict mode is a guarantee about the
 * model's output added on top of that parse, never a replacement for it.
 *
 * The rules are the ones published for structured outputs (checked 20 Nov
 * 2026: platform.claude.com/docs/en/build-with-claude/structured-outputs,
 * "JSON Schema limitations" and "Schema complexity limits"). They do not
 * depend on the model, so neither does this function. Where the documentation
 * is not exact, the check is conservative: an unrecognised keyword means "not
 * strict", because the cost of being wrong that way is the old behaviour, and
 * the cost of being wrong the other way is a 400.
 */

/** Documented ceilings, totalled across every strict schema in one request. */
export const STRICT_LIMITS = {
  /** Properties that use `anyOf` or a type array. */
  unionParameters: 16,
  /** Properties not listed in their object's `required`. */
  optionalParameters: 24,
} as const;

/** Keywords strict mode takes as they are. */
const KEPT = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
  'title',
  'default',
  'format',
  'minItems',
]);

/**
 * Value constraints strict mode refuses. Dropped from the wire copy only: the
 * caller's parser enforces them on the answer.
 */
const DROPPED = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
  'pattern',
]);

const FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

export type StrictToolSchema =
  { ok: true; schema: Record<string, unknown> } | { ok: false; reason: string };

class NotStrict extends Error {}

/**
 * The strict wire form of `schema`, or why it has none.
 *
 * Pure and deterministic: the same schema always gives the same answer, so
 * the tool definition (part of the cached prompt prefix) never changes from
 * one call to the next.
 */
export function strictToolSchema(schema: Record<string, unknown>): StrictToolSchema {
  const counts = { unions: 0, optional: 0 };
  let out: Record<string, unknown>;
  try {
    out = convert(schema, counts) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof NotStrict) return { ok: false, reason: error.message };
    throw error;
  }
  if (out['type'] !== 'object') return { ok: false, reason: 'the root is not an object' };
  if (counts.unions > STRICT_LIMITS.unionParameters) {
    return {
      ok: false,
      reason: `${counts.unions} union-typed parameters (strict limit ${STRICT_LIMITS.unionParameters})`,
    };
  }
  if (counts.optional > STRICT_LIMITS.optionalParameters) {
    return {
      ok: false,
      reason: `${counts.optional} optional parameters (strict limit ${STRICT_LIMITS.optionalParameters})`,
    };
  }
  return { ok: true, schema: out };
}

function convert(node: unknown, counts: { unions: number; optional: number }): unknown {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new NotStrict('a schema node is not an object');
  }
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (DROPPED.has(key)) continue;
    if (!KEPT.has(key)) throw new NotStrict(`unsupported keyword "${key}"`);

    switch (key) {
      case 'properties': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new NotStrict('properties is not an object');
        }
        out[key] = Object.fromEntries(
          Object.entries(value).map(([name, child]) => [name, convert(child, counts)]),
        );
        break;
      }
      case 'items':
        out[key] = convert(value, counts);
        break;
      case 'anyOf': {
        if (!Array.isArray(value)) throw new NotStrict('anyOf is not a list');
        if ('type' in source || 'properties' in source) {
          throw new NotStrict('anyOf beside type or properties');
        }
        out[key] = value.map((branch) => convert(branch, counts));
        break;
      }
      case 'format':
        if (typeof value !== 'string' || !FORMATS.has(value)) {
          throw new NotStrict(`unsupported format "${String(value)}"`);
        }
        out[key] = value;
        break;
      case 'enum':
      case 'const': {
        const values = key === 'enum' ? value : [value];
        if (!Array.isArray(values) || values.some((v) => typeof v === 'object' && v !== null)) {
          throw new NotStrict(`${key} with a non-primitive value`);
        }
        out[key] = structuredClone(value);
        break;
      }
      case 'minItems':
        if (value !== 0 && value !== 1) throw new NotStrict(`minItems ${String(value)}`);
        out[key] = value;
        break;
      default:
        /* A copy, so the strict form shares no array or object with the
         * caller's schema (or with the cached form of it). */
        out[key] = structuredClone(value);
    }
  }

  if (Array.isArray(source['type']) && source['type'].includes('object')) {
    throw new NotStrict('a type array with object');
  }
  if ('anyOf' in source || Array.isArray(source['type'])) counts.unions += 1;

  /* An object is anything that declares properties, with or without
   * `type: object`: strict mode wants additionalProperties false on each. */
  if (source['type'] === 'object' || 'properties' in source) {
    if (source['additionalProperties'] !== false) {
      throw new NotStrict('an object allows additional properties');
    }
    const required = new Set(Array.isArray(source['required']) ? source['required'] : []);
    const names = Object.keys((source['properties'] as Record<string, unknown> | undefined) ?? {});
    counts.optional += names.filter((name) => !required.has(name)).length;
  }
  return out;
}
