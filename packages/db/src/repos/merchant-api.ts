/**
 * The Merchant API's reads (PR-111, canonical spec §27).
 *
 * Its own module rather than more functions on the dashboard's repos,
 * because the two have a different pagination contract and mixing them would
 * make one of the two wrong. A dashboard page is a person scrolling a list
 * that is not being written to while they look at it; an API page is a
 * program walking a table that is, and an OFFSET over a moving table shows
 * the caller one row twice and skips another.
 *
 * So every reader here is KEYSET paginated on `(created_at DESC, id DESC)`,
 * a pair that is unique and never changes for a row. The cursor is that
 * pair, opaque to the caller and reconstructible by nobody else.
 *
 * Nothing here decides anything. Every function takes a `TenantDb`, so the
 * tenant is the pin the key resolved to and never a parameter a caller can
 * bend.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

/*
 * Kobo columns are `bigint`, and the driver hands a bigint back as a STRING
 * rather than risk silent precision loss. Every reader here coerces at this
 * boundary, as the rest of the estate does, so nothing downstream has to
 * wonder which of the two it holds.
 */

/** How many rows a page may carry, whatever the caller asks for. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export interface Cursor {
  createdAt: Date;
  id: string;
}

export interface Page<T> {
  rows: T[];
  next: Cursor | null;
}

export interface CustomerRow {
  id: string;
  /** The pseudonym, never a name. See the note on `customersPage`. */
  token: string;
  createdAt: Date;
}

export interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  unitPriceK: number | null;
  active: boolean;
  createdAt: Date;
}

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  customerId: string | null;
  status: string;
  totalK: number;
  paidK: number;
  balanceDueK: number;
  currency: string;
  dueDate: Date | null;
  issuedAt: Date;
}

/**
 * The merchant's customers, as pseudonyms.
 *
 * `customers` holds a token and nothing else by design (spec §39): names,
 * phones and addresses live encrypted in `customer_identities`, one row per
 * facet, so a facet can be erased on its own. This reader does not touch
 * that table and never will. A partner integration is not a reason to turn
 * the public API into a PII export route, and a partner who needs to reach a
 * customer reaches them through the merchant's own channels.
 */
export async function customersPage(
  tx: TenantDb,
  businessId: string,
  page: { after: Cursor | null; limit: number },
): Promise<Page<CustomerRow>> {
  const limit = clamp(page.limit);
  const rows = await tx.execute<{ id: string; token: string; created_at: string | Date }>(sql`
    SELECT id, token, created_at
      FROM customers
     WHERE business_id = ${businessId}
       ${afterClause(page.after, sql`created_at`, sql`id`)}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit + 1}
  `);
  return paginate(
    [...rows],
    limit,
    (row) => ({ id: row.id, token: row.token, createdAt: at(row.created_at) }),
    (row) => row.createdAt,
  );
}

export async function productsPage(
  tx: TenantDb,
  businessId: string,
  page: { after: Cursor | null; limit: number },
): Promise<Page<ProductRow>> {
  const limit = clamp(page.limit);
  const rows = await tx.execute<{
    id: string;
    name: string;
    description: string | null;
    unit_price_k: string | number | null;
    active: string | number;
    created_at: string | Date;
  }>(sql`
    SELECT id, name, description, unit_price_k, active, created_at
      FROM products
     WHERE business_id = ${businessId}
       ${afterClause(page.after, sql`created_at`, sql`id`)}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit + 1}
  `);
  return paginate(
    [...rows],
    limit,
    (row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      unitPriceK: row.unit_price_k === null ? null : Number(row.unit_price_k),
      active: Number(row.active) === 1,
      createdAt: at(row.created_at),
    }),
    (row) => row.createdAt,
  );
}

/**
 * Invoices, newest first, optionally narrowed to one status.
 *
 * The keyset is the same `(created_at, id)` pair as everywhere else here.
 * The wire calls it `issuedAt`, because that is what the date MEANS on an
 * invoice, and the column keeps the estate's name.
 */
export async function invoicesPage(
  tx: TenantDb,
  businessId: string,
  page: { after: Cursor | null; limit: number; status?: string | null },
): Promise<Page<InvoiceRow>> {
  const limit = clamp(page.limit);
  const rows = await tx.execute<{
    id: string;
    invoice_number: string;
    customer_id: string | null;
    status: string;
    total_k: string | number;
    paid_k: string | number;
    balance_due_k: string | number;
    currency: string;
    due_date: string | Date | null;
    created_at: string | Date;
  }>(sql`
    SELECT id, invoice_number, customer_id, status, total_k, paid_k,
           balance_due_k, currency, due_date, created_at
      FROM invoices
     WHERE business_id = ${businessId}
       ${page.status ? sql`AND status = ${page.status}` : sql``}
       ${afterClause(page.after, sql`created_at`, sql`id`)}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit + 1}
  `);
  return paginate(
    [...rows],
    limit,
    (row) => ({
      id: row.id,
      invoiceNumber: row.invoice_number,
      customerId: row.customer_id,
      status: row.status,
      totalK: Number(row.total_k),
      paidK: Number(row.paid_k),
      balanceDueK: Number(row.balance_due_k),
      currency: row.currency,
      dueDate: row.due_date === null ? null : at(row.due_date),
      issuedAt: at(row.created_at),
    }),
    (row) => row.issuedAt,
  );
}

/** One invoice by its number, or nothing. */
export async function invoiceByNumber(
  tx: TenantDb,
  businessId: string,
  invoiceNumber: string,
): Promise<InvoiceRow | null> {
  const rows = await tx.execute<{
    id: string;
    invoice_number: string;
    customer_id: string | null;
    status: string;
    total_k: string | number;
    paid_k: string | number;
    balance_due_k: string | number;
    currency: string;
    due_date: string | Date | null;
    created_at: string | Date;
  }>(sql`
    SELECT id, invoice_number, customer_id, status, total_k, paid_k,
           balance_due_k, currency, due_date, created_at
      FROM invoices
     WHERE business_id = ${businessId} AND invoice_number = ${invoiceNumber}
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    customerId: row.customer_id,
    status: row.status,
    totalK: Number(row.total_k),
    paidK: Number(row.paid_k),
    balanceDueK: Number(row.balance_due_k),
    currency: row.currency,
    dueDate: row.due_date === null ? null : at(row.due_date),
    issuedAt: at(row.created_at),
  };
}

/**
 * The keyset predicate: strictly older than the cursor's row.
 *
 * A row comparison rather than `created_at < x OR (created_at = x AND id < y)`
 * because PostgreSQL can use the composite ordering directly for the former,
 * and because the long form is where an off-by-one that skips a row lives.
 */
function afterClause(
  after: Cursor | null,
  timeColumn: ReturnType<typeof sql>,
  idColumn: ReturnType<typeof sql>,
) {
  if (!after) return sql``;
  return sql`AND (${timeColumn}, ${idColumn}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`;
}

/**
 * Turn `limit + 1` rows into a page of `limit` and the cursor that follows.
 *
 * Reading one extra row is how "is there more" is answered without a second
 * COUNT over the whole table, and it means `next` is null exactly when the
 * caller has reached the end rather than one page after they have.
 */
function paginate<Raw, T extends { id: string }>(
  raw: Raw[],
  limit: number,
  map: (row: Raw) => T,
  cursorTime: (row: T) => Date,
): Page<T> {
  const rows = raw.slice(0, limit).map(map);
  if (raw.length <= limit || rows.length === 0) return { rows, next: null };
  const last = rows[rows.length - 1]!;
  return { rows, next: { createdAt: cursorTime(last), id: last.id } };
}

function clamp(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

function at(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}
