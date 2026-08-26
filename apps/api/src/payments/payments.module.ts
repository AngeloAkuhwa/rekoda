import { Module } from '@nestjs/common';
import { CONFIG, type ApiConfig } from '../config.js';
import { DbModule } from '../db/db.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { AuthService } from '../auth/auth.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { PaystackWebhookController } from './paystack.controller.js';
import { PaystackProvider } from './paystack.provider.js';
import { PaymentIntentsService } from './payment-intents.service.js';
import { PaymentConnectionsService } from './connections.service.js';
import { PaymentsController } from './payments.controller.js';
import { PAYMENT_PROVIDER } from './provider.port.js';

/**
 * The Payment Hub's wiring (docs/payments-v1.md §0, §6).
 *
 * `PAYMENT_PROVIDER` is bound to the Paystack adapter here and ONLY here —
 * the day a second provider ships, this factory learns to choose and nothing
 * else in the application changes. The same construction as MODEL_TRANSPORT,
 * for the same reason.
 */
@Module({
  imports: [DbModule, RepliesModule, CommandsModule],
  controllers: [PaystackWebhookController, PaymentsController],
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [CONFIG],
      useFactory: (config: ApiConfig) =>
        new PaystackProvider(config.paystackSecretKey, config.paystackBaseUrl),
    },
    PaymentIntentsService,
    PaymentConnectionsService,
    // The guards resolve within the module that declares the controller.
    AuthService,
    SessionGuard,
    RolesGuard,
  ],
  exports: [PAYMENT_PROVIDER, PaymentIntentsService, PaymentConnectionsService],
})
export class PaymentsModule {}
