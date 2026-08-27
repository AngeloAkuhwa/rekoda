/**
 * Settlement tracking (docs/payments-v1.md §26–28).
 *
 * "Confirmed" answers whether the customer paid; settlement answers whether
 * the money reached the merchant's BANK. This sweep closes that gap by
 * asking the provider directly — polling, not webhooks, because Paystack's
 * settlement webhooks are best-effort while GET /settlement is the record.
 *
 *   list recent settlement batches → list each batch's transaction
 *   references → keep the Rekoda-shaped ones → resolve each to its business
 *   → stamp settlement_status (and settled_at) under that tenant's pin
 *
 * The same two-credential shape as the attribution pump: resolution is the
 * one legitimate cross-tenant read (`worker_resolve`), and every write runs
 * through `withBusiness` under row-level security. The stamp itself is
 * idempotent (`markSettlements`' IS DISTINCT FROM), so re-polling a batch
 * the sweep has already applied changes nothing.
 */
import { Logger } from '@nestjs/common';
import { PAYMENT_REFERENCE_PATTERN } from '@rekoda/core';
import { paymentsHub, settleRepo, settlementsRepo, withBusiness, type Db } from '@rekoda/db';
import type { PaymentProviderPort, ProviderSettlement } from './provider.port.js';

export interface SweepDeps {
  /** `rekoda_worker` — resolves references across tenants, nothing else. */
  workerDb: Db;
  /** `rekoda_app` — every payment row is stamped under a tenant pin. */
  appDb: Db;
  provider: PaymentProviderPort;
}

/** A week of look-back covers Paystack's slowest settlement cycles. */
const LOOKBACK_DAYS = 7;

const log = new Logger('SettlementSweep');

/** One pass. Returns how many payments changed settlement state. */
export async function sweepSettlements(deps: SweepDeps, now: Date = new Date()): Promise<number> {
  const fromIso = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const settlements = await deps.provider.listSettlements(fromIso);
  let stamped = 0;

  for (const settlement of settlements) {
    stamped += await applySettlement(deps, settlement);
  }
  return stamped;
}

async function applySettlement(deps: SweepDeps, settlement: ProviderSettlement): Promise<number> {
  const references = await deps.provider.listSettlementTransactions(settlement.settlementId);
  const ours = references.filter((r) => PAYMENT_REFERENCE_PATTERN.test(r));
  if (ours.length === 0) return 0;

  /* Group references by the business that owns them. A reference that
   * resolves to no intent is somebody else's traffic on a shared account —
   * skipped, exactly as the pump skips it. */
  const owners = await paymentsHub.businessesForReferences(deps.workerDb, ours);
  const byBusiness = new Map<string, string[]>();
  for (const reference of ours) {
    const businessId = owners.get(reference);
    if (!businessId) continue;
    const list = byBusiness.get(businessId) ?? [];
    list.push(reference);
    byBusiness.set(businessId, list);
  }

  let stamped = 0;
  for (const [businessId, refs] of byBusiness) {
    stamped += await withBusiness(deps.appDb, businessId, (tx) =>
      settleRepo.markSettlements(tx, businessId, refs, settlement.status, settlement.settledAtIso),
    );
  }
  if (stamped > 0) {
    log.log(
      `settlement ${settlement.settlementId}: ${stamped} payment(s) now ${settlement.status}`,
    );
  }

  await ingestSettlement(deps, settlement, references, byBusiness);
  return stamped;
}

/**
 * The §20 row behind the stamps (PR-064): the payout itself, with the
 * payments it covered and the SIGNED components that explain its gap.
 *
 * Recorded ONLY when the batch is attributable as a whole — one business,
 * every covered reference resolved to it, and the provider actually stated
 * its totals. A batch that spans tenants or carries foreign traffic has a
 * gross that belongs to nobody in particular, and decomposing it would be
 * estimation — §20 forbids exactly that for authoritative data. What is
 * skipped is LOGGED, never silently capped.
 */
async function ingestSettlement(
  deps: SweepDeps,
  settlement: ProviderSettlement,
  references: string[],
  byBusiness: Map<string, string[]>,
): Promise<void> {
  if (settlement.grossK === null || settlement.netK === null) return;
  const grossK = settlement.grossK;
  const netK = settlement.netK;

  if (byBusiness.size !== 1) {
    if (byBusiness.size > 1) {
      log.warn(
        `settlement ${settlement.settlementId} spans ${byBusiness.size} businesses; §20 row not recorded`,
      );
    }
    return;
  }
  const [businessId, refs] = [...byBusiness.entries()][0]!;
  if (refs.length !== references.length) {
    log.warn(
      `settlement ${settlement.settlementId} carries traffic beyond one tenant's; §20 row not recorded`,
    );
    return;
  }

  /**
   * Where the provider itemises, its components stand. Where it states
   * only totals, the totals PROVE one component — the gap — and the note
   * says how it was derived. Provider-stated arithmetic, never a rate
   * card.
   */
  const components: settlementsRepo.SettlementComponentInput[] = settlement.components?.length
    ? settlement.components
    : grossK === netK
      ? []
      : [
          grossK > netK
            ? {
                kind: 'PROCESSING_FEE',
                direction: 'DEDUCTION',
                amountK: grossK - netK,
                note: 'gross − net as reported by the provider',
              }
            : {
                kind: 'ADJUSTMENT',
                direction: 'ADDITION',
                amountK: netK - grossK,
                note: 'net − gross as reported by the provider',
              },
        ];

  await withBusiness(deps.appDb, businessId, async (tx) => {
    const connection = await paymentsHub.connectionFor(tx, businessId, deps.provider.providerType);
    if (!connection) return;

    const covered = await settleRepo.paymentsByReferences(tx, businessId, refs);
    const outcome = await settlementsRepo.recordSettlement(tx, {
      businessId,
      paymentConnectionId: connection.id,
      providerSettlementId: settlement.settlementId,
      status:
        settlement.status === 'settled'
          ? 'SETTLED'
          : settlement.status === 'failed'
            ? 'FAILED'
            : 'PENDING',
      ...(settlement.currency ? { currency: settlement.currency } : {}),
      grossK,
      netK,
      settledAt: settlement.settledAtIso ? new Date(settlement.settledAtIso) : null,
      items: covered.map((payment) => ({ paymentId: payment.id, amountK: payment.amountK })),
      components,
    });

    /* Both refusals become EXCEPTIONS a human can see, not log lines a
     * human will not: the provider's own report disagreeing with itself,
     * or with what it reported before, is precisely the reconciliation
     * queue's business. */
    if (outcome.outcome === 'recorded') {
      /* The books (PR-065, §21.1): a SETTLED payout moves clearing → bank
       * and recognises the ACTUAL fees, from the row just recorded and
       * nothing else. Idempotent by posting purpose; a payout that cannot
       * post yet (reserves/chargebacks await their PRs, or the items do
       * not reconcile to gross — invariant 5) surfaces as an exception. */
      const posting = await settlementsRepo.postSettlement(tx, businessId, outcome.id);
      if (
        !posting.posted &&
        (posting.reason === 'items_do_not_reconcile' || posting.reason === 'unpostable_components')
      ) {
        const already = await settleRepo.hasException(
          tx,
          businessId,
          'settlement',
          settlement.settlementId,
        );
        if (!already) {
          await settleRepo.recordException(tx, {
            businessId,
            reason: `settlement_${posting.reason}`,
            expectationKind: 'settlement',
            expectationId: settlement.settlementId,
            amountK: grossK,
          });
        }
      }
    }

    if (outcome.outcome === 'incoherent_report' || outcome.outcome === 'conflicting_report') {
      /* Once per settlement, however often the sweep re-polls it. */
      const already = await settleRepo.hasException(
        tx,
        businessId,
        'settlement',
        settlement.settlementId,
      );
      if (!already) {
        await settleRepo.recordException(tx, {
          businessId,
          reason: `settlement_${outcome.outcome}`,
          expectationKind: 'settlement',
          expectationId: settlement.settlementId,
          amountK: grossK,
        });
      }
    }
  });
}
