/**
 * Which entitlement each command needs (spec §25, §4.1).
 *
 * A sibling of `@rekoda/core`'s risk table and deliberately separate from it.
 * Risk tier answers "what does this demand before it acts"; this answers "may
 * this business do it at all". They are different questions with different
 * answers, and one table holding both would make a command that needs neither
 * indistinguishable from one nobody classified.
 *
 * `null` means the command needs no product entitlement. That is not a gap:
 * the dashboard is a shared control plane (spec §3.2a), so recording a sale
 * by hand belongs to every paid plan. What Chat sells is the conversational
 * way in, and that is gated where the conversation is.
 */
import type { EntitlementKey } from '@rekoda/core';
import { COMMAND_RISK } from '@rekoda/core';

export type CommandName = keyof typeof COMMAND_RISK;

export const COMMAND_ENTITLEMENT: Record<CommandName, EntitlementKey | null> = {
  /* Reads. Never gated: a merchant's own books are their own books. */
  Query: null,
  ReadReport: null,
  ReadStatement: null,
  ListInvoices: null,
  ReadCustomerBalance: null,
  ReadStock: null,
  Unclear: null,

  /* The shared control plane. Manual bookkeeping is every plan's (§3.2a). */
  RecordSale: null,
  RecordPayment: null,
  RecordExpense: null,
  RecordPurchase: null,
  IssueInvoice: null,
  CreatePaymentIntent: null,
  ConfirmPayment: null,
  AllocatePayment: null,
  RecordPaymentEvidence: null,
  IngestFinancialTransaction: null,
  AdjustInventory: null,
  ConfirmReconciliation: null,
  PostJournal: null,
  ClosePeriod: null,
  DeactivateAccount: null,
  ChangePaymentConnection: null,
  RefundPayment: null,
  VoidReceipt: null,
  RevokePaymentVerification: null,
  ReopenAccountingPeriod: null,
  EraseData: null,
  ChangePostingAccountPolicy: null,
  DisconnectPaymentConnection: null,
  ChangePaymentConnectionCredential: null,
  ChangePaymentConnectionProvider: null,

  /* The customer's side of the merchant's commerce. */
  RecordOrder: 'REKODA_INTEGRATE',
  PlaceOrder: 'REKODA_INTEGRATE',
};
