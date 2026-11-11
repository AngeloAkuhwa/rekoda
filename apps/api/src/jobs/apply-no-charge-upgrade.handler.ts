/**
 * OD-51: apply an upgrade priced at nothing (G-105), in the worker.
 *
 * Under a day of the cycle left, an upgrade costs nothing and is switched at once. That switch is a
 * settlement (the plan moves through `applySettledCharge`, exactly as for a payment), and since the
 * API no longer holds the settlement credential the API opens the zero-priced charge and enqueues
 * this job. Settlement re-prices the charge itself (`expectedChargeTerms`): one the application
 * opened at zero that Rekoda's pricing does not put at zero is recorded and set aside for an
 * operator (`price_not_verified`), never applied. No provider is involved, so there is no payment
 * to verify; the provider reference is Rekoda's own `no_charge:<reference>`.
 */
import { Logger } from '@nestjs/common';
import { subscriptionsRepo } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import { applySettledCharge } from '../billing/billing.service.js';
import type { JobContext, JobHandler } from './runner.js';

const REFERENCE = /^RKD-SUB-\d{8}-[0-9A-Z]{6}$/;

export function applyNoChargeUpgradeHandler(deps: {
  config: Pick<ApiConfig, 'planCatalogueReads'> & Partial<ApiConfig>;
}): JobHandler {
  const log = new Logger('ApplyNoChargeUpgradeJob');
  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const reference = typeof payload['reference'] === 'string' ? payload['reference'] : null;
    if (!reference || !REFERENCE.test(reference)) {
      throw new Error('billing.apply_no_charge: payload has no subscription charge reference');
    }
    const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
    /* Only a pending zero-priced upgrade is applied here; anything else is not this job's. */
    if (
      !charge ||
      charge.status !== 'pending' ||
      charge.kind !== 'upgrade' ||
      charge.amountK !== 0
    ) {
      log.warn(`billing.apply_no_charge: ${reference} is not a pending zero-priced upgrade`);
      return;
    }
    const outcome = await applySettledCharge(tx, {
      businessId,
      reference,
      /* Unique per charge: (provider, provider_reference) is globally unique. */
      providerReference: `no_charge:${reference}`,
      when: new Date(),
      config: deps.config,
    });
    log.log(`business ${businessId}: zero-priced upgrade ${reference} ${outcome}`);
  };
}
