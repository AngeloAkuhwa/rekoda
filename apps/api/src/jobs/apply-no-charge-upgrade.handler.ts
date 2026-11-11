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
import { sql, subscriptionsRepo } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import { applySettledCharge } from '../billing/billing.service.js';
import type { JobContext, JobHandler } from './runner.js';

const REFERENCE = /^RKD-SUB-\d{8}-[0-9A-Z]{6}$/;

export function applyNoChargeUpgradeHandler(deps: {
  config: Pick<ApiConfig, 'planCatalogueReads'> & Partial<ApiConfig>;
}): JobHandler {
  const log = new Logger('ApplyNoChargeUpgradeJob');
  return async ({ tx, payload, businessId, attempt, maxAttempts }: JobContext): Promise<void> => {
    const reference = typeof payload['reference'] === 'string' ? payload['reference'] : null;
    if (!reference || !REFERENCE.test(reference)) {
      throw new Error('billing.apply_no_charge: payload has no subscription charge reference');
    }
    const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
    /* Only a pending, current zero-priced upgrade is applied here. One a later request retired
     * (a second click before this job ran opens its own) is not applied: the newer one is. */
    if (
      !charge ||
      charge.status !== 'pending' ||
      charge.kind !== 'upgrade' ||
      charge.amountK !== 0 ||
      charge.supersededAt
    ) {
      log.warn(`billing.apply_no_charge: ${reference} is not a pending zero-priced upgrade`);
      return;
    }
    let outcome: string;
    try {
      /* In a savepoint, so a failure on the last attempt can still be recorded below. */
      outcome = await tx.transaction((sp) =>
        applySettledCharge(sp, {
          businessId,
          reference,
          /* Unique per charge: (provider, provider_reference) is globally unique. */
          providerReference: `no_charge:${reference}`,
          when: new Date(),
          config: deps.config,
        }),
      );
    } catch (error) {
      if (attempt < maxAttempts) throw error;
      /* Not enrolled as a dead job (that is the payment-recovery path, OWN-73/OWN-76): nothing was
       * paid. The charge stays pending at nothing, the merchant can choose the plan again (a new
       * request retires it and queues a fresh one), and the failure is audited and alerted. */
      await tx.execute(sql`
        INSERT INTO audit_events (business_id, actor, entity, entity_id, action, new_value, source_type)
        VALUES (${businessId}::uuid, 'system:no_charge_upgrade', 'subscription_charge', ${reference},
                'no_charge_upgrade_failed', '{"outcome":"failed_last_attempt"}'::jsonb, 'system')`);
      log.error(
        `ALERT billing_no_charge_upgrade_failed business=${businessId} reference=${reference}`,
      );
      return;
    }
    log.log(`business ${businessId}: zero-priced upgrade ${reference} ${outcome}`);
  };
}
