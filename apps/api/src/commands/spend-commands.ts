/**
 * The spend commands (spec §25; PR-023): `RecordExpense`, `RecordPurchase`.
 *
 * Same pattern as PR-021/022: the work an ingress held inline, moved to the
 * one place every front door converges; both flag positions call the same
 * function, so the flag decides which gates run and never what money out is.
 *
 * `RecordExpense` arrives from chat and from the recurring sweep; the sweep
 * is an ingress too (AUTOMATION), and it converging here is exactly §25's
 * point — a standing order must not have a cheaper path to the ledger than
 * a sentence does. `RecordPurchase` arrives from chat and from a received
 * purchase order, and carries its deliveries: goods counted in the SAME
 * transaction as the money, so a shop can never hold the payment without
 * the stock.
 */
import {
  PURCHASE_IDENTITY_WINDOW_SECONDS,
  purchaseMatches,
  type PurchaseFacts,
  type PurchaseRecord,
} from '@rekoda/core';

const windowStart = (at: Date) => new Date(at.getTime() - PURCHASE_IDENTITY_WINDOW_SECONDS * 1000);
import { outboxRepo, purchaseIdentityRepo, spendRepo, stockRepo, type TenantDb } from '@rekoda/db';

export type RecordExpenseCmdInput = Parameters<typeof spendRepo.recordExpense>[1];

export interface RecordedExpense {
  expenseId: string;
  ledgerTransactionId: string;
}

export async function recordExpenseWork(
  tx: TenantDb,
  input: RecordExpenseCmdInput,
): Promise<RecordedExpense> {
  const recorded = await spendRepo.recordExpense(tx, input);

  /* The description stays OUT of the event: a merchant's sentence about
   * money routinely names a person, and the announcement needs the fact,
   * not the prose — a consumer that wants detail asks the record. */
  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'expense.recorded',
    payload: {
      expenseId: recorded.expenseId,
      amountK: input.amountK,
      category: input.category,
      sourceType: input.sourceType,
    },
  });

  return { expenseId: recorded.expenseId, ledgerTransactionId: recorded.ledgerTransactionId };
}

export interface PurchaseArrival {
  /** The product's name or mention — resolved to a row inside the work. */
  product: string;
  quantity: number;
  /** What this arrival moves the product's reckoned cost by. */
  costK: number;
}

export interface RecordPurchaseCmdInput {
  businessId: string;
  description: string;
  amountK: number;
  /** What the merchant says they have paid so far. */
  paidK: number;
  /** The account the paid part left, stated by the merchant (G-61). Null
   * only when nothing was paid; the repository refuses it otherwise. */
  method: 'cash' | 'transfer' | null;
  sourceType: string;
  sourceId: string;
  /** The vaulted supplier reference (migration 0050), never a name. */
  supplierId?: string | null;
  /**
   * The goods that arrived with the money, when the merchant counted them.
   * Empty is honest and common: inferring a quantity from an amount would
   * put a stock count in the books that nobody took.
   */
  arrivals: readonly PurchaseArrival[];
}

export interface RecordedPurchase {
  expenseId: string;
  /** What remains owed to the supplier. */
  owedK: number;
  /** What landed on the shelf, with the count AFTER this delivery. */
  arrived: { name: string; onHand: number }[];
}

/**
 * A chat purchase refused BEFORE anything was written (G-81, OD-23): a
 * purchase of the same total that nothing proves separate was booked in
 * the last 24 hours. Carries the record it matched, as opaque ids, a total
 * and a time, so the caller can ask the merchant "same or separate"; it
 * never carries, and nothing logs, a fingerprint.
 */
export class PurchaseIdentityCollision extends Error {
  override readonly name = 'PurchaseIdentityCollision';
  constructor(readonly match: PurchaseRecord) {
    super('a purchase of the same total was booked since this one was previewed');
  }
}

/**
 * The final net against one purchase becoming two financial truths (G-81),
 * in the WORK, so it holds whichever caller and whichever connection: a
 * chat purchase takes the business's lock for its total, then re-reads what
 * is booked, and refuses before the first posting if one may be this one.
 * Two confirmations of one purchase on two connections therefore book it
 * once; the second sees the first's booking because it reads after the
 * first commits. A received purchase order is its own document and is not
 * compared here.
 */
async function refuseBookedDuplicate(tx: TenantDb, input: RecordPurchaseCmdInput): Promise<void> {
  if (input.sourceType !== 'chat') return;
  await purchaseIdentityRepo.lockPurchaseTotal(tx, input.businessId, input.amountK);
  const drafted = await purchaseIdentityRepo.draftFacts(tx, input.businessId, input.sourceId);
  /* Every booking from 24 hours before this purchase's own message ONWARD,
   * with no upper bound: a yes retried a day later still sees a competing
   * booking made since its preview (Codex review). */
  const { now, records } = await purchaseIdentityRepo.purchaseRecords(
    tx,
    input.businessId,
    input.amountK,
    {
      excludeDraftId: input.sourceId,
      bookedOnly: true,
      ...(drafted ? { bookedSince: windowStart(drafted.at) } : {}),
    },
  );
  if (records.length === 0) return;
  /* No readable draft behind it: nothing can prove it separate, so it is
   * compared on its total alone, the conservative reading. */
  const self: PurchaseFacts = drafted
    ? { ...drafted, amountK: input.amountK }
    : {
        amountK: input.amountK,
        at: now,
        product: null,
        reference: null,
        separateFrom: [],
        self: { draftId: null, expenseId: null },
      };
  const [match] = purchaseMatches(self, records, now, {
    from: windowStart(self.at),
    to: null,
  });
  if (match) throw new PurchaseIdentityCollision(match);
}

export async function recordPurchaseWork(
  tx: TenantDb,
  input: RecordPurchaseCmdInput,
): Promise<RecordedPurchase> {
  await refuseBookedDuplicate(tx, input);
  const recorded = await spendRepo.recordPurchase(tx, {
    businessId: input.businessId,
    description: input.description,
    amountK: input.amountK,
    paidK: input.paidK,
    method: input.method,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    supplierId: input.supplierId ?? null,
  });

  const arrived: { name: string; onHand: number }[] = [];
  for (const arrival of input.arrivals) {
    const product = await stockRepo.findOrCreateProduct(tx, input.businessId, arrival.product);
    await stockRepo.recordDelivery(tx, {
      businessId: input.businessId,
      product,
      quantity: arrival.quantity,
      costK: arrival.costK,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
    arrived.push({ name: product.name, onHand: product.onHand + arrival.quantity });
  }

  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'purchase.recorded',
    payload: {
      expenseId: recorded.expenseId,
      amountK: input.amountK,
      paidK: input.paidK,
      owedK: recorded.owedK,
      arrivals: arrived.length,
      sourceType: input.sourceType,
    },
  });

  return { expenseId: recorded.expenseId, owedK: recorded.owedK, arrived };
}
