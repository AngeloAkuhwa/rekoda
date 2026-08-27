/**
 * Catalogue synchronisation to the merchant's WABA (spec §3.2; W3,
 * PR-086).
 *
 * The catalogue lives in the products table and nowhere else. What Meta
 * shows the merchant's customers is a PROJECTION of it, and this service
 * is the one writer of that projection: diff the shelf against what was
 * last pushed, publish only the difference, record what the provider
 * accepted item by item. The customer's message never sets a price
 * because the price Meta renders came from THIS push, off the merchant's
 * own rows.
 *
 * §4.3's ordering holds even though no unit is metered here: entitlement
 * is checked before the provider is contacted, and a refused sync costs
 * nothing anywhere. The diff runs inside the tenant transaction; the
 * provider call runs OUTSIDE it (an HTTP round-trip holds no lock on a
 * merchant's books); the results land in a second transaction, so a crash
 * between the two re-pushes items rather than forgetting them — the diff
 * makes re-pushing idempotent.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { decryptFacet } from '@rekoda/core/vault';
import { entitlementsRepo, wabaRepo, withBusiness, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { CATALOGUE_PUBLISHER, type CataloguePublisher } from './catalogue-publisher.js';

export type CatalogueSyncOutcome =
  | { outcome: 'synced'; pushed: number; failed: number }
  | { outcome: 'nothing_to_push' }
  | { outcome: 'not_entitled' }
  | { outcome: 'no_connection' }
  /** Connected, but no commerce catalog linked: the merchant (or W0's
   * enablement) names one first. An instruction, not an error. */
  | { outcome: 'no_catalogue' }
  | { outcome: 'unavailable'; reason: 'connection_key_missing' | 'token_missing' };

@Injectable()
export class CatalogueSyncService {
  private readonly log = new Logger(CatalogueSyncService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(CATALOGUE_PUBLISHER) private readonly publisher: CataloguePublisher,
  ) {}

  async syncNow(businessId: string): Promise<CatalogueSyncOutcome> {
    if (!this.config.connectionKey) {
      return { outcome: 'unavailable', reason: 'connection_key_missing' };
    }

    /* Everything the push needs, read under the tenant pin. */
    const prepared = await withBusiness(this.db, businessId, async (tx) => {
      if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_INTEGRATE')) {
        return { refusal: { outcome: 'not_entitled' } as const };
      }
      /* UNHEALTHY still syncs, for the same reason it still sends: the
       * attempt IS the health check. PENDING_SIGNUP and REVOKED refuse. */
      const connection = await wabaRepo.wabaConnectionFor(tx, businessId);
      if (!connection || (connection.status !== 'CONNECTED' && connection.status !== 'UNHEALTHY')) {
        return { refusal: { outcome: 'no_connection' } as const };
      }
      if (!connection.catalogueId) return { refusal: { outcome: 'no_catalogue' } as const };
      const token = connection.accessTokenCipher
        ? decryptFacet(
            connection.accessTokenCipher,
            this.config.connectionKey!,
            `${businessId}:waba_token`,
          )
        : null;
      if (!token) {
        return { refusal: { outcome: 'unavailable', reason: 'token_missing' } as const };
      }
      const diff = await wabaRepo.catalogueDiffFor(tx, businessId, connection.id);
      return {
        connectionId: connection.id,
        catalogueId: connection.catalogueId,
        token,
        diff,
      };
    });
    if ('refusal' in prepared) return prepared.refusal;
    if (prepared.diff.length === 0) return { outcome: 'nothing_to_push' };

    /* The provider, outside any transaction. */
    const outcomes = await this.publisher.publish({
      accessToken: prepared.token,
      catalogueId: prepared.catalogueId,
      items: prepared.diff.map((push) => ({
        retailerId: push.retailerId,
        name: push.name,
        priceK: push.priceK,
        currency: 'NGN' as const,
        availability: push.availability,
      })),
    });
    const byRetailer = new Map(outcomes.map((o) => [o.retailerId, o]));

    /* The projection's record follows the push, item by item. */
    await withBusiness(this.db, businessId, (tx) =>
      wabaRepo.recordCatalogueSync(tx, {
        businessId,
        wabaConnectionId: prepared.connectionId,
        results: prepared.diff.map((push) => {
          const outcome = byRetailer.get(push.retailerId);
          return {
            productId: push.productId,
            retailerId: push.retailerId,
            name: push.name,
            priceK: push.priceK,
            availability: push.availability,
            ok: outcome?.ok ?? false,
            error: outcome?.ok ? null : (outcome?.error ?? 'provider returned no answer'),
          };
        }),
      }),
    );

    const failed = prepared.diff.filter((push) => !byRetailer.get(push.retailerId)?.ok).length;
    if (failed > 0) this.log.warn(`catalogue sync: ${failed} item(s) refused by the provider`);
    return { outcome: 'synced', pushed: prepared.diff.length - failed, failed };
  }
}
