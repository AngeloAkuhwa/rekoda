import { Module } from '@nestjs/common';
import { AuthController, BusinessController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { SessionGuard } from './auth/session.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [DbModule],
  controllers: [AuthController, BusinessController, HealthController],
  providers: [AuthService, SessionGuard, RolesGuard],
})
export class AppModule {}
