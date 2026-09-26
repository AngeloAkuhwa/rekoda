/**
 * The durable marks a MERCHANT-ATTESTED overpayment leaves (G-49, OWN-16).
 *
 * Shared by the two merchant writers that can now take more than an invoice
 * owes: a sale paid over at issue (`issue.ts`) and a later payment the
 * merchant confirmed as an overpayment (`settle.ts`). It lives in its own
 * module because `settle.ts` imports `issue.ts`, so neither can host code
 * the other needs without a cycle.
 *
 * It writes no money. The payment, its allocation (capped at the balance),
 * the receipt and the posting that credits CUSTOMER_CREDIT with the excess
 * all belong to the caller, in the same transaction. This adds only:
 *
 *   - the `overpaid` reconciliation row, ALWAYS, named customer or not. It is
 *     how `paymentWasOverpaid` recognises an overpaid payment, and the refund,
 *     reversal and chargeback guards rely on it. Same meaning as the provider
 *     path's row: expectation = the invoice, status EXCEPTION (a human may
 *     want to act on the excess), outstanding = minus the excess;
 *   - the customer-credit subledger grant, ONLY when the invoice has a
 *     customer. Keyed on the payment id, so one payment owes one credit
 *     however often a caller reaches here. With no customer the ledger still
 *     carries the liability, and no customer is invented to hold it.
 *
 * Merchant money never goes through the provider writer: this is testimony,
 * recorded in Cash or Bank, not money a provider confirmed.
 */
import type { TenantDb } from '../client.js';
import { reconciliations } from '../schema/finance.js';
import { grantCustomerCredit } from './customer-credits.js';

export type ExcessDisposition = 'customer_credit' | 'unattributed';

/** Where the excess goes, decided by whether the invoice names a customer. */
export function excessDispositionFor(customerId: string | null): ExcessDisposition {
  return customerId ? 'customer_credit' : 'unattributed';
}

export async function markMerchantOverpayment(
  tx: TenantDb,
  input: {
    businessId: string;
    invoiceId: string;
    invoiceNumber: string;
    paymentId: string;
    customerId: string | null;
    /** The whole payment, as received. */
    receivedK: number;
    /** What went beyond the balance: the credit, or the unattributed excess. */
    excessK: number;
  },
): Promise<ExcessDisposition> {
  if (!Number.isSafeInteger(input.excessK) || input.excessK <= 0) {
    throw new Error('markMerchantOverpayment: an overpayment needs a positive integer excess');
  }

  await tx.insert(reconciliations).values({
    businessId: input.businessId,
    status: 'EXCEPTION',
    reason: 'overpaid',
    expectationKind: 'invoice',
    expectationId: input.invoiceId,
    paymentId: input.paymentId,
    amountK: input.receivedK,
    outstandingK: -input.excessK,
  });

  if (input.customerId) {
    await grantCustomerCredit(tx, {
      businessId: input.businessId,
      customerId: input.customerId,
      amountMinor: input.excessK,
      sourceType: 'overpayment',
      sourceId: input.paymentId,
      reason: `Paid over on ${input.invoiceNumber}`,
    });
  }
  return excessDispositionFor(input.customerId);
}
