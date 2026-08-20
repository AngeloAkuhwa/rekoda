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
import { paymentsHub, settleRepo, withBusiness, type Db } from '@rekoda/db';
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
  const byBusiness = new Map<string, string[]>();
  for (const reference of ours) {
    const intent = await paymentsHub.resolveIntentByReference(deps.workerDb, reference);
    if (!intent) continue;
    const list = byBusiness.get(intent.businessId) ?? [];
    list.push(reference);
    byBusiness.set(intent.businessId, list);
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
  return stamped;
}
