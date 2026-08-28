import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DbModule } from '../db/db.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';
import { PublicApiController } from './public-api.controller.js';

/**
 * The developer platform's foundation (API-D, canonical spec §27).
 *
 * Two controllers with two different front doors, in one module because they
 * are two ends of one credential: the session-authed surface that issues
 * keys, and the key-authed surface those keys open. `RepliesModule` is here
 * for the message sender `AuthService` needs; nothing in this module sends.
 */
@Module({
  imports: [DbModule, RepliesModule],
  controllers: [ApiKeysController, PublicApiController],
  providers: [ApiKeysService, ApiKeyGuard, AuthService, SessionGuard, RolesGuard],
  exports: [ApiKeysService, ApiKeyGuard],
})
export class ApiModule {}
