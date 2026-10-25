import { Module } from '@nestjs/common';
import type { Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB, DbModule } from '../db/db.module.js';
import { EMAIL_SENDER, MockEmailSender, NoEmailSender, type EmailSender } from './email.port.js';
import { ResendEmailSender } from './resend.sender.js';
import { ResendWebhookController } from './resend-webhook.controller.js';
import { SuppressingEmailSender } from './suppressing.sender.js';

/** The one place the sender is chosen, as PaymentsModule does for the payment provider. */
@Module({
  imports: [DbModule],
  controllers: [ResendWebhookController],
  providers: [
    {
      provide: EMAIL_SENDER,
      inject: [CONFIG, DB],
      useFactory: (config: ApiConfig, db: Db): EmailSender => {
        if (config.emailProvider === 'mock') return new MockEmailSender();
        if (config.emailProvider === 'resend') {
          return new SuppressingEmailSender(
            new ResendEmailSender({ apiKey: config.resendApiKey, from: config.emailFrom }),
            db,
          );
        }
        return new NoEmailSender();
      },
    },
  ],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
