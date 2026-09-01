import { Module } from '@nestjs/common';
import { AuthController, BusinessController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { SessionGuard } from './auth/session.guard.js';
import { OperatorGuard } from './auth/operator.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { OpsController } from './health/ops.controller.js';
import { MetaWebhookController } from './channels/meta.controller.js';
import { MetaIngressService } from './channels/meta.service.js';
import { SecurityMetricsModule } from './channels/security-metrics.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { BillingModule } from './billing/billing.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { RepliesModule } from './replies/replies.module.js';
import { CatalogueModule } from './catalogue/catalogue.module.js';
import { BankModule } from './bank/bank.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ShopModule } from './shop/shop.module.js';
import { RiskModule } from './risk/risk.module.js';
import { CommandsModule } from './commands/commands.module.js';
import { ApiModule } from './api/api.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

@Module({
  imports: [
    SecurityMetricsModule,
    ApiModule,
    WebhooksModule,
    BillingModule,
    CatalogueModule,
    DbModule,
    JobsModule,
    PaymentsModule,
    RepliesModule,
    ReportsModule,
    RiskModule,
    CommandsModule,
    BankModule,
    ShopModule,
  ],
  controllers: [
    AuthController,
    BusinessController,
    HealthController,
    OpsController,
    MetaWebhookController,
  ],
  providers: [AuthService, SessionGuard, RolesGuard, OperatorGuard, MetaIngressService],
})
export class AppModule {}
