import { Module } from '@nestjs/common';
import { CONFIG, type ApiConfig } from '../config.js';
import { EMAIL_SENDER, MockEmailSender, NoEmailSender } from './email.port.js';

/** The one place the sender is chosen, as PaymentsModule does for the payment provider. */
@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      inject: [CONFIG],
      useFactory: (config: ApiConfig) =>
        config.emailProvider === 'mock' ? new MockEmailSender() : new NoEmailSender(),
    },
  ],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
