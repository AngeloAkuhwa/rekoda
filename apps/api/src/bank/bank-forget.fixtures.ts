/**
 * Shared helpers for the statement-day forget suites (bank-forget-*.integration.test.ts),
 * split from bank.integration.test.ts: the forget call and the reads that show what a forget
 * removed.
 */
import { sql, withBusiness } from '@rekoda/db';
import { db, post } from './bank.fixtures.js';

export const forget = async (auth: Record<string, string>, postedOn: string) =>
  (await post('/v1/bank/statement/forget', { postedOn }, auth)).json() as Record<string, unknown>;

/**
 * The day's lines, as the database holds them.
 */
export async function linesOn(businessId: string, postedOn: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ id: string }>(sql`
        SELECT id FROM bank_statement_lines
        WHERE business_id = ${businessId}::uuid AND posted_on = ${postedOn}::date ORDER BY id
      `),
  );
  return [...rows].map((r) => r.id);
}

export async function matchCount(businessId: string) {
  const [row] = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM bank_line_matches WHERE business_id = ${businessId}::uuid
      `),
  );
  return row!.n;
}

/**
 * The forget audit rows, stored values as written.
 */
export async function forgetAudits(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ entity_id: string; new_value: Record<string, unknown> }>(sql`
        SELECT entity_id, new_value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'bank_statement'
          AND action = 'forgotten'
        ORDER BY created_at, id
      `),
  );
  return [...rows];
}
