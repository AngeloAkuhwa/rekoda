/**
 * `RecordSale` and `IssueInvoice` — the first two of spec §25's fourteen
 * commands (PR-021).
 *
 * Each is the financial work an ingress used to hold inline, moved to the
 * one place every front door converges. The functions here are the WORK; the
 * gates around them (entitlement → risk → idempotency) are `CommandBus.run`,
 * and the rollout flag decides whether an ingress calls the bus or calls the
 * work directly — the same function either way, so a flag flip changes which
 * gates run and never what a sale is.
 *
 * Both append their outbox event INSIDE the caller's transaction (spec §26),
 * unconditionally: the announcement of a fact is part of the fact, not part
 * of the rollout. A consumer that arrives later (webhooks, PR-112) replays
 * nothing and misses nothing from the day it subscribes.
 */
import { issueRepo, jobsRepo, ordersRepo, outboxRepo, stockRepo, type TenantDb } from '@rekoda/db';
import { postCostOfSale } from '@rekoda/core';

/** The work's answer, and the idempotency snapshot: JSON scalars only, so a
 * replay hands back exactly what the first run answered. */
export interface RecordedSale {
  invoiceId: string;
  invoiceNumber: string;
  totalK: number;
  balanceDueK: number;
  paymentId: string | null;
}

export type RecordSaleInput = Parameters<typeof issueRepo.issueSale>[1];

/**
 * A sale the merchant told us about: the invoice, its paper, the stock it
 * took off the shelf and what those goods cost, in one transaction — exactly
 * the block the chat handler carried inline, moved here unchanged.
 */
export async function recordSaleWork(tx: TenantDb, input: RecordSaleInput): Promise<RecordedSale> {
  const issued = await issueRepo.issueSale(tx, input);

  /* The invoice and "render its PDF" commit together (MASTER-PLAN §5.3.5
   * step 9): no window where a document exists that nothing will produce
   * paper for, and a rollback takes the job with it. The singleton key is
   * the invoice id, so a re-enqueue cannot mint two PDFs for one sale. */
  await jobsRepo.enqueue(tx, {
    businessId: input.businessId,
    kind: 'document.render',
    payload: { invoiceId: issued.invoiceId },
    singletonKey: issued.invoiceId,
  });

  /* Stock off the shelf in the same transaction, only for lines naming
   * something the shop already counts; then what those goods cost, as a
   * second posting, because a sale is exact and its cost is an estimate. */
  const moved = await stockRepo.recordSaleMovements(
    tx,
    input.businessId,
    input.items,
    issued.invoiceNumber,
  );
  await postCostOfGoods(tx, input.businessId, issued.invoiceNumber, moved);

  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'sale.recorded',
    payload: {
      invoiceId: issued.invoiceId,
      invoiceNumber: issued.invoiceNumber,
      totalK: input.totalK,
      paidK: input.paidK,
      balanceDueK: input.balanceDueK,
      sourceType: input.sourceType,
    },
  });

  return {
    invoiceId: issued.invoiceId,
    invoiceNumber: issued.invoiceNumber,
    totalK: input.totalK,
    balanceDueK: input.balanceDueK,
    paymentId: issued.paymentId,
  };
}

/** The losing side of a convert race. The winner's invoice is the answer. */
export class QuoteAlreadyTaken extends Error {
  override readonly name = 'QuoteAlreadyTaken';
  constructor() {
    super('quote already converted');
  }
}

export interface IssueInvoiceInput {
  businessId: string;
  /** The accepted quote this invoice honours. */
  quoteId: string;
  customerId: string | null;
  items: readonly { name: string; quantity: number; unitPriceK: number }[];
  totalK: number;
  dueDate: Date | null;
  actor: string;
}

export interface IssuedInvoice {
  invoiceId: string;
  invoiceNumber: string;
  totalK: number;
}

/**
 * Accepting a quote is issuing the invoice it promised, on the exact path a
 * confirmed chat order takes: invoice, quote attached in the same statement,
 * render, payable link, stock movements, cost of goods. A loser in the
 * convert race throws `QuoteAlreadyTaken`, which rolls the whole issue back
 * — including the idempotency claim and the outbox event, because they ride
 * the same transaction — and the caller answers with the winner's invoice.
 */
export async function issueInvoiceWork(
  tx: TenantDb,
  input: IssueInvoiceInput,
): Promise<IssuedInvoice> {
  const issued = await issueRepo.issueSale(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    customerToken: null,
    items: input.items,
    subtotalK: input.totalK,
    discountK: 0,
    deliveryFeeK: 0,
    vatK: 0,
    totalK: input.totalK,
    paidK: 0,
    balanceDueK: input.totalK,
    method: 'transfer',
    sourceType: 'quote',
    sourceId: input.quoteId,
    saleSource: null,
    dueDate: input.dueDate,
    actor: input.actor,
  });

  /* The same statement that confirms attaches the invoice; a loser rolls
   * everything back rather than minting a second invoice for one quote. */
  const marked = await ordersRepo.markOrder(
    tx,
    input.businessId,
    input.quoteId,
    'quoted',
    'confirmed',
    issued.invoiceId,
  );
  if (marked !== 'marked') throw new QuoteAlreadyTaken();

  await jobsRepo.enqueue(tx, {
    businessId: input.businessId,
    kind: 'document.render',
    payload: { invoiceId: issued.invoiceId },
    singletonKey: issued.invoiceId,
  });
  await jobsRepo.enqueue(tx, {
    businessId: input.businessId,
    kind: 'payment.link',
    payload: { invoiceId: issued.invoiceId },
    singletonKey: `link:${issued.invoiceId}`,
  });

  const moved = await stockRepo.recordSaleMovements(
    tx,
    input.businessId,
    input.items,
    issued.invoiceNumber,
  );
  await postCostOfGoods(tx, input.businessId, issued.invoiceNumber, moved);

  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'invoice.issued',
    payload: {
      invoiceId: issued.invoiceId,
      invoiceNumber: issued.invoiceNumber,
      totalK: input.totalK,
      quoteId: input.quoteId,
    },
  });

  return {
    invoiceId: issued.invoiceId,
    invoiceNumber: issued.invoiceNumber,
    totalK: input.totalK,
  };
}

/**
 * What the goods a sale took off the shelf cost. A second posting beside the
 * sale, in the same transaction, and the separation is the point: a sale is
 * a fact about money and is known exactly; what the goods cost is an
 * estimate from a costing method. Nothing is written when nothing that moved
 * had a cost — which is not the same as the goods having been free.
 */
async function postCostOfGoods(
  tx: TenantDb,
  businessId: string,
  invoiceNumber: string,
  movements: { costK: number },
): Promise<void> {
  if (movements.costK <= 0) return;
  await issueRepo.writePosting(
    tx,
    businessId,
    postCostOfSale({ memo: `Cost of goods on ${invoiceNumber}`, costK: movements.costK }),
    'invoice',
    invoiceNumber,
  );
}

/* ── VoidReceipt (Appendix D.2: a document already given to a customer) ── */

export interface VoidReceiptInput {
  businessId: string;
  invoiceNumber: string;
  /** Goes on the record, so the gap in the numbering is explained. */
  reason: string;
  actor: string;
}

export type VoidReceiptResult = Awaited<ReturnType<typeof issueRepo.voidInvoice>>;

/**
 * Withdraw a document a customer may already hold. HIGH_RISK, so the
 * dashboard runs Appendix D's two-step around this work; the refusals
 * (`not_found`, `already_void`, `has_payments`) are outcomes that write
 * nothing, and the announcement carries the number and the reversed amount
 * — never the reason, which is merchant prose.
 */
export async function voidReceiptWork(
  tx: TenantDb,
  input: VoidReceiptInput,
): Promise<VoidReceiptResult> {
  const outcome = await issueRepo.voidInvoice(
    tx,
    input.businessId,
    input.invoiceNumber,
    input.reason,
    input.actor,
  );

  if (outcome.outcome === 'voided') {
    await outboxRepo.append(tx, {
      businessId: input.businessId,
      type: 'invoice.voided',
      payload: { invoiceNumber: outcome.invoiceNumber, reversedK: outcome.reversedK },
    });
  }

  return outcome;
}
