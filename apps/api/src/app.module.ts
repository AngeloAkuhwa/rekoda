import { Module } from '@nestjs/common';
import { AuthController, BusinessController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { SessionGuard } from './auth/session.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { OpsController } from './health/ops.controller.js';
import { MetaWebhookController } from './channels/meta.controller.js';
import { MetaIngressService } from './channels/meta.service.js';
import { JobsModule } from './jobs/jobs.module.js';
import { BillingModule } from './billing/billing.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { RepliesModule } from './replies/replies.module.js';
import { CatalogueModule } from './catalogue/catalogue.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ShopModule } from './shop/shop.module.js';

@Module({
  imports: [
    BillingModule,
    CatalogueModule,
    DbModule,
    JobsModule,
    PaymentsModule,
    RepliesModule,
    ReportsModule,
    ShopModule,
  ],
  controllers: [
    AuthController,
    BusinessController,
    HealthController,
    OpsController,
    MetaWebhookController,
  ],
  providers: [AuthService, SessionGuard, RolesGuard, MetaIngressService],
})
export class AppModule {}
