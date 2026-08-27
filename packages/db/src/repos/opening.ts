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
import { sql } from 'drizzle-orm';
import { postOpeningBalances, lagosNoon } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { auditEvents } from '../schema/ops.js';
import { codeOf } from './accounts.js';
import { writePosting } from './issue.js';

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
  bankK: number;
  stockK: number;
  actor: string;
}

export interface OpeningBalancesRecorded {
  ledgerTransactionId: string;
  /** What went to owner's equity: everything held, by definition. */
  equityK: number;
}

export async function recordOpeningBalances(
  tx: TenantDb,
  input: OpeningBalancesInput,
): Promise<OpeningBalancesRecorded> {
  /* Throws RangeError on nothing at all and on a negative holding, before
   * anything is written. */
  const posting = postOpeningBalances({
    memo: `Opening balances as at ${input.asAt}`,
    cashK: input.cashK,
    bankK: input.bankK,
    stockK: input.stockK,
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
      stockK: input.stockK,
    } as never,
    sourceType: 'dashboard',
  });

  const equityK = input.cashK + input.bankK + input.stockK;
  return { ledgerTransactionId, equityK };
}

export interface OpeningBalances {
  asAt: string;
  cashK: number;
  bankK: number;
  stockK: number;
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
  }>(sql`
    SELECT t.source_id AS as_at,
           COALESCE(SUM(e.debit_k) FILTER (WHERE acc.code = ${codeOf('CASH')}), 0)::bigint AS cash_k,
           COALESCE(SUM(e.debit_k) FILTER (WHERE acc.code = ${codeOf('BANK')}), 0)::bigint AS bank_k,
           COALESCE(SUM(e.debit_k) FILTER (WHERE acc.code = ${codeOf('INVENTORY')}), 0)::bigint AS stock_k
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
