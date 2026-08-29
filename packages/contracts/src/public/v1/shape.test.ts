/**
 * v1 is frozen (canonical spec §27).
 *
 * §27 requires public contracts to be versioned independently of the schema.
 * "Independently" is only true if a schema change cannot quietly reshape the
 * wire, and the only way to know that is to write down what v1 IS and fail
 * when it stops being that.
 *
 * So this file holds a structural description of every schema the v1 barrel
 * exports, spelled out. Adding a field to a response makes this test fail;
 * that is the point. Fixing it means one of two decisions, both deliberate:
 * update the expectation because the change is additive and safe, or leave
 * v1 alone and open v2. What must never happen is a public shape changing
 * because a column did.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as v1 from './index.js';

describe('the v1 wire shape', () => {
  it('is exactly this, and changes only on purpose', () => {
    expect(describe_(v1.publicErrorResponse)).toBe(
      'object{error:object{' +
        'code:enum(forbidden|internal|invalid_request|not_entitled|not_found|' +
        'quota_exhausted|rate_limited|unauthenticated|unsupported_version),' +
        'details?:array(object{field:string,message:string}),' +
        'message:string,' +
        'retryAfterSeconds?:number' +
        '}}',
    );

    expect(describe_(v1.publicIdentityResponse)).toBe(
      'object{' +
        'applicationId:string,' +
        'businessId:string,' +
        'businessName:string,' +
        'keyPrefix:string,' +
        'mode:enum(live|test),' +
        'rateLimitPerMinute:number' +
        '}',
    );

    expect(describe_(v1.publicPage(z.string()))).toBe(
      'object{items:array(string),nextCursor:nullable(string)}',
    );
  });

  it("freezes the Merchant API's reads", () => {
    expect(describe_(v1.merchantCustomer)).toBe('object{createdAt:string,id:string,token:string}');

    expect(describe_(v1.merchantProduct)).toBe(
      'object{' +
        'active:boolean,' +
        'createdAt:string,' +
        'description:nullable(string),' +
        'id:string,' +
        'name:string,' +
        'unitPriceK:nullable(number)' +
        '}',
    );

    expect(describe_(v1.merchantInvoice)).toBe(
      'object{' +
        'balanceDueK:number,' +
        'currency:string,' +
        'customerId:nullable(string),' +
        'dueDate:nullable(string),' +
        'id:string,' +
        'invoiceNumber:string,' +
        'issuedAt:string,' +
        'paidK:number,' +
        'status:enum(issued|paid|partially_paid|voided),' +
        'totalK:number' +
        '}',
    );
  });

  it("freezes the Merchant API's writes", () => {
    expect(describe_(v1.recordSaleRequest)).toBe(
      'object{' +
        'amountPaidK?:number,' +
        'customerId?:nullable(string),' +
        'deliveryFeeK?:number,' +
        'discountK?:number,' +
        'dueDate?:nullable(string),' +
        'items:array(object{name:string,quantity:number,unitPriceK:number}),' +
        'method?:enum(cash|transfer),' +
        'vatK?:number' +
        '}',
    );

    expect(describe_(v1.recordSaleResponse)).toBe(
      'object{balanceDueK:number,invoiceId:string,invoiceNumber:string,totalK:number}',
    );

    expect(describe_(v1.recordPaymentRequest)).toBe(
      'object{amountK:number,invoiceNumber:string,method?:enum(cash|transfer),' +
        'reference?:nullable(string)}',
    );
  });

  it('exposes no field whose name belongs to a database column', () => {
    /* A cheap, blunt guard on §27's "must not expose Drizzle table shapes":
     * a snake_case FIELD name means a column travelled here verbatim, and
     * so did the table it came from. Error CODES are snake_case on purpose
     * and are values, not fields, so the walk collects names only. */
    for (const shape of [
      v1.publicErrorResponse,
      v1.publicIdentityResponse,
      v1.merchantCustomer,
      v1.merchantProduct,
      v1.merchantInvoice,
      v1.recordSaleRequest,
      v1.recordSaleResponse,
      v1.recordPaymentRequest,
    ]) {
      for (const name of fieldNames(shape)) {
        expect(name, name).not.toMatch(/_/);
      }
    }
  });
});

/** Every field name anywhere in a schema, however deeply nested. */
function fieldNames(schema: z.ZodType, found: string[] = []): string[] {
  const def = schema.def as { type: string; [key: string]: unknown };
  if (def.type === 'object') {
    for (const [name, value] of Object.entries(
      (schema as unknown as z.ZodObject<z.ZodRawShape>).shape,
    )) {
      found.push(name);
      fieldNames(unwrap(value as z.ZodType), found);
    }
    return found;
  }
  for (const key of ['element', 'innerType']) {
    const inner = def[key];
    if (inner) fieldNames(inner as z.ZodType, found);
  }
  return found;
}

/**
 * A stable, sorted, one-line description of a zod schema.
 *
 * Sorted so a reordered object literal is not a wire change, and recursive
 * so a nested shape cannot slip past by hiding one level down.
 */
function describe_(schema: z.ZodType): string {
  const def = schema.def as { type: string; [key: string]: unknown };
  switch (def.type) {
    case 'object': {
      const shape = (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
      const fields = Object.entries(shape)
        .map(([name, value]) => {
          const inner = value as z.ZodType;
          const optional = inner.safeParse(undefined).success;
          return `${name}${optional ? '?' : ''}:${describe_(unwrap(inner))}`;
        })
        .sort();
      return `object{${fields.join(',')}}`;
    }
    case 'array':
      return `array(${describe_(def['element'] as z.ZodType)})`;
    case 'nullable':
      return `nullable(${describe_(def['innerType'] as z.ZodType)})`;
    case 'optional':
      return describe_(def['innerType'] as z.ZodType);
    case 'enum':
      return `enum(${Object.keys(def['entries'] as Record<string, string>)
        .sort()
        .join('|')})`;
    case 'literal':
      return `literal(${JSON.stringify((def['values'] as unknown[])[0])})`;
    case 'union':
      return `union(${(def['options'] as z.ZodType[]).map(describe_).sort().join('|')})`;
    default:
      return def.type;
  }
}

/** Strips the optional/nullable wrapper an object field may be wearing. */
function unwrap(schema: z.ZodType): z.ZodType {
  const def = schema.def as { type: string; innerType?: z.ZodType };
  return def.type === 'optional' && def.innerType ? def.innerType : schema;
}
