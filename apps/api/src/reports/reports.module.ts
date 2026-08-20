import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DbModule } from '../db/db.module.js';
import { ReportsController } from './reports.controller.js';

/**
 * Flat providers rather than an AuthModule import, matching PaymentsModule:
 * there is no AuthModule to import — guards resolve in the module that
 * declares the controller using them.
 */
@Module({
  imports: [DbModule],
  controllers: [ReportsController],
  providers: [AuthService, SessionGuard],
})
export class ReportsModule {}
