import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DbModule } from '../db/db.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { BankController } from './bank.controller.js';

/**
 * Flat providers, matching ReportsModule: guards resolve in the module that
 * declares the controller using them. RepliesModule is not optional here even
 * though nothing on this surface sends a message: SessionGuard needs
 * AuthService, and AuthService takes the message sender.
 */
@Module({
  imports: [DbModule, RepliesModule],
  controllers: [BankController],
  providers: [AuthService, SessionGuard],
})
export class BankModule {}
