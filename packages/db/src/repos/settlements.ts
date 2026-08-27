/**
 * Provider settlement, recorded as reported (spec §20; P2, PR-063).
 *
 * Actual provider data drives the books, so what lands here must be worth
 * driving them with: a report whose components do not explain its own
 * gross→net gap is REFUSED, not stored — an incoherent fact in this table
 * would flow into postings (PR-065) as an incoherent journal. And a payout
 * the provider re-reports with different numbers is a CONFLICT for a human,
 * never a silent overwrite: the first report may already be posted.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { settlementComponents, settlementItems, settlements } from '../schema/payments-hub.js';

export const COMPONENT_KINDS = [
  'PROCESSING_FEE',
  'VAT_ON_FEE',
  'WITHHOLDING',
  'LEVY',
  'RESERVE_HELD',
  'RESERVE_RELEASED',
  'REBATE',
  'ADJUSTMENT',
  'CHARGEBACK',
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export interface SettlementComponentInput {
  kind: ComponentKind;
  direction: 'DEDUCTION' | 'ADDITION';
  /** Always positive; the direction carries the sign (§20). */
  amountK: number;
  note?: string;
}

export interface SettlementReport {
  businessId: string;
  paymentConnectionId: string;
  providerSettlementId: string;
  status: 'PENDING' | 'SETTLED' | 'FAILED';
  currency?: string;
  grossK: number;
  netK: number;
  settledAt?: Date | null;
  /** Which payments the payout covered. */
  items: Array<{ paymentId: string; amountK: number }>;
  components: SettlementComponentInput[];
}

export type RecordSettlementOutcome =
  | { outcome: 'recorded'; id: string; isNew: boolean }
  /** gross − deductions + additions ≠ net: the report does not explain
   * itself, and an unexplained fact must not reach the books. */
  | { outcome: 'incoherent_report'; expectedNetK: number }
  /** The provider re-reported this payout with DIFFERENT numbers. The
   * stored report may already be posted; a human decides. */
  | { outcome: 'conflicting_report'; id: string };

const signedSumK = (components: SettlementComponentInput[]): number =>
  components.reduce((sum, c) => sum + (c.direction === 'DEDUCTION' ? -c.amountK : c.amountK), 0);

export async function recordSettlement(
  tx: TenantDb,
  report: SettlementReport,
): Promise<RecordSettlementOutcome> {
  const expectedNetK = report.grossK + signedSumK(report.components);
  if (expectedNetK !== report.netK) {
    return { outcome: 'incoherent_report', expectedNetK };
  }

  const inserted = await tx
    .insert(settlements)
    .values({
      businessId: report.businessId,
      paymentConnectionId: report.paymentConnectionId,
      providerSettlementId: report.providerSettlementId,
      status: report.status,
      ...(report.currency ? { currency: report.currency } : {}),
      grossK: report.grossK,
      netK: report.netK,
      settledAt: report.settledAt ?? null,
    })
    .onConflictDoNothing({
      target: [
        settlements.businessId,
        settlements.paymentConnectionId,
        settlements.providerSettlementId,
      ],
    })
    .returning({ id: settlements.id });

  const created = inserted[0];
  if (created) {
    /* First sight of this payout: the detail rows land with it, once —
     * items and components are immutable by REVOKE (0090). */
    if (report.items.length) {
      await tx.insert(settlementItems).values(
        report.items.map((item) => ({
          businessId: report.businessId,
          settlementId: created.id,
          paymentId: item.paymentId,
          amountK: item.amountK,
        })),
      );
    }
    if (report.components.length) {
      await tx.insert(settlementComponents).values(
        report.components.map((component) => ({
          businessId: report.businessId,
          settlementId: created.id,
          kind: component.kind,
          direction: component.direction,
          amountK: component.amountK,
          ...(component.note ? { note: component.note } : {}),
        })),
      );
    }
    return { outcome: 'recorded', id: created.id, isNew: true };
  }

  /* Seen before. The same numbers may progress the status (a PENDING
   * payout settling is the ordinary path); different numbers are a
   * conflict the caller records as an exception, never an overwrite. */
  const existingRows = await tx
    .select({
      id: settlements.id,
      grossK: settlements.grossK,
      netK: settlements.netK,
    })
    .from(settlements)
    .where(
      and(
        eq(settlements.businessId, report.businessId),
        eq(settlements.paymentConnectionId, report.paymentConnectionId),
        eq(settlements.providerSettlementId, report.providerSettlementId),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new Error('recordSettlement: conflict reported but no settlement found');

  if (existing.grossK !== report.grossK || existing.netK !== report.netK) {
    return { outcome: 'conflicting_report', id: existing.id };
  }

  await tx
    .update(settlements)
    .set({
      status: report.status,
      ...(report.settledAt ? { settledAt: report.settledAt } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(settlements.businessId, report.businessId), eq(settlements.id, existing.id)));
  return { outcome: 'recorded', id: existing.id, isNew: false };
}

export interface SettlementReadback {
  id: string;
  paymentConnectionId: string;
  providerSettlementId: string;
  status: string;
  currency: string;
  grossK: number;
  netK: number;
  settledAt: Date | null;
  items: Array<{ paymentId: string; amountK: number }>;
  components: Array<{ kind: string; direction: string; amountK: number; note: string | null }>;
}

/** One settlement, with the payments it covered and its signed explanation. */
export async function settlementById(
  tx: TenantDb,
  businessId: string,
  id: string,
): Promise<SettlementReadback | null> {
  const rows = await tx
    .select()
    .from(settlements)
    .where(and(eq(settlements.businessId, businessId), eq(settlements.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const items = await tx
    .select({ paymentId: settlementItems.paymentId, amountK: settlementItems.amountK })
    .from(settlementItems)
    .where(and(eq(settlementItems.businessId, businessId), eq(settlementItems.settlementId, id)));
  const components = await tx
    .select({
      kind: settlementComponents.kind,
      direction: settlementComponents.direction,
      amountK: settlementComponents.amountK,
      note: settlementComponents.note,
    })
    .from(settlementComponents)
    .where(
      and(
        eq(settlementComponents.businessId, businessId),
        eq(settlementComponents.settlementId, id),
      ),
    );

  return {
    id: row.id,
    paymentConnectionId: row.paymentConnectionId,
    providerSettlementId: row.providerSettlementId,
    status: row.status,
    currency: row.currency,
    grossK: row.grossK,
    netK: row.netK,
    settledAt: row.settledAt,
    items,
    components,
  };
}

/** The payout history, newest first. */
export async function settlementsFor(
  tx: TenantDb,
  businessId: string,
  limit = 50,
): Promise<Array<Omit<SettlementReadback, 'items' | 'components'>>> {
  return tx
    .select({
      id: settlements.id,
      paymentConnectionId: settlements.paymentConnectionId,
      providerSettlementId: settlements.providerSettlementId,
      status: settlements.status,
      currency: settlements.currency,
      grossK: settlements.grossK,
      netK: settlements.netK,
      settledAt: settlements.settledAt,
    })
    .from(settlements)
    .where(eq(settlements.businessId, businessId))
    .orderBy(desc(settlements.createdAt))
    .limit(limit);
}
