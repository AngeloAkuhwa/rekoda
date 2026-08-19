import { Module } from '@nestjs/common';
import { AuthController, BusinessController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { SessionGuard } from './auth/session.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { MetaWebhookController } from './channels/meta.controller.js';
import { MetaIngressService } from './channels/meta.service.js';
import { JobsModule } from './jobs/jobs.module.js';

@Module({
  imports: [DbModule, JobsModule],
  controllers: [AuthController, BusinessController, HealthController, MetaWebhookController],
  providers: [AuthService, SessionGuard, RolesGuard, MetaIngressService],
})
export class AppModule {}
