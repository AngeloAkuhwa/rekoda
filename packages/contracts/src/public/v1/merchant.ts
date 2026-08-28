/**
 * The Merchant API, v1 (canonical spec §27).
 *
 * What a program may read and write on behalf of the business whose key it
 * holds. Three rules shape every schema here:
 *
 * **Money is integer kobo.** A program sends and receives minor units; the
 * float that would otherwise arrive is the bug this avoids. `computeMoney`
 * still does the arithmetic — the API has a kobo door into it, not a second
 * engine.
 *
 * **A customer is a pseudonym.** `customers` in the database holds a token
 * and nothing else; names and phones live encrypted, one facet per row
 * (spec §39). A partner integration is not a reason to turn this into a PII
 * export, so no identity facet has a field here.
 *
 * **No column travels verbatim.** `sourceType`, `docHash`, `snapshotJson`
 * and every other internal are absent, not renamed. What is here is what a
 * caller needs to act, and the frozen shape test says so.
 */
import { z } from 'zod';

const kobo = z.number().int().finite().nonnegative();
const isoDate = z.string().datetime({ offset: true });

/* ─────────────────────────────── reads ─────────────────────────────── */

export const merchantCustomer = z.object({
  id: z.string().uuid(),
  /** The pseudonym the merchant's own books use. Never a name. */
  token: z.string(),
  createdAt: isoDate,
});
export type MerchantCustomer = z.infer<typeof merchantCustomer>;

export const merchantProduct = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /** Null when the merchant has not priced it. Not zero: those differ. */
  unitPriceK: kobo.nullable(),
  active: z.boolean(),
  createdAt: isoDate,
});
export type MerchantProduct = z.infer<typeof merchantProduct>;

export const INVOICE_STATUSES = ['issued', 'partially_paid', 'paid', 'voided'] as const;

export const merchantInvoice = z.object({
  id: z.string().uuid(),
  invoiceNumber: z.string(),
  customerId: z.string().uuid().nullable(),
  status: z.enum(INVOICE_STATUSES),
  totalK: kobo,
  paidK: kobo,
  balanceDueK: kobo,
  currency: z.string(),
  dueDate: isoDate.nullable(),
  issuedAt: isoDate,
});
export type MerchantInvoice = z.infer<typeof merchantInvoice>;

/* ─────────────────────────────── writes ────────────────────────────── */

export const merchantSaleItem = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().positive().finite(),
  unitPriceK: kobo,
});

export const recordSaleRequest = z.object({
  items: z.array(merchantSaleItem).min(1).max(50),
  /** The customer this is for, when the caller knows. */
  customerId: z.string().uuid().nullish(),
  discountK: kobo.optional(),
  deliveryFeeK: kobo.optional(),
  vatK: kobo.optional(),
  /** Already handed over. May exceed the total; an overpayment is a fact. */
  amountPaidK: kobo.optional(),
  method: z.enum(['cash', 'transfer']).optional(),
  dueDate: isoDate.nullish(),
});
export type RecordSaleRequest = z.infer<typeof recordSaleRequest>;

export const recordSaleResponse = z.object({
  invoiceId: z.string().uuid(),
  invoiceNumber: z.string(),
  totalK: kobo,
  balanceDueK: kobo,
});
export type RecordSaleResponse = z.infer<typeof recordSaleResponse>;

export const recordPaymentRequest = z.object({
  /** The invoice as the merchant knows it: its number, not an internal id. */
  invoiceNumber: z.string().trim().min(1),
  amountK: kobo.refine((value) => value > 0, 'an amount above zero'),
  method: z.enum(['cash', 'transfer']).optional(),
  /** The caller's own reference for this payment, carried into the record. */
  reference: z.string().trim().min(1).max(120).nullish(),
});
export type RecordPaymentRequest = z.infer<typeof recordPaymentRequest>;

/**
 * Every outcome of recording a payment, named.
 *
 * A refusal is a 200 with an outcome rather than an error, because none of
 * these is the caller doing something wrong: the invoice was already
 * settled, or somebody else paid part of it between the read and the write.
 * A client handles all four; an error envelope would push two of them into a
 * catch block where they read as failures.
 */
export const recordPaymentResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('recorded'),
    receiptNumber: z.string(),
    invoiceNumber: z.string(),
    amountK: kobo,
    balanceDueK: kobo,
    invoiceStatus: z.enum(INVOICE_STATUSES),
  }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('already_settled'), invoiceNumber: z.string() }),
  z.object({
    outcome: z.literal('balance_moved'),
    invoiceNumber: z.string(),
    balanceDueK: kobo,
    excessK: kobo,
  }),
]);
export type RecordPaymentResponse = z.infer<typeof recordPaymentResponse>;

/** The header a caller sends to make a write safe to retry. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
