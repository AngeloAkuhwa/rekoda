/**
 * Observability over financial events (S1, PR-104).
 *
 * Spec §31's accounting definition of done is fourteen invariants, and an
 * invariant nobody can ask about is a promise, not a property. This module
 * turns the ones that constraints and triggers do NOT already make
 * unrepresentable into live probes an operator polls: every count here
 * should be zero forever, and the first nonzero is an incident with a
 * business id attached.
 *
 * Deliberately per tenant, under the tenant pin, swept by the caller. The
 * worker credential reads whole tables only where a migration argued for a
 * policy (jobs, businesses, the margin pair), and an estate-wide financial
 * probe is not worth widening that boundary: the sweep enumerates ids on
 * the credential that may, and asks each tenant's question inside the same
 * pinned transaction every other tenant read uses.
 *
 * Counts and ids only - no names, no amounts, no document contents. An
 * operator alarms on the number and investigates with the id.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

export interface FinancialProbes {
  /**
   * Invariant 2: every posted journal balances. Trigger-enforced since
   * PR-039, so this is the belt checking the braces - a nonzero here means
   * the trigger itself has been circumvented, which is the worst possible
   * news and exactly why it is watched.
   */
  unbalancedJournals: number;
  /**
   * Invariant 3: no paid invoice exists without authoritative allocations
   * or applied credits. NOT database-enforced - a writer that flips
   * `status` without its money trail would violate it silently, which is
   * what makes this the probe that earns the endpoint.
   */
  paidWithoutSettlement: number;
  /**
   * Invariant 5: provider settlement reconciles to gross payment. Ingestion
   * refuses an incoherent report (PR-064), so like the journal probe this
   * watches for what should be impossible: net that stopped equalling
   * gross less deductions plus additions.
   */
  settlementDrift: number;
  /**
   * Spec §26: a dead outbox event is VISIBLE, never deleted. This is where
   * it is visible. An event that exhausted its attempts is an announcement
   * a subscriber never got, and somebody has to decide about it.
   */
  deadOutboxEvents: number;
  /** Undelivered announcements, dead or still retrying. */
  undispatchedOutbox: number;
  /** How stale the oldest undelivered announcement is. Null means none. */
  oldestUndispatchedMinutes: number | null;
}

export async function financialProbesFor(tx: TenantDb): Promise<FinancialProbes> {
  const rows = await tx.execute<{
    unbalanced_journals: number;
    paid_without_settlement: number;
    settlement_drift: number;
    dead_outbox: number;
    undispatched_outbox: number;
    oldest_undispatched_minutes: string | number | null;
  }>(sql`
    SELECT
      (SELECT count(*) FROM (
         SELECT le.transaction_id
         FROM ledger_entries le
         GROUP BY le.transaction_id
         HAVING sum(le.debit_k) <> sum(le.credit_k)) unbalanced
      )::int AS unbalanced_journals,
      (SELECT count(*) FROM invoices i
         WHERE i.status = 'paid'
           AND NOT EXISTS (
             SELECT 1 FROM payment_allocations pa WHERE pa.invoice_id = i.id)
           AND NOT EXISTS (
             SELECT 1 FROM customer_credit_applications ca WHERE ca.invoice_id = i.id)
      )::int AS paid_without_settlement,
      (SELECT count(*) FROM settlements s
         WHERE s.net_k <> s.gross_k
           - COALESCE((SELECT sum(sc.amount_k) FROM settlement_components sc
                       WHERE sc.settlement_id = s.id AND sc.direction = 'DEDUCTION'), 0)
           + COALESCE((SELECT sum(sc.amount_k) FROM settlement_components sc
                       WHERE sc.settlement_id = s.id AND sc.direction = 'ADDITION'), 0)
      )::int AS settlement_drift,
      (SELECT count(*) FROM outbox_events o
         WHERE o.dispatched_at IS NULL AND o.attempts >= o.max_attempts
      )::int AS dead_outbox,
      (SELECT count(*) FROM outbox_events o WHERE o.dispatched_at IS NULL
      )::int AS undispatched_outbox,
      (SELECT floor(extract(epoch FROM (now() - min(o.occurred_at))) / 60)
         FROM outbox_events o WHERE o.dispatched_at IS NULL
      ) AS oldest_undispatched_minutes
  `);
  const row = [...rows][0];
  return {
    unbalancedJournals: row?.unbalanced_journals ?? 0,
    paidWithoutSettlement: row?.paid_without_settlement ?? 0,
    settlementDrift: row?.settlement_drift ?? 0,
    deadOutboxEvents: row?.dead_outbox ?? 0,
    undispatchedOutbox: row?.undispatched_outbox ?? 0,
    oldestUndispatchedMinutes:
      row?.oldest_undispatched_minutes === null || row?.oldest_undispatched_minutes === undefined
        ? null
        : Number(row.oldest_undispatched_minutes),
  };
}

/**
 * The estate's ids for the sweep, oldest first so the walk is stable
 * between polls. Worker credential: migration 0019's businesses policy is
 * exactly the grant this uses, and nothing wider.
 */
export async function sweepBusinessIds(db: Db, limit: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM businesses ORDER BY created_at, id LIMIT ${limit}
  `);
  return [...rows].map((row) => row.id);
}
