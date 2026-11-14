/**
 * TEST FIXTURES: open a charge at the price Rekoda's own pricing gives it (OD-51, migration 0209).
 *
 * Settlement re-prices every charge before applying it (`expectedChargeTerms`), so a fixture that
 * opens a charge at an invented amount would be set aside as `price_not_verified`, which is the
 * point of the check. Suites that exercise something other than pricing open their charges here, so
 * the amount is the one an honest opener would have written, priced at the same instant.
 */
import { subscriptionsRepo, type TenantDb } from '@rekoda/db';
import type { BillingInterval } from '@rekoda/core';
import { expectedChargeTerms } from './billing.service.js';
import type { PlanTermsConfig } from './plan-terms.js';

export interface FixtureCharge extends Omit<subscriptionsRepo.NewCharge, 'amountK' | 'pricedAt'> {
  /** Defaults to the honest price; give one only to exercise a mis-priced charge. */
  amountK?: number;
}

/** The kind and amount settlement will expect for these terms, priced now. */
export async function honestTerms(
  tx: TenantDb,
  config: PlanTermsConfig,
  charge: Omit<FixtureCharge, 'reference'>,
  at: Date = new Date(),
): Promise<{ kind: string; amountK: number } | null> {
  const subscription = await subscriptionsRepo.subscriptionFor(tx, charge.businessId);
  return expectedChargeTerms(
    tx,
    config,
    charge.businessId,
    {
      kind: charge.kind,
      plan: charge.plan ?? null,
      packId: charge.packId ?? null,
      quantity: charge.quantity ?? 1,
      billingInterval: (charge.billingInterval ?? 'monthly') as BillingInterval,
      createdAt: at,
      pricedAt: at,
    } as subscriptionsRepo.ChargeRow,
    subscription,
  );
}

/** `openCharge` at the honest price (or the amount given), with its pricing time recorded. */
export async function openPricedCharge(
  tx: TenantDb,
  config: PlanTermsConfig,
  charge: FixtureCharge,
): Promise<string | null> {
  const at = new Date();
  const amountK =
    charge.amountK ??
    (await honestTerms(tx, config, charge, at))?.amountK ??
    ((): never => {
      throw new Error(`no honest price for a ${charge.kind} charge: give one explicitly`);
    })();
  return subscriptionsRepo.openCharge(tx, { ...charge, amountK, pricedAt: at });
}
