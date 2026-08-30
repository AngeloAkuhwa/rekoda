import { Module } from '@nestjs/common';
import { CONFIG, type ApiConfig } from '../config.js';
import { CATALOGUE_PUBLISHER, type CataloguePublisher } from './catalogue-publisher.js';
import { MetaCataloguePublisher } from './meta-catalogue.publisher.js';
import { CatalogueSyncService } from './catalogue-sync.service.js';

/**
 * The catalogue projection, finally constructed (remediation R3b).
 *
 * `meta-catalogue.publisher.ts` says enablement "waits on W0" and should be
 * "a credential, not a code change". It was neither: no module provided
 * `CATALOGUE_PUBLISHER` and no module provided `CatalogueSyncService`, so the
 * feature was never built in production at all, and turning it on WOULD have
 * been a code change. This module is what makes that sentence true.
 *
 * The publisher is constructed unconditionally, which is safe because it
 * makes no network call until it is asked to publish, and `syncNow` refuses
 * long before that: `connection_key_missing` without a connection key,
 * `no_connection` without a live WABA, `no_catalogue` without a catalog the
 * merchant named, `not_entitled` without Integrate. So a deployment with no
 * WABA credentials runs this code and pushes nothing, exactly as before.
 */
@Module({
  providers: [
    {
      provide: CATALOGUE_PUBLISHER,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): CataloguePublisher =>
        new MetaCataloguePublisher(config.metaGraphVersion),
    },
    CatalogueSyncService,
  ],
  exports: [CatalogueSyncService],
})
export class CatalogueModule {}
