/**
 * THE cross-product routing decision (spec §3.1, §5.3; X1, PR-092).
 *
 * "Send Chidi the payment details" originates in Chat and delivers through
 * Integrate — and whether it CAN deliver is one question with one answer,
 * asked here by every caller: the W3 checkout (PR-089), the coming X1
 * delivery (PR-093), and anything after them. Spec §25's argument is that
 * one economic event produces one record because every ingress converges
 * on the same command; this file is the same argument applied to routing —
 * one resolver, so there is no second implementation to disagree with.
 *
 * The answer names WHY when it is no, because §3.1 gives each no its own
 * product meaning: `not_entitled` is the Chat-only business, whose merchant
 * gets the details in their own hands and shares them however they like;
 * `no_connection` is an Integrate business whose WABA is not standing;
 * `no_phone` is a customer the vault cannot anchor to a number.
 *
 * The phone is decrypted HERE — the same authorised boundary as
 * `PaymentIntentsService.customerEmail` — returned raw, held in memory for
 * the send that follows, and never stored, logged or placed in a payload
 * (F.3).
 */
import { decryptFacet } from '@rekoda/core/vault';
import { customersRepo, entitlementsRepo, wabaRepo, type TenantDb } from '@rekoda/db';
import type { ApiConfig } from '../config.js';

export type CustomerThreadRoute =
  | { state: 'reachable'; phone: string }
  | { state: 'not_entitled' }
  | { state: 'no_connection' }
  | { state: 'no_phone' };

export class CustomerThreadRouter {
  constructor(private readonly config: ApiConfig) {}

  async routeFor(
    tx: TenantDb,
    businessId: string,
    customerId: string,
  ): Promise<CustomerThreadRoute> {
    /* Delivering into a customer thread is a customer-facing act on the
     * merchant's own channel, which is the definition of Integrate
     * (spec §3.1) — so the entitlement is the first gate, not a detail. */
    if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_INTEGRATE')) {
      return { state: 'not_entitled' };
    }

    /* PENDING_SIGNUP and REVOKED refuse, as they do at every send door;
     * UNHEALTHY still routes, because the send IS the health check. */
    const connection = await wabaRepo.wabaConnectionFor(tx, businessId);
    if (!connection || (connection.status !== 'CONNECTED' && connection.status !== 'UNHEALTHY')) {
      return { state: 'no_connection' };
    }

    const facets = await customersRepo.identityFacetsFor(tx, businessId, customerId);
    const phoneFacet = facets.find((f) => f.facet === 'phone');
    if (!phoneFacet) return { state: 'no_phone' };
    return {
      state: 'reachable',
      phone: decryptFacet(phoneFacet.ciphertext, this.config.vaultKey, `${businessId}:phone`),
    };
  }
}
