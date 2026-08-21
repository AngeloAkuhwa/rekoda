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
import { eq, sql } from 'drizzle-orm';
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

/* ── the spend register (dashboard) ──────────────────────────────────────── */

export interface SpendRow {
  recordedAt: Date;
  description: string;
  category: string | null;
  amountK: number;
  method: string;
  /** What the posting did with the money: a cost, or stock on the shelf. */
  kind: 'expense' | 'purchase';
}

export interface SpendList {
  rows: SpendRow[];
  count: number;
  /** Operating expenses. This is the figure the profit and loss subtracts. */
  expensesK: number;
  /** Stock purchases, which are an asset swap and not yet a cost. */
  purchasesK: number;
  /**
   * What is still owed on stock taken but not fully paid for: the ACCOUNTS
   * PAYABLE balance, straight off the ledger. Not derivable from the rows
   * above, because a row carries what a purchase cost and not what is left
   * on it, and a spend page that could not answer "what do I still owe" is
   * not a spend page a supplier's call can be answered from.
   */
  payableK: number;
}

/**
 * Money out, newest first (MASTER-PLAN §5.3.7).
 *
 * Two totals, never one. An expense is gone; a stock purchase is still on the
 * shelf, and a register that added them into a single "spent" figure would
 * teach a merchant to read their own cost of trading wrong by exactly the
 * value of their inventory. The split is the same one the ledger already
 * makes — EXPENSES against INVENTORY — surfaced where somebody can see it.
 *
 * `category = 'stock'` is the marker `recordPurchase` writes, and the same
 * one the activity feed reads. No supplier column, because no supplier name
 * is stored: names live in the identity vault or nowhere.
 */
export async function spendFor(
  tx: TenantDb,
  businessId: string,
  limit: number,
): Promise<SpendList> {
  const rows = await tx.execute<{
    description: string;
    category: string | null;
    amount_k: string;
    method: string;
    recorded_at: Date;
  }>(sql`
    SELECT description, category, amount_k::bigint AS amount_k, method,
           created_at AS recorded_at
    FROM expenses
    WHERE business_id = ${businessId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  const totals = await tx.execute<{ n: number; expenses_k: string; purchases_k: string }>(sql`
    SELECT count(*)::int AS n,
           COALESCE(SUM(amount_k) FILTER (WHERE category IS DISTINCT FROM 'stock'), 0)::bigint
             AS expenses_k,
           COALESCE(SUM(amount_k) FILTER (WHERE category = 'stock'), 0)::bigint AS purchases_k
    FROM expenses
    WHERE business_id = ${businessId}::uuid
  `);
  const payable = await tx.execute<{ payable_k: string }>(sql`
    SELECT COALESCE(SUM(credit_k) - SUM(debit_k), 0)::bigint AS payable_k
    FROM ledger_entries
    WHERE business_id = ${businessId}::uuid AND account = 'ACCOUNTS_PAYABLE'
  `);
  const t = [...totals][0];
  return {
    rows: [...rows].map((r) => ({
      description: r.description,
      category: r.category,
      amountK: Number(r.amount_k),
      method: r.method,
      kind: r.category === 'stock' ? ('purchase' as const) : ('expense' as const),
      recordedAt: new Date(r.recorded_at),
    })),
    count: t?.n ?? 0,
    expensesK: Number(t?.expenses_k ?? 0),
    purchasesK: Number(t?.purchases_k ?? 0),
    payableK: Number([...payable][0]?.payable_k ?? 0),
  };
}
