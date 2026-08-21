import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DbModule } from '../db/db.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

/**
 * Flat providers rather than an AuthModule import, matching ReportsModule and
 * PaymentsModule: there is no AuthModule, and guards resolve in the module
 * that declares the controller using them.
 */
@Module({
  imports: [DbModule, RepliesModule],
  controllers: [BillingController],
  providers: [AuthService, SessionGuard, BillingService],
  exports: [BillingService],
})
export class BillingModule {}
