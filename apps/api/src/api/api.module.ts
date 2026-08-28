import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DbModule } from '../db/db.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';
import { PublicApiExceptionFilter } from './public/public-api.filter.js';
import { PublicV1Controller } from './public/public-v1.controller.js';
import { UnsupportedVersionController } from './public/unsupported-version.controller.js';

/**
 * The developer platform's foundation (API-D, canonical spec §27).
 *
 * Two front doors in one module because they are two ends of one credential:
 * the session-authed surface that issues keys (`/v1/api-keys`), and the
 * versioned public surface those keys open (`/api/v1`). The third controller
 * is the public surface's edge — every `/api` path that is not a route this
 * version serves. `RepliesModule` is here for the message sender
 * `AuthService` needs; nothing in this module sends.
 */
@Module({
  imports: [DbModule, RepliesModule],
  controllers: [ApiKeysController, PublicV1Controller, UnsupportedVersionController],
  providers: [
    ApiKeysService,
    ApiKeyGuard,
    PublicApiExceptionFilter,
    AuthService,
    SessionGuard,
    RolesGuard,
  ],
  exports: [ApiKeysService, ApiKeyGuard],
})
export class ApiModule {}
