/**
 * Money going OUT: expenses and stock purchases (MASTER-PLAN §5.3.5).
 *
 * Same discipline as `issueSale`, scaled to a smaller moment: the operational
 * row and its balanced posting commit in ONE transaction or not at all. There
 * is no document here — an expense has no customer to hand paper to — so the
 * chain ends at the ledger instead of continuing into render/deliver.
 *
 * Both writes land in the `expenses` table. The LEDGER is what distinguishes
 * them (ADR 0004): an expense debits EXPENSES, a purchase debits INVENTORY,
 * and a purchase partly on credit carries the remainder to ACCOUNTS_PAYABLE.
 * A separate purchases table would duplicate the row shape to encode a fact
 * the posting already states.
 *
 * What is deliberately NOT stored: the supplier's name. A supplier mention is
 * a person or shop name, and names live in the identity vault or nowhere.
 * Supplier records (with encrypted facets, like customers) are a later slice;
 * until then the mention appears in the CG2 preview the merchant confirms and
 * is dropped at this boundary.
 */
import { eq } from 'drizzle-orm';
import { postExpense, postPurchase } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { expenses } from '../schema/finance.js';
import { writePosting } from './issue.js';

export interface RecordExpenseInput {
  businessId: string;
  description: string;
  category: string | null;
  amountK: number;
  /** Already normalised to the ledger's cash|transfer by the caller. */
  method: 'cash' | 'transfer';
  sourceType: string;
  sourceId: string;
}

export interface RecordPurchaseInput {
  businessId: string;
  description: string;
  amountK: number;
  /** What the merchant says they have paid so far. */
  paidK: number;
  sourceType: string;
  sourceId: string;
}

export interface RecordedSpend {
  expenseId: string;
  ledgerTransactionId: string;
  /** For purchases: what remains owed to the supplier. Always 0 for expenses. */
  owedK: number;
}

export async function recordExpense(
  tx: TenantDb,
  input: RecordExpenseInput,
): Promise<RecordedSpend> {
  const rows = await tx
    .insert(expenses)
    .values({
      businessId: input.businessId,
      description: input.description,
      category: input.category,
      amountK: input.amountK,
      method: input.method,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    })
    .returning({ id: expenses.id });
  const row = rows[0];
  if (!row) throw new Error('recordExpense: insert returned no row');

  const posting = postExpense({
    memo: `Expense: ${input.description}`,
    amountK: input.amountK,
    method: input.method,
  });
  const ledgerTransactionId = await writePosting(
    tx,
    input.businessId,
    posting,
    input.sourceType,
    input.sourceId,
  );

  return { expenseId: row.id, ledgerTransactionId, owedK: 0 };
}

export async function recordPurchase(
  tx: TenantDb,
  input: RecordPurchaseInput,
): Promise<RecordedSpend> {
  const rows = await tx
    .insert(expenses)
    .values({
      businessId: input.businessId,
      description: input.description,
      /** The fixed marker the read layer filters on — not merchant testimony. */
      category: 'stock',
      amountK: input.amountK,
      /* The contract carries no method for purchases yet; 'cash' is the
       * honest default for money out of pocket that no provider tracks. */
      method: 'cash',
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    })
    .returning({ id: expenses.id });
  const row = rows[0];
  if (!row) throw new Error('recordPurchase: insert returned no row');

  const posting = postPurchase({
    memo: `Stock: ${input.description}`,
    amountK: input.amountK,
    paidK: input.paidK,
    method: 'cash',
  });
  const ledgerTransactionId = await writePosting(
    tx,
    input.businessId,
    posting,
    input.sourceType,
    input.sourceId,
  );

  return { expenseId: row.id, ledgerTransactionId, owedK: input.amountK - input.paidK };
}

/* ── read-backs (tests and, later, the dashboard's expense list) ─────────── */

export interface ExpenseReadback {
  description: string;
  category: string | null;
  amountK: number;
  method: string;
}

export async function expensesFor(tx: TenantDb, businessId: string): Promise<ExpenseReadback[]> {
  return tx
    .select({
      description: expenses.description,
      category: expenses.category,
      amountK: expenses.amountK,
      method: expenses.method,
    })
    .from(expenses)
    .where(eq(expenses.businessId, businessId))
    .orderBy(expenses.createdAt);
}
