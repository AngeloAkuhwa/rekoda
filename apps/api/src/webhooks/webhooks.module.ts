import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DbModule } from '../db/db.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * The merchant's side of webhooks (PR-112).
 *
 * Only the configuration surface lives in Nest. Fan-out and delivery run on
 * the WORKER, wired in `jobs.module.ts` beside the other sweeps, because
 * neither belongs to a request: one rides the outbox dispatcher and the
 * other is a timer with its own retries.
 */
@Module({
  imports: [DbModule, RepliesModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, AuthService, SessionGuard, RolesGuard],
  exports: [WebhooksService],
})
export class WebhooksModule {}
