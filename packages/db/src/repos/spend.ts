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
import { and, eq, sql } from 'drizzle-orm';
import {
  isAccountKey,
  postExpense,
  postPurchase,
  reversal,
  type LedgerLine,
  type Posting,
} from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { auditEvents } from '../schema/ops.js';
import { expenses, ledgerEntries } from '../schema/finance.js';
import { inventoryMovements } from '../schema/commerce.js';
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
  /* The posting first, so the row can carry its id and a withdrawal has
   * something exact to reverse. Same transaction either way: the operational
   * row and its balanced posting still commit together or not at all. */
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
      ledgerTransactionId,
    })
    .returning({ id: expenses.id });
  const row = rows[0];
  if (!row) throw new Error('recordExpense: insert returned no row');

  return { expenseId: row.id, ledgerTransactionId, owedK: 0 };
}

export async function recordPurchase(
  tx: TenantDb,
  input: RecordPurchaseInput,
): Promise<RecordedSpend> {
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
      ledgerTransactionId,
    })
    .returning({ id: expenses.id });
  const row = rows[0];
  if (!row) throw new Error('recordPurchase: insert returned no row');

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
  /** Tenant-scoped and opaque. What a withdraw control posts back. */
  id: string;
  recordedAt: Date;
  description: string;
  category: string | null;
  amountK: number;
  method: string;
  /** What the posting did with the money: a cost, or stock on the shelf. */
  kind: 'expense' | 'purchase';
  /** recorded | voided. A voided row stays visible and stops counting. */
  status: string;
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
    id: string;
    description: string;
    category: string | null;
    amount_k: string;
    method: string;
    status: string;
    recorded_at: Date;
  }>(sql`
    SELECT id, description, category, amount_k::bigint AS amount_k, method, status,
           created_at AS recorded_at
    FROM expenses
    WHERE business_id = ${businessId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  /* Withdrawn entries stay on the page and stop counting. Both halves matter:
   * dropping the row would leave a merchant wondering where their entry went,
   * and counting it would leave the totals describing a cost they reversed. */
  const totals = await tx.execute<{ n: number; expenses_k: string; purchases_k: string }>(sql`
    SELECT count(*)::int AS n,
           COALESCE(SUM(amount_k) FILTER (
             WHERE category IS DISTINCT FROM 'stock' AND status = 'recorded'), 0)::bigint
             AS expenses_k,
           COALESCE(SUM(amount_k) FILTER (
             WHERE category = 'stock' AND status = 'recorded'), 0)::bigint AS purchases_k
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
      id: r.id,
      description: r.description,
      category: r.category,
      amountK: Number(r.amount_k),
      method: r.method,
      kind: r.category === 'stock' ? ('purchase' as const) : ('expense' as const),
      status: r.status,
      recordedAt: new Date(r.recorded_at),
    })),
    count: t?.n ?? 0,
    expensesK: Number(t?.expenses_k ?? 0),
    purchasesK: Number(t?.purchases_k ?? 0),
    payableK: Number([...payable][0]?.payable_k ?? 0),
  };
}

/* ── withdrawing an entry ────────────────────────────────────────────────── */

export type VoidSpendOutcome =
  | {
      outcome: 'voided';
      description: string;
      kind: 'expense' | 'purchase';
      reversedK: number;
      /**
       * True when this entry also brought stock in and that count has NOT
       * been touched. The money is a bookkeeping fact and can be mirrored;
       * what is on the shelf is a physical fact and only a merchant knows it.
       */
      stockUnchanged: boolean;
    }
  | { outcome: 'not_found' }
  | { outcome: 'already_void' }
  /** Recorded before the posting link existed, so nothing safe to reverse. */
  | { outcome: 'no_posting' };

/**
 * Withdraw a spend entry that should not have been recorded.
 *
 * The same instrument as `voidInvoice` and for the same reason: the ledger is
 * append-only, so the row stays, gets marked, and the books get the MIRROR of
 * what was written. An auditor sees an expense and its reversal, which is a
 * different story from an expense that never happened.
 *
 * The reversal is built from the ENTRIES that were actually written rather
 * than rebuilt from the row. A purchase's posting depends on how much was
 * paid at the time and the row has never stored that, so rebuilding would be
 * guessing at whatever went to ACCOUNTS_PAYABLE. The foreign key cannot drift
 * the way a memo match can.
 *
 * Stock is deliberately NOT reversed, and the outcome says so rather than
 * leaving it unsaid. A purchase that brought bales in may have been counted,
 * sold from, or corrected by hand since, and silently subtracting a delivery
 * would put a count in the shop's books that nobody took. `AdjustInventory`
 * is how a merchant fixes a count, and it is one sentence in chat.
 */
export async function voidExpense(
  tx: TenantDb,
  businessId: string,
  expenseId: string,
  reason: string,
  actor: string,
): Promise<VoidSpendOutcome> {
  const rows = await tx
    .select({
      id: expenses.id,
      description: expenses.description,
      category: expenses.category,
      amountK: expenses.amountK,
      status: expenses.status,
      sourceType: expenses.sourceType,
      sourceId: expenses.sourceId,
      ledgerTransactionId: expenses.ledgerTransactionId,
    })
    .from(expenses)
    .where(and(eq(expenses.businessId, businessId), eq(expenses.id, expenseId)))
    .limit(1);

  const entry = rows[0];
  if (!entry) return { outcome: 'not_found' };
  if (entry.status === 'voided') return { outcome: 'already_void' };
  if (!entry.ledgerTransactionId) return { outcome: 'no_posting' };

  const lines = await tx
    .select({
      account: ledgerEntries.account,
      debitK: ledgerEntries.debitK,
      creditK: ledgerEntries.creditK,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.businessId, businessId),
        eq(ledgerEntries.transactionId, entry.ledgerTransactionId),
      ),
    );
  /* An unknown account key would mean a write path bypassed the posting
   * builders. Reversing what we cannot name is worse than refusing. */
  const posted: LedgerLine[] = [];
  for (const l of lines) {
    if (!isAccountKey(l.account)) return { outcome: 'no_posting' };
    posted.push({ account: l.account, debitK: Number(l.debitK), creditK: Number(l.creditK) });
  }
  if (posted.length === 0) return { outcome: 'no_posting' };

  const kind = entry.category === 'stock' ? ('purchase' as const) : ('expense' as const);
  const label = kind === 'purchase' ? 'Stock' : 'Expense';
  const original: Posting = { memo: `${label}: ${entry.description}`, lines: posted };

  /*
   * Claim the row BEFORE writing anything to the ledger.
   *
   * `status = 'recorded'` in the WHERE is the mutual exclusion, and the order
   * is the whole of it. The status read above is a courtesy that gives a
   * merchant a sentence instead of a shrug; it settles nothing, because two
   * transactions both read `recorded` before either writes. Only this UPDATE
   * decides, so only its winner may post. Reversing first and claiming second
   * would leave the loser's reversal standing in an append-only ledger with
   * nothing to explain it, which is exactly the unexplained entry the void
   * exists to prevent.
   */
  const marked = await tx
    .update(expenses)
    .set({ status: 'voided' })
    .where(and(eq(expenses.id, entry.id), eq(expenses.status, 'recorded')))
    .returning({ id: expenses.id });
  if (marked.length !== 1) return { outcome: 'already_void' };

  await writePosting(
    tx,
    businessId,
    reversal(original, `Void ${label.toLowerCase()}: ${entry.description}`),
    entry.sourceType,
    entry.sourceId ?? entry.id,
  );

  await tx.insert(auditEvents).values({
    businessId,
    actor,
    entity: 'expense',
    entityId: entry.id,
    action: 'voided',
    newValue: { description: entry.description, kind } as never,
    reason,
    /* Where the merchant was standing, not what ran the code. All three
     * corrections - void an invoice, void a spend entry, credit an invoice -
     * are reachable only from the dashboard, and labelling them 'system' put
     * "Automatic" on the audit trail beside a change a person deliberately
     * made. */
    sourceType: 'dashboard',
  });

  /* Only a purchase can have brought stock in, and only one with a source to
   * match on. Asking without those two conditions would let an unrelated
   * movement answer for this entry, and a merchant told their count needs
   * checking when it does not is a merchant who stops reading the sentence. */
  const moved =
    kind === 'purchase' && entry.sourceId
      ? await tx
          .select({ id: inventoryMovements.id })
          .from(inventoryMovements)
          .where(
            and(
              eq(inventoryMovements.businessId, businessId),
              eq(inventoryMovements.reason, 'purchase'),
              eq(inventoryMovements.sourceType, entry.sourceType),
              eq(inventoryMovements.sourceId, entry.sourceId),
            ),
          )
          .limit(1)
      : [];

  return {
    outcome: 'voided',
    description: entry.description,
    kind,
    reversedK: Number(entry.amountK),
    stockUnchanged: moved.length > 0,
  };
}

/* ── what is owed, and for how long ──────────────────────────────────────── */

export interface PayableAgeing {
  /** Owed on something bought in the last 30 days. */
  d0_30K: number;
  d31_60K: number;
  d61_90K: number;
  d90PlusK: number;
  /** Everything owed, whatever its age. Equal to the buckets summed. */
  totalK: number;
}

/**
 * Accounts payable, aged (MASTER-PLAN §5.3.7).
 *
 * The receivable side has been aged since the debtors page shipped and this
 * side was one number, which left a merchant deciding who to pay this week
 * with no help from the half that costs them money.
 *
 * ── it ages differently, and the difference is not cosmetic ────────────────
 *
 * The receivable ages by how LATE a debt is, because an invoice carries a due
 * date the merchant agreed. A purchase carries no terms: Rekoda never asks a
 * supplier when they want paying, because it stores nothing about suppliers at
 * all. So this ages by how long the debt has STOOD, which is the honest
 * measure available and what an ageing report does when there are no terms.
 * Calling both "overdue" would be inventing a deadline nobody set.
 *
 * The amount owed comes from the LEDGER rather than the row. `expenses` stores
 * what a purchase cost and never what was paid on it, so the only place the
 * remainder exists is the ACCOUNTS_PAYABLE credit its posting wrote. Withdrawn
 * entries are excluded by their status, which is why their reversals need no
 * special handling here.
 */
export async function payableAgeingFor(
  tx: TenantDb,
  businessId: string,
  now = new Date(),
): Promise<PayableAgeing> {
  const rows = await tx.execute<{
    d0_30_k: string;
    d31_60_k: string;
    d61_90_k: string;
    d90_plus_k: string;
    total_k: string;
  }>(sql`
    WITH owed AS (
      SELECT
        SUM(le.credit_k - le.debit_k) AS owed_k,
        /* Lagos DATE on both sides, so this is integer day arithmetic: a
         * purchase made at 23:59 and read at 00:01 is one day old, not zero
         * point something. Same rule as the receivable ageing. */
        GREATEST(
          0,
          (${now.toISOString()}::timestamptz AT TIME ZONE 'Africa/Lagos')::date
            - (e.created_at AT TIME ZONE 'Africa/Lagos')::date
        ) AS days_owed
      FROM expenses e
      JOIN ledger_entries le
        ON le.transaction_id = e.ledger_transaction_id
       AND le.business_id = e.business_id
      WHERE e.business_id = ${businessId}::uuid
        AND e.status = 'recorded'
        AND le.account = 'ACCOUNTS_PAYABLE'
      GROUP BY e.id, e.created_at
      HAVING SUM(le.credit_k - le.debit_k) > 0
    )
    SELECT
      COALESCE(SUM(owed_k) FILTER (WHERE days_owed <= 30), 0)::bigint             AS d0_30_k,
      COALESCE(SUM(owed_k) FILTER (WHERE days_owed BETWEEN 31 AND 60), 0)::bigint AS d31_60_k,
      COALESCE(SUM(owed_k) FILTER (WHERE days_owed BETWEEN 61 AND 90), 0)::bigint AS d61_90_k,
      COALESCE(SUM(owed_k) FILTER (WHERE days_owed > 90), 0)::bigint              AS d90_plus_k,
      COALESCE(SUM(owed_k), 0)::bigint                                            AS total_k
    FROM owed
  `);
  const row = [...rows][0];
  return {
    d0_30K: Number(row?.d0_30_k ?? 0),
    d31_60K: Number(row?.d31_60_k ?? 0),
    d61_90K: Number(row?.d61_90_k ?? 0),
    d90PlusK: Number(row?.d90_plus_k ?? 0),
    totalK: Number(row?.total_k ?? 0),
  };
}
