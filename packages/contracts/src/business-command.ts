/**
 * StructuredBusinessCommand — the ONLY thing AI is allowed to produce
 * (architecture spec §43, non-negotiable rules 7–10).
 *
 * The LLM returns JSON; this schema is the border checkpoint. Anything that
 * fails validation is rejected before it can touch the financial core, and
 * the core recomputes every monetary figure itself — a `reportedPayment`
 * here is testimony, never truth.
 *
 * Amounts at this boundary are NAIRA as spoken by humans ("40k" already
 * normalised to 40000 by the parser). Conversion to integer kobo happens in
 * exactly one place: @rekoda/core's money engine.
 *
 * Customer references are pseudonymous tokens (CUSTOMER_X81) or raw
 * unresolved mention strings for the privacy gateway to resolve — never
 * phone numbers or emails, which the gateway strips before the AI call.
 */
import { z } from 'zod';

/* ── shared fragments ── */

const naira = z.number().finite().nonnegative().max(10_000_000_000); // ₦10bn cap: injection ceiling
const quantity = z.number().finite().positive().max(1_000_000);
const text = (max: number) => z.string().trim().min(1).max(max);

/** A customer as the AI may refer to one: resolved token or raw mention. */
export const CustomerRef = z.union([
  z.object({ kind: z.literal('token'), token: z.string().regex(/^CUSTOMER_[A-Z0-9]{2,12}$/) }),
  z.object({ kind: z.literal('mention'), mention: text(80) }),
  z.object({ kind: z.literal('none') }),
]);
export type CustomerRef = z.infer<typeof CustomerRef>;

export const LineItem = z.object({
  name: text(120),
  quantity,
  unitPrice: naira,
});
export type LineItem = z.infer<typeof LineItem>;

export const PaymentMethod = z.enum(['cash', 'transfer', 'pos', 'unknown']);

/* ── the commands ── */

export const RecordSale = z.object({
  intent: z.literal('RecordSale'),
  customer: CustomerRef,
  items: z.array(LineItem).min(1).max(50),
  /** Total as STATED by the human, if they stated one. Testimony. */
  statedTotal: naira.nullable(),
  reportedPayment: naira.nullable(),
  paymentMethod: PaymentMethod,
  discount: naira.nullable(),
  deliveryFee: naira.nullable(),
  dueDescription: text(60).nullable(),
});

export const RecordPayment = z.object({
  intent: z.literal('RecordPayment'),
  customer: CustomerRef,
  amount: naira.nullable(),
  /** "paid half", "paid the rest" — resolved deterministically against the
   * customer's actual balance by core code, never by the model. */
  relativeAmount: z.enum(['half', 'remainder']).nullable(),
  documentRef: text(30).nullable(),
  paymentMethod: PaymentMethod,
});

export const RecordExpense = z.object({
  intent: z.literal('RecordExpense'),
  description: text(200),
  amount: naira,
  category: text(60).nullable(),
  paymentMethod: PaymentMethod,
});

export const RecordPurchase = z.object({
  intent: z.literal('RecordPurchase'),
  supplierMention: text(80).nullable(),
  description: text(200),
  amount: naira,
  reportedPayment: naira.nullable(),
});

export const AdjustInventory = z.object({
  intent: z.literal('AdjustInventory'),
  productMention: text(120),
  quantityDelta: z.number().finite().int().min(-1_000_000).max(1_000_000),
});

export const Query = z.object({
  intent: z.literal('Query'),
  topic: z.enum([
    'debtors',
    'customer_balance',
    'supplier_balances',
    'sales_summary',
    'expenses_summary',
    'unreconciled',
    'report_request',
  ]),
  customer: CustomerRef.nullable(),
  period: z.enum(['today', 'week', 'month', 'custom']).nullable(),
  periodText: text(60).nullable(),
  format: z.enum(['chat', 'pdf', 'excel']).nullable(),
});

export const Unclear = z.object({
  intent: z.literal('Unclear'),
  /** What the model needs to know — surfaced to the human as ONE question. */
  clarification: text(300),
});

export const StructuredBusinessCommand = z.discriminatedUnion('intent', [
  RecordSale,
  RecordPayment,
  RecordExpense,
  RecordPurchase,
  AdjustInventory,
  Query,
  Unclear,
]);
export type StructuredBusinessCommand = z.infer<typeof StructuredBusinessCommand>;

/**
 * Parse an untrusted model response. Never throws — a malformed model
 * output is an operational event, not an exception path.
 */
export function parseBusinessCommand(
  raw: unknown,
): { ok: true; command: StructuredBusinessCommand } | { ok: false; error: string } {
  const result = StructuredBusinessCommand.safeParse(raw);
  return result.success
    ? { ok: true, command: result.data }
    : {
        ok: false,
        error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
}

/**
 * The same schema, as JSON Schema, for the model's tool definition.
 *
 * Generated from `StructuredBusinessCommand` rather than hand-written, so the
 * shape the model is asked to fill and the shape `parseBusinessCommand`
 * accepts cannot drift apart. That drift is the expensive kind: the model
 * produces something plausible, validation rejects it, and the merchant gets a
 * clarifying question for a message that was perfectly clear.
 *
 * The ₦10bn ceiling travels with it. A transcript saying "record a ₦900bn
 * sale" is then refused twice — once by constrained decoding that cannot emit
 * a number above `maximum`, and again by the parser if it somehow does.
 */
export function businessCommandToolSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object({ command: StructuredBusinessCommand })) as Record<
    string,
    unknown
  >;
  return anyOfInsteadOfOneOf(schema);
}

/**
 * zod emits `oneOf` for a discriminated union. Both are valid, but `anyOf` is
 * the better-supported form in tool schemas, and the two are equivalent here:
 * the branches are discriminated by a literal `intent`, so at most one can
 * ever match.
 */
function anyOfInsteadOfOneOf(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) return node.map(anyOfInsteadOfOneOf) as never;
  if (typeof node !== 'object' || node === null) return node as never;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key === 'oneOf' ? 'anyOf' : key] = anyOfInsteadOfOneOf(value);
  }
  return out;
}
