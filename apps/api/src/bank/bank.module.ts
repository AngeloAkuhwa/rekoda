import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { CONFIG, type ApiConfig } from '../config.js';
import { DbModule } from '../db/db.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { BankController } from './bank.controller.js';
import { BANK_FEED } from './feed.port.js';
import { MonoProvider } from './mono.provider.js';
import { CommandsModule } from '../commands/commands.module.js';

/**
 * Flat providers, matching ReportsModule: guards resolve in the module that
 * declares the controller using them. RepliesModule is not optional here even
 * though nothing on this surface sends a message: SessionGuard needs
 * AuthService, and AuthService takes the message sender.
 *
 * `BANK_FEED` is bound to the Mono adapter here and ONLY here — the day a
 * second aggregator ships (the concentration risk ADR 0012 names), this
 * factory learns to choose and nothing else changes. Same construction as
 * PAYMENT_PROVIDER. An empty key still constructs the adapter: `configured`
 * is how the controller answers honestly instead of the app refusing to boot.
 */
@Module({
  imports: [DbModule, RepliesModule, CommandsModule],
  controllers: [BankController],
  providers: [
    {
      provide: BANK_FEED,
      inject: [CONFIG],
      useFactory: (config: ApiConfig) => new MonoProvider(config.monoSecretKey, config.monoBaseUrl),
    },
    AuthService,
    SessionGuard,
  ],
  /* The background sweep runs in JobsModule but must pull through the
   * same adapter binding, not a second construction of it. */
  exports: [BANK_FEED],
})
export class BankModule {}
