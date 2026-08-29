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
import { outboxRepo, spendRepo, stockRepo, type TenantDb } from '@rekoda/db';

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

export async function recordPurchaseWork(
  tx: TenantDb,
  input: RecordPurchaseCmdInput,
): Promise<RecordedPurchase> {
  const recorded = await spendRepo.recordPurchase(tx, {
    businessId: input.businessId,
    description: input.description,
    amountK: input.amountK,
    paidK: input.paidK,
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
