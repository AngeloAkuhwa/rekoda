import { Module } from '@nestjs/common';
import { CONFIG, type ApiConfig } from '../config.js';
import { MetaSender, NoSenderConfigured } from '../channels/meta.sender.js';
import { MESSAGE_SENDER } from '../channels/sender.tokens.js';
import type { MessageSender } from '../channels/sender.js';
import { ReplySender } from './reply.service.js';

/**
 * Sending is optional in the same way the model is: without credentials the
 * product records everything and delivers nothing, rather than refusing to
 * start. A developer looking at a page should not need a WhatsApp Business
 * account, and an inbound message is recorded whether or not a reply leaves.
 */
@Module({
  providers: [
    {
      provide: MESSAGE_SENDER,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): MessageSender =>
        config.metaAccessToken && config.metaPhoneNumberId
          ? new MetaSender(
              config.metaAccessToken,
              config.metaPhoneNumberId,
              config.metaGraphVersion,
              undefined,
              config.metaOtpTemplate,
              config.metaOtpTemplateLocale,
            )
          : new NoSenderConfigured(),
    },
    ReplySender,
  ],
  exports: [ReplySender, MESSAGE_SENDER],
})
export class RepliesModule {}
