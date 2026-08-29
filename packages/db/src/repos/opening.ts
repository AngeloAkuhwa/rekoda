/**
 * What the business was already holding on the day it started with Rekoda.
 *
 * One posting, once, and it is the only entry in the system that records
 * something which was already true rather than something that happened.
 *
 * There is no `opening_balances` table on purpose. The ledger already holds
 * the figures, and a second copy of them beside it would be a second answer
 * to the same question, free to drift. What the ledger cannot say on its own
 * is "only once", and migration 0032 says that with a partial unique index
 * rather than with a check the caller is trusted to make.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { postOpeningBalances, lagosNoon } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { auditEvents } from '../schema/ops.js';
import { invoices } from '../schema/finance.js';
import { customers } from '../schema/privacy.js';
import { codeOf } from './accounts.js';
import { nextDocumentNumber, writePosting } from './issue.js';
import { findOrCreateProduct, recordDelivery } from './stock.js';

/**
 * The source type the partial unique index keys on. Not a free string at the
 * call site, because the index and the writer agreeing is the whole of the
 * once-only guarantee.
 */
export const OPENING_SOURCE = 'opening';

/**
 * Thrown rather than returned, and the reason is the same one `TokenCollision`
 * records: a unique violation aborts the PostgreSQL transaction, so a caller
 * that catches it and returns an outcome normally fails at the COMMIT instead,
 * from somewhere with no context left to explain it. The classification
 * happens outside this transaction or not at all.
 */
export class OpeningBalancesAlreadySet extends Error {}

export interface OpeningStockLine {
  /** The product as the merchant calls it; created if the shop is new to it. */
  name: string;
  quantity: number;
  unitCostK: number;
}

export interface OpeningReceivable {
  /** Who owes it. An opening debt owed by nobody is not a receivable. */
  customerId: string;
  amountK: number;
  /** When it falls due, if the old books said. Never invented. */
  dueDate?: string | null | undefined;
}

export interface OpeningBalancesInput {
  businessId: string;
  /**
   * The day these figures were true, as `YYYY-MM-DD`.
   *
   * The merchant's own date, not today. Books opened "as at 31 July" put the
   * entry in July, so it becomes the opening balance of August rather than
   * appearing as money that arrived in August. Every balance-sheet account is
   * cumulative and would not care; the cash flow statement would, and would
   * report a merchant's existing till as income.
   */
  asAt: string;
  cashK: number;
  /**
   * The shelf as one figure, for a merchant who knows what their stock is
   * worth but not what it is. Mutually exclusive with `stock`: a value AND
   * itemised lines are two answers to one question, refused before writing.
   */
  bankK: number;
  stockK: number;
  /**
   * The shelf counted (PR-083): each line creates the product and its
   * opening movement at the stated unit cost, and the INVENTORY posting is
   * DERIVED from the same numbers — one statement, two books, no drift.
   */
  stock?: readonly OpeningStockLine[];
  /**
   * What customers already owed, as the invoices behind the figure. Each
   * line mints a real open invoice (numbered in the year it was true,
   * settleable by the same doors as any invoice), and the ledger's AR line
   * carries it as its §12.3 dimension — so the debtors page and the balance
   * sheet are the same rows. No VAT and no tax event: the tax point
   * belongs to the old books that issued the original.
   */
  receivables?: readonly OpeningReceivable[];
  actor: string;
}

export interface OpeningInvoiceMinted {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  amountK: number;
}

export interface OpeningBalancesRecorded {
  ledgerTransactionId: string;
  /** What went to owner's equity: everything held, by definition. */
  equityK: number;
  /** The shelf's value: stated, or derived from the counted lines. */
  stockValueK: number;
  /** The documents the opening receivables became. */
  invoices: OpeningInvoiceMinted[];
}

export async function recordOpeningBalances(
  tx: TenantDb,
  input: OpeningBalancesInput,
): Promise<OpeningBalancesRecorded> {
  const stockLines = input.stock ?? [];
  const receivables = input.receivables ?? [];
  if (input.stockK > 0 && stockLines.length > 0) {
    throw new RangeError('opening stock is a value or counted lines, never both');
  }
  for (const lineIn of stockLines) {
    if (!Number.isFinite(lineIn.quantity) || lineIn.quantity <= 0) {
      throw new RangeError('an opening stock line must count something');
    }
    if (!Number.isInteger(lineIn.unitCostK) || lineIn.unitCostK < 0) {
      throw new RangeError('an opening stock line needs a unit cost in kobo');
    }
  }

  /* The shelf: stated as one figure, or DERIVED from the counted lines so
   * the posting and the movements cannot disagree. */
  const stockValueK =
    stockLines.length > 0
      ? stockLines.reduce((sum, lineIn) => sum + Math.round(lineIn.quantity * lineIn.unitCostK), 0)
      : input.stockK;

  /* Every named debtor must be THIS business's customer. The FK alone is
   * global, so a foreign UUID would otherwise mint an invoice pointing at
   * somebody else's customer row; the tenant-scoped read refuses it here,
   * where the message can say so. */
  if (receivables.length > 0) {
    const wanted = [...new Set(receivables.map((r) => r.customerId))];
    const known = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.businessId, input.businessId), inArray(customers.id, wanted)));
    if (known.length !== wanted.length) {
      throw new RangeError('an opening receivable names a customer this business does not have');
    }
  }

  /* The documents first, inside the same transaction: if the posting below
   * finds the books already opened, every invoice minted here rolls back
   * with it. Numbered in the year the debt was true — a 2025 debt carries a
   * 2025 number, because the number is part of the document's identity. */
  const year = Number(input.asAt.slice(0, 4));
  const minted: OpeningInvoiceMinted[] = [];
  for (const r of receivables) {
    const invoiceNumber = await nextDocumentNumber(tx, input.businessId, 'invoice', year);
    const rows = await tx
      .insert(invoices)
      .values({
        businessId: input.businessId,
        customerId: r.customerId,
        invoiceNumber,
        status: 'issued',
        subtotalK: r.amountK,
        totalK: r.amountK,
        balanceDueK: r.amountK,
        vatK: 0,
        sourceType: OPENING_SOURCE,
        sourceId: input.asAt,
        dueDate: r.dueDate ? lagosNoon(r.dueDate) : null,
        issuedAt: lagosNoon(input.asAt),
      })
      .returning({ id: invoices.id });
    const row = rows[0];
    if (!row) throw new Error('recordOpeningBalances: invoice insert returned no row');
    minted.push({
      invoiceId: row.id,
      invoiceNumber,
      customerId: r.customerId,
      amountK: r.amountK,
    });
  }

  /* Throws RangeError on nothing at all and on a negative holding, before
   * anything is written. */
  const posting = postOpeningBalances({
    memo: `Opening balances as at ${input.asAt}`,
    cashK: input.cashK,
    bankK: input.bankK,
    stockK: stockValueK,
    receivables: minted.map((m) => ({ invoiceId: m.invoiceId, amountK: m.amountK })),
  });

  let ledgerTransactionId: string;
  try {
    ledgerTransactionId = await writePosting(
      tx,
      input.businessId,
      posting,
      OPENING_SOURCE,
      input.asAt,
      { occurredAt: lagosNoon(input.asAt) },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new OpeningBalancesAlreadySet('opening balances have already been recorded');
    }
    throw error;
  }

  /* The invoices point at the entry that raised their receivable, the same
   * lineage every issued invoice carries. */
  if (minted.length > 0) {
    await tx
      .update(invoices)
      .set({ ledgerTransactionId })
      .where(
        and(
          eq(invoices.businessId, input.businessId),
          inArray(
            invoices.id,
            minted.map((m) => m.invoiceId),
          ),
        ),
      );
  }

  /* The physical book, from the same statement the financial book was
   * posted from. Movements only when quantities were STATED: a bare value
   * invents no goods. */
  for (const lineIn of stockLines) {
    const product = await findOrCreateProduct(tx, input.businessId, lineIn.name);
    await recordDelivery(tx, {
      businessId: input.businessId,
      product,
      quantity: lineIn.quantity,
      costK: Math.round(lineIn.quantity * lineIn.unitCostK),
      sourceType: OPENING_SOURCE,
      sourceId: input.asAt,
      reason: 'opening',
    });
  }

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'opening_balances',
    entityId: ledgerTransactionId,
    action: 'recorded',
    newValue: {
      asAt: input.asAt,
      cashK: input.cashK,
      bankK: input.bankK,
      stockK: stockValueK,
      stockLines: stockLines.length,
      receivablesK: minted.reduce((sum, m) => sum + m.amountK, 0),
      invoices: minted.map((m) => m.invoiceNumber),
    } as never,
    sourceType: 'dashboard',
  });

  const equityK =
    input.cashK + input.bankK + stockValueK + minted.reduce((sum, m) => sum + m.amountK, 0);
  return { ledgerTransactionId, equityK, stockValueK, invoices: minted };
}

export interface OpeningBalances {
  asAt: string;
  cashK: number;
  bankK: number;
  stockK: number;
  /** What customers already owed, summed off the opening entry's AR lines. */
  receivablesK: number;
}

/**
 * What was recorded, or null.
 *
 * Read back off the ledger rather than off a stored copy, which means the
 * page a merchant sees and the balance sheet cannot disagree: they are the
 * same rows.
 */
export async function openingBalancesFor(
  tx: TenantDb,
  businessId: string,
): Promise<OpeningBalances | null> {
  const rows = await tx.execute<{
    as_at: string;
    cash_k: string;
    bank_k: string;
    stock_k: string;
    receivables_k: string;
  }>(sql`
    SELECT t.source_id AS as_at,
           COALESCE(SUM(e.debit_k) FILTER (WHERE acc.code = ${codeOf('CASH')}), 0)::bigint AS cash_k,
           COALESCE(SUM(e.debit_k) FILTER (WHERE acc.code = ${codeOf('BANK')}), 0)::bigint AS bank_k,
           COALESCE(SUM(e.debit_k) FILTER (WHERE acc.code = ${codeOf('INVENTORY')}), 0)::bigint AS stock_k,
           COALESCE(SUM(e.debit_k) FILTER (WHERE acc.code = ${codeOf('ACCOUNTS_RECEIVABLE')}), 0)::bigint AS receivables_k
    FROM ledger_transactions t
    JOIN ledger_entries e
      ON e.transaction_id = t.id AND e.business_id = t.business_id
    JOIN accounts acc ON acc.id = e.account_id
    WHERE t.business_id = ${businessId}::uuid AND t.source_type = ${OPENING_SOURCE}
    GROUP BY t.source_id
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    asAt: row.as_at,
    cashK: Number(row.cash_k),
    bankK: Number(row.bank_k),
    stockK: Number(row.stock_k),
    receivablesK: Number(row.receivables_k),
  };
}

/** Unique violations arrive wrapped by the driver; unwrap a few layers. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code?: string }).code === '23505'
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
