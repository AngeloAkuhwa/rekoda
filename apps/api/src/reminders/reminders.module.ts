import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { WabaTemplateService } from '../channels/waba-templates.service.js';
import { DbModule } from '../db/db.module.js';
import { EmailModule } from '../email/email.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { RepliesModule } from '../replies/replies.module.js';
import { ReminderService, REMINDER_WHATSAPP } from './reminder.service.js';
import { PublicReminderOptOutController, RemindersController } from './reminders.controller.js';

/** Flat providers, as ReportsModule and BillingModule do: there is no AuthModule. */
@Module({
  imports: [DbModule, RepliesModule, EmailModule],
  controllers: [RemindersController, PublicReminderOptOutController],
  providers: [
    AuthService,
    SessionGuard,
    PrivacyGateway,
    WabaTemplateService,
    { provide: REMINDER_WHATSAPP, useExisting: WabaTemplateService },
    ReminderService,
  ],
})
export class RemindersModule {}
